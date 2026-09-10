interface Env {
  DB: D1Database;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  RESEND_API_KEY: string;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json" }
});

async function stripe(path: string, env: Env, init: RequestInit = {}) {
  return fetch(`https://api.stripe.com/v1/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(init.headers || {})
    }
  });
}

async function sendRecoveryEmail(env: Env, to: string, invoice: any, origin: string) {
  const amount = ((invoice.amount_due || 0) / 100).toFixed(2);
  const currency = (invoice.currency || "usd").toUpperCase();
  const recoveryUrl = `${origin}/recover?invoice=${encodeURIComponent(invoice.id)}`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: "Payment Rescue <onboarding@resend.dev>",
      to: [to],
      subject: "Action needed: update your payment method",
      html: `<!doctype html><html><body style="margin:0;background:#f5f7fb;font-family:Arial,sans-serif;color:#172033;padding:32px"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:32px"><h2 style="margin-top:0">Payment Rescue</h2><p>We couldn't complete your latest subscription payment.</p><p><strong>${amount} ${currency}</strong> needs your attention to keep your subscription active.</p><p style="margin:28px 0"><a href="${recoveryUrl}" style="display:inline-block;background:#6d5dfc;color:#fff;text-decoration:none;padding:13px 20px;border-radius:9px;font-weight:700">Update payment method</a></p><p style="color:#667085;font-size:13px">You'll be taken to a secure Stripe payment page.</p></div></body></html>`
    })
  });
  return response.ok;
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
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
  const expected = new Uint8Array(digest);
  return signatures.some((sig) => timingSafeEqual(expected, hexToBytes(sig)));
}

async function dashboardData(env: Env) {
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM failed_payments").first<{ n: number }>();
  const recovered = await env.DB.prepare("SELECT COUNT(*) AS n FROM failed_payments WHERE recovered_at IS NOT NULL").first<{ n: number }>();
  const amount = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM failed_payments WHERE recovered_at IS NOT NULL").first<{ n: number }>();
  const rows = await env.DB.prepare(`SELECT customer_email, amount, currency, failure_code, created_at, recovered_at FROM failed_payments ORDER BY created_at DESC LIMIT 50`).all();
  return { failed_payments: total?.n ?? 0, recovered_payments: recovered?.n ?? 0, recovered_amount_minor: amount?.n ?? 0, rows: rows.results ?? [] };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" }[char] || char));
}

