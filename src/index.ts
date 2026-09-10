interface Env {
  DB: D1Database;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });

async function stripe(path: string, env: Env, init: RequestInit = {}) {
  return fetch(`https://api.stripe.com/v1/${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(init.headers || {})
    }
  });
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
  return result === 0;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return new Uint8Array();
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function verifyStripeSignature(body: string, signature: string, secret: string): Promise<boolean> {
  const parts = signature.split(",");
  const timestampPart = parts.find((p) => p.startsWith("t="));
  const signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!timestampPart || signatures.length === 0) return false;

  const timestamp = Number(timestampPart.slice(2));
  if (!Number.isFinite(timestamp)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signedPayload = `${timestamp}.${body}`;
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expected = new Uint8Array(digest);

  return signatures.some((sig) => timingSafeEqual(expected, hexToBytes(sig)));
}

async function dashboard(env: Env) {
  const total = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM failed_payments"
  ).first<{ n: number }>();

  const recovered = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM failed_payments WHERE recovered_at IS NOT NULL"
  ).first<{ n: number }>();

  const amount = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount),0) AS n FROM failed_payments WHERE recovered_at IS NOT NULL"
  ).first<{ n: number }>();

  return json({
    failed_payments: total?.n ?? 0,
    recovered_payments: recovered?.n ?? 0,
    recovered_amount_minor: amount?.n ?? 0
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(
        "<h1>Payment Rescue</h1><p>MVP backend is running.</p>",
        { headers: { "content-type": "text/html" } }
      );
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/dashboard") {
      return dashboard(env);
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const signature = request.headers.get("Stripe-Signature");
      if (!signature) return json({ error: "Missing Stripe-Signature" }, 400);

      const body = await request.text();
      const valid = await verifyStripeSignature(body, signature, env.STRIPE_WEBHOOK_SECRET);
      if (!valid) return json({ error: "Invalid webhook signature" }, 400);

      let event: any;
      try {
        event = JSON.parse(body);
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }

      if (event?.type === "invoice.payment_failed") {
        const invoice = event.data?.object;
        const customerId = invoice?.customer;
        let customerEmail: string | null = null;

        if (customerId) {
          const customerResponse = await stripe(`customers/${customerId}`, env);
          if (customerResponse.ok) {
            const customer = await customerResponse.json() as any;
            customerEmail = customer.email ?? null;
          }
        }

        await env.DB.prepare(`
          INSERT OR IGNORE INTO failed_payments
          (stripe_event_id, customer_id, customer_email, invoice_id, amount, currency, failure_code)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          event.id,
          customerId ?? null,
          customerEmail,
          invoice?.id ?? null,
          invoice?.amount_due ?? 0,
          invoice?.currency ?? null,
          invoice?.last_finalization_error?.code ?? invoice?.payment_intent?.last_payment_error?.code ?? null
        ).run();

        return json({ received: true, handled: "invoice.payment_failed" });
      }

      return json({ received: true });
    }

    return json({ error: "Not found" }, 404);
  }
};
