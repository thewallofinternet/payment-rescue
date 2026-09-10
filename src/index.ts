interface Env {
  DB: D1Database;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
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

async function sendRecoveryEmail(env: Env, email: string, invoice: any) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL || !email) return { sent: false, reason: "email_not_configured" };

  const paymentUrl = invoice?.hosted_invoice_url || invoice?.invoice_pdf || "https://billing.stripe.com/";
  const amount = ((invoice?.amount_due || 0) / 100).toFixed(2);
  const currency = String(invoice?.currency || "usd").toUpperCase();

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [email],
      subject: "Action needed: your payment could not be processed",
      html: `<!doctype html><html><body style="margin:0;background:#f5f7fb;font-family:Arial,sans-serif;color:#172033;padding:40px 16px"><div style="max-width:560px;margin:auto;background:#fff;border-radius:14px;padding:36px;box-shadow:0 4px 20px rgba(0,0,0,.06)"><h1 style="margin:0 0 14px;font-size:25px">Payment needs your attention</h1><p style="font-size:16px;line-height:1.6">We couldn't process your latest subscription payment of <strong>${amount} ${currency}</strong>.</p><p style="font-size:16px;line-height:1.6">Please update your payment method to keep your subscription active.</p><p style="margin:28px 0"><a href="${paymentUrl}" style="display:inline-block;background:#635bff;color:#fff;text-decoration:none;padding:13px 20px;border-radius:8px;font-weight:700">Update payment method</a></p><p style="font-size:13px;color:#697386">If you have already updated your payment method, you can ignore this message.</p></div></body></html>`
    })
  });

  return { sent: response.ok, status: response.status };
}

async function dashboardData(env: Env) {
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM failed_payments").first<{ n: number }>();
  const recovered = await env.DB.prepare("SELECT COUNT(*) AS n FROM failed_payments WHERE recovered_at IS NOT NULL").first<{ n: number }>();
  const amount = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM failed_payments WHERE recovered_at IS NOT NULL").first<{ n: number }>();
  const rows = await env.DB.prepare(`SELECT customer_email, amount, currency, failure_code, created_at, recovered_at FROM failed_payments ORDER BY created_at DESC LIMIT 50`).all();
  return { failed_payments: total?.n ?? 0, recovered_payments: recovered?.n ?? 0, recovered_amount_minor: amount?.n ?? 0, rows: rows.results ?? [] };
}

function dashboardHtml(data: any) {
  const currency = (value: number, code: string | null) => `${((value || 0) / 100).toFixed(2)} ${(code || "usd").toUpperCase()}`;
  const rows = data.rows.map((r: any) => `<tr><td>${escapeHtml(r.customer_email || "Unknown customer")}</td><td>${currency(r.amount, r.currency)}</td><td>${escapeHtml(r.failure_code || "—")}</td><td>${escapeHtml(r.created_at || "")}</td><td><span class="badge ${r.recovered_at ? "good" : "open"}">${r.recovered_at ? "Recovered" : "Needs recovery"}</span></td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Rescue</title><style>*{box-sizing:border-box}body{margin:0;background:#0b0d12;color:#f5f7fb;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1180px;margin:0 auto;padding:42px 24px}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:34px}.brand{font-size:24px;font-weight:800;letter-spacing:-.5px}.brand span{color:#8b7cff}.sub{color:#8d95a7;font-size:14px;margin-top:5px}.btn{border:1px solid #2b3040;background:#151924;color:#fff;padding:10px 14px;border-radius:9px;text-decoration:none;font-size:14px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:28px}.card{background:#121620;border:1px solid #242a38;border-radius:14px;padding:22px}.label{color:#8d95a7;font-size:13px}.value{font-size:32px;font-weight:750;margin-top:8px}.tablecard{background:#121620;border:1px solid #242a38;border-radius:14px;overflow:hidden}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:15px 18px;border-bottom:1px solid #242a38;font-size:13px}th{color:#8d95a7;font-weight:600;background:#10131b}td{color:#e9ecf3}.badge{display:inline-block;padding:5px 8px;border-radius:999px;font-size:11px;font-weight:700}.open{background:#2a2415;color:#f5c86a}.good{background:#14271d;color:#78d69b}.empty{padding:50px;text-align:center;color:#8d95a7}@media(max-width:800px){.grid{grid-template-columns:1fr}table{font-size:12px}th:nth-child(3),td:nth-child(3),th:nth-child(4),td:nth-child(4){display:none}}</style></head><body><main><div class="top"><div><div class="brand"><span>Payment</span> Rescue</div><div class="sub">Recover failed subscription payments before they become churn.</div></div><a class="btn" href="/dashboard">Refresh</a></div><div class="grid"><div class="card"><div class="label">Failed payments</div><div class="value">${data.failed_payments}</div></div><div class="card"><div class="label">Recovered payments</div><div class="value">${data.recovered_payments}</div></div><div class="card"><div class="label">Recovered revenue</div><div class="value">${currency(data.recovered_amount_minor,"usd")}</div></div></div><div class="tablecard"><table><thead><tr><th>Customer</th><th>Amount</th><th>Failure</th><th>Received</th><th>Status</th></tr></thead><tbody>${rows || `<tr><td colspan="5"><div class="empty">No failed payments yet.</div></td></tr>`}</tbody></table></div></main></body></html>`;
}

function escapeHtml(value: string) { return value.replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[char] || char)); }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response("<h1>Payment Rescue</h1><p>MVP backend is running.</p>",{headers:{"content-type":"text/html"}});
    if (request.method === "GET" && url.pathname === "/health") return json({ok:true});
    if (request.method === "GET" && url.pathname === "/dashboard") return new Response(dashboardHtml(await dashboardData(env)),{headers:{"content-type":"text/html; charset=utf-8"}});
    if (request.method === "GET" && url.pathname === "/api/dashboard") return json(await dashboardData(env));

    if (request.method === "POST" && url.pathname === "/webhook") {
      const signature = request.headers.get("Stripe-Signature");
      if (!signature) return json({error:"Missing Stripe-Signature"},400);
      const body = await request.text();
      if (!(await verifyStripeSignature(body,signature,env.STRIPE_WEBHOOK_SECRET))) return json({error:"Invalid webhook signature"},400);
      let event: any;
      try { event = JSON.parse(body); } catch { return json({error:"Invalid JSON"},400); }

      if (event?.type === "invoice.payment_failed") {
        const invoice = event.data?.object;
        const customerId = invoice?.customer;
        let customerEmail: string | null = null;
        if (customerId) {
          const customerResponse = await stripe(`customers/${customerId}`,env);
          if (customerResponse.ok) { const customer = await customerResponse.json() as any; customerEmail = customer.email ?? null; }
        }

        await env.DB.prepare(`INSERT OR IGNORE INTO failed_payments (stripe_event_id,customer_id,customer_email,invoice_id,amount,currency,failure_code) VALUES (?,?,?,?,?,?,?)`).bind(event.id,customerId ?? null,customerEmail,invoice?.id ?? null,invoice?.amount_due ?? 0,invoice?.currency ?? null,invoice?.last_finalization_error?.code ?? invoice?.payment_intent?.last_payment_error?.code ?? null).run();

        const email = await sendRecoveryEmail(env,customerEmail || "",invoice);
        return json({received:true,handled:"invoice.payment_failed",recovery_email:email});
      }
      return json({received:true});
    }
    return json({error:"Not found"},404);
  }
};