function recoveryHtml(invoice: any) {
  const amount = ((invoice.amount_due || 0) / 100).toFixed(2);
  const currency = (invoice.currency || "usd").toUpperCase();
  const email = invoice.customer_email || "your account";
  const payUrl = invoice.hosted_invoice_url || invoice.invoice_pdf;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Rescue</title><style>*{box-sizing:border-box}body{margin:0;background:#0b0d12;color:#f5f7fb;font-family:Inter,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px}.card{width:min(460px,100%);background:#121620;border:1px solid #282e3d;border-radius:18px;padding:34px;text-align:center;box-shadow:0 20px 60px #0006}.logo{font-size:24px;font-weight:800;margin-bottom:28px}.logo span{color:#8b7cff}.icon{width:56px;height:56px;border-radius:50%;background:#2a2415;display:grid;place-items:center;margin:0 auto 20px;font-size:25px}.eyebrow{color:#8d95a7;font-size:13px}.title{font-size:27px;font-weight:800;margin:8px 0 12px}.text{color:#aeb5c4;line-height:1.6;margin-bottom:24px}.amount{font-size:30px;font-weight:800;margin:18px 0}.btn{display:block;background:#8b7cff;color:#fff;text-decoration:none;padding:14px;border-radius:10px;font-weight:750}.small{font-size:12px;color:#737b8c;margin-top:16px}</style></head><body><div class="card"><div class="logo"><span>Payment</span> Rescue</div><div class="icon">!</div><div class="eyebrow">Payment issue</div><div class="title">Your payment needs attention</div><div class="text">We couldn't complete your latest subscription payment for <strong>${escapeHtml(email)}</strong>. Update your payment method to keep your subscription active.</div><div class="amount">${amount} ${currency}</div>${payUrl ? `<a class="btn" href="${escapeHtml(payUrl)}">Update payment method</a>` : `<div class="text">Please contact support to update your payment method.</div>`}<div class="small">Secure payment processing by Stripe.</div></div></body></html>`;
}

function dashboardHtml(data: any) {
  const currency = (value: number, code: string | null) => `${((value || 0) / 100).toFixed(2)} ${(code || "usd").toUpperCase()}`;
  const atRisk = data.rows.filter((r: any) => !r.recovered_at).reduce((sum: number, r: any) => sum + (r.amount || 0), 0);
  const recoveryRate = data.failed_payments ? Math.round((data.recovered_payments / data.failed_payments) * 100) : 0;
  const rows = data.rows.map((r: any) => `<tr><td>${escapeHtml(r.customer_email || "Unknown customer")}</td><td>${currency(r.amount, r.currency)}</td><td>${escapeHtml(r.failure_code || "—")}</td><td>${escapeHtml(r.created_at || "")}</td><td><span class="badge ${r.recovered_at ? "good" : "open"}">${r.recovered_at ? "Recovered" : "Needs recovery"}</span></td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Rescue</title><style>*{box-sizing:border-box}body{margin:0;background:#080a0f;color:#f5f7fb;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:1120px;margin:0 auto;padding:42px 24px}.top{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #242a38;padding-bottom:22px;margin-bottom:36px}.brand{font-size:22px;font-weight:800}.brand span{color:#8b7cff}.sub{color:#8d95a7;font-size:13px;margin-top:6px}.connected{border:1px solid #2b3040;border-radius:999px;padding:8px 12px;font-size:12px;color:#9ee6b8}.hero{display:flex;justify-content:space-between;align-items:end;margin-bottom:24px}.eyebrow{color:#8b7cff;font-size:12px;font-weight:800;letter-spacing:.12em}.headline{font-size:34px;font-weight:850;margin:8px 0}.hero p{color:#8d95a7;margin:0}.btn{border:1px solid #2b3040;background:#141823;color:#fff;padding:10px 14px;border-radius:9px;text-decoration:none;font-size:13px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:22px}.card{background:#10141d;border:1px solid #242a38;border-radius:14px;padding:20px}.label{color:#8d95a7;font-size:12px}.value{font-size:27px;font-weight:800;margin-top:10px}.note{color:#727b8e;font-size:11px;margin-top:7px}.green{color:#78d69b}.tablecard{background:#10141d;border:1px solid #242a38;border-radius:14px;overflow:hidden;margin-bottom:18px}.section{display:flex;justify-content:space-between;padding:18px 20px;border-bottom:1px solid #242a38}.section h3{margin:0;font-size:15px}.section span{color:#727b8e;font-size:11px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:14px 18px;border-bottom:1px solid #242a38;font-size:12px}th{color:#727b8e;font-weight:600}td{color:#e9ecf3}.badge{display:inline-block;padding:5px 8px;border-radius:999px;font-size:10px;font-weight:700}.open{background:#2a2415;color:#f5c86a}.good{background:#14271d;color:#78d69b}.bottom{display:grid;grid-template-columns:1fr 1fr;gap:14px}.progress{height:7px;background:#1b2130;border-radius:99px;margin-top:14px;overflow:hidden}.bar{height:100%;background:#8b7cff;width:${recoveryRate}%}.empty{padding:50px;text-align:center;color:#8d95a7}@media(max-width:900px){.grid{grid-template-columns:repeat(2,1fr)}.bottom{grid-template-columns:1fr}.headline{font-size:27px}}@media(max-width:600px){.grid{grid-template-columns:1fr}.hero{display:block}.hero .btn{display:inline-block;margin-top:18px}th:nth-child(3),td:nth-child(3),th:nth-child(4),td:nth-child(4){display:none}}</style></head><body><main><div class="top"><div><div class="brand"><span>Payment</span> Rescue</div><div class="sub">Revenue recovery for subscription businesses</div></div><div class="connected">● Stripe connected</div></div><div class="hero"><div><div class="eyebrow">REVENUE RECOVERY</div><div class="headline">Stop failed payments from becoming churn.</div><p>Monitor failed subscription payments and recover revenue before customers disappear.</p></div><a class="btn" href="/dashboard">↻ Refresh data</a></div><div class="grid"><div class="card"><div class="label">Failed payments</div><div class="value">${data.failed_payments}</div><div class="note">Payments needing attention</div></div><div class="card"><div class="label">At-risk revenue</div><div class="value">${currency(atRisk,"usd")}</div><div class="note">Currently unresolved</div></div><div class="card"><div class="label">Recovered</div><div class="value">${data.recovered_payments}</div><div class="note green">Successful recoveries</div></div><div class="card"><div class="label">Recovered revenue</div><div class="value">${currency(data.recovered_amount_minor,"usd")}</div><div class="note">Revenue saved</div></div></div><div class="tablecard"><div class="section"><h3>Payment activity</h3><span>Last 50 events</span></div><table><thead><tr><th>Customer</th><th>Amount</th><th>Failure</th><th>Received</th><th>Status</th></tr></thead><tbody>${rows || `<tr><td colspan="5"><div class="empty">No failed payments yet.<br><small>Once Stripe reports a failed subscription payment, it will appear here.</small></div></td></tr>`}</tbody></table></div><div class="bottom"><div class="card"><div class="label">Recovery rate</div><div class="value">${recoveryRate}%</div><div class="note">of failed payments have been recovered.</div><div class="progress"><div class="bar"></div></div></div><div class="card"><div class="label">Automation status</div><div class="value" style="font-size:18px">Webhook connection active</div><div class="note">Recovery messaging is enabled for new failures.</div></div></div></main></body></html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response("<h1>Payment Rescue</h1><p>MVP backend is running.</p>", { headers: { "content-type": "text/html" } });
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
    if (request.method === "GET" && url.pathname === "/dashboard") return new Response(dashboardHtml(await dashboardData(env)), { headers: { "content-type": "text/html; charset=utf-8" } });
    if (request.method === "GET" && url.pathname === "/api/dashboard") return json(await dashboardData(env));
    if (request.method === "GET" && url.pathname === "/recover") {
      const invoiceId = url.searchParams.get("invoice");
      if (!invoiceId) return new Response("Missing invoice", { status: 400 });
      const response = await stripe(`invoices/${encodeURIComponent(invoiceId)}`, env);
      if (!response.ok) return new Response("Payment link expired or unavailable.", { status: 404 });
      return new Response(recoveryHtml(await response.json()), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (request.method === "POST" && url.pathname === "/webhook") {
      const signature = request.headers.get("Stripe-Signature");
      if (!signature) return json({ error: "Missing Stripe-Signature" }, 400);
      const body = await request.text();
      if (!(await verifyStripeSignature(body, signature, env.STRIPE_WEBHOOK_SECRET))) return json({ error: "Invalid webhook signature" }, 400);
      let event: any;
      try { event = JSON.parse(body); } catch { return json({ error: "Invalid JSON" }, 400); }
      if (event?.type === "invoice.payment_failed") {
        const invoice = event.data?.object;
        const customerId = invoice?.customer;
        let customerEmail: string | null = invoice?.customer_email ?? null;
        if (!customerEmail && customerId) {
          const customerResponse = await stripe(`customers/${customerId}`, env);
          if (customerResponse.ok) customerEmail = ((await customerResponse.json()) as any).email ?? null;
        }
        const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO failed_payments (stripe_event_id, customer_id, customer_email, invoice_id, amount, currency, failure_code) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(event.id, customerId ?? null, customerEmail, invoice?.id ?? null, invoice?.amount_due ?? 0, invoice?.currency ?? null, invoice?.last_finalization_error?.code ?? invoice?.payment_intent?.last_payment_error?.code ?? null).run();
        if (inserted.meta?.changes === 1 && customerEmail && env.RESEND_API_KEY) {
          await sendRecoveryEmail(env, customerEmail, invoice, url.origin);
        }
        return json({ received: true, handled: "invoice.payment_failed", email_sent: Boolean(inserted.meta?.changes === 1 && customerEmail && env.RESEND_API_KEY) });
      }
      return json({ received: true });
    }
    return json({ error: "Not found" }, 404);
  }
};
