interface Env {
  DB: D1Database;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {"content-type": "application/json"}
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

async function dashboard(env: Env) {
  const total = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM failed_payments"
  ).first<{n:number}>();

  const recovered = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM failed_payments WHERE recovered_at IS NOT NULL"
  ).first<{n:number}>();

  const amount = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount),0) AS n FROM failed_payments WHERE recovered_at IS NOT NULL"
  ).first<{n:number}>();

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
        {headers: {"content-type": "text/html"}}
      );
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ok: true});
    }

    if (request.method === "GET" && url.pathname === "/dashboard") {
      return dashboard(env);
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      // IMPORTANT: production must verify Stripe-Signature before processing.
      // The signing secret is intentionally kept server-side.
      const event = await request.json() as any;

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

        return json({received: true, handled: "invoice.payment_failed"});
      }

      return json({received: true});
    }

    return json({error: "Not found"}, 404);
  }
};
