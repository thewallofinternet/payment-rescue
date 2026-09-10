interface Env {
  DB: D1Database;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
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
  const openAmount = await env.DB.prepare("SELECT COALESCE(SUM(amount),0) AS n FROM failed_payments WHERE recovered_at IS NULL").first<{ n: number }>();
  const rows = await env.DB.prepare(`SELECT customer_email, amount, currency, failure_code, created_at, recovered_at FROM failed_payments ORDER BY created_at DESC LIMIT 50`).all();
  return {
    failed_payments: total?.n ?? 0,
    recovered_payments: recovered?.n ?? 0,
    recovered_amount_minor: amount?.n ?? 0,
    open_amount_minor: openAmount?.n ?? 0,
    rows: rows.results ?? []
  };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" }[char] || char));
}

function recoveryHtml(invoice: any) {
  const amount = ((invoice.amount_due || 0) / 100).toFixed(2);
  const currency = (invoice.currency || "usd").toUpperCase();
  const email = invoice.customer_email || "your account";
  const payUrl = invoice.hosted_invoice_url || invoice.invoice_pdf;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Rescue</title><style>*{box-sizing:border-box}body{margin:0;background:#080a0f;color:#f5f7fb;font-family:Inter,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px}.card{width:min(460px,100%);background:#11151f;border:1px solid #252c3a;border-radius:18px;padding:34px;text-align:center;box-shadow:0 20px 60px #0006}.logo{font-size:24px;font-weight:800;margin-bottom:28px}.logo span{color:#8b7cff}.icon{width:56px;height:56px;border-radius:50%;background:#2a2415;display:grid;place-items:center;margin:0 auto 20px;font-size:25px}.eyebrow{color:#8d95a7;font-size:13px}.title{font-size:27px;font-weight:800;margin:8px 0 12px}.text{color:#aeb5c4;line-height:1.6;margin-bottom:24px}.amount{font-size:30px;font-weight:800;margin:18px 0}.btn{display:block;background:#8b7cff;color:#fff;text-decoration:none;padding:14px;border-radius:10px;font-weight:750}.small{font-size:12px;color:#737b8c;margin-top:16px}</style></head><body><div class="card"><div class="logo"><span>Payment</span> Rescue</div><div class="icon">!</div><div class="eyebrow">Payment issue</div><div class="title">Your payment needs attention</div><div class="text">We couldn't complete your latest subscription payment for <strong>${escapeHtml(email)}</strong>. Update your payment method to keep your subscription active.</div><div class="amount">${amount} ${currency}</div>${payUrl ? `<a class="btn" href="${escapeHtml(payUrl)}">Update payment method</a>` : `<div class="text">Please contact support to update your payment method.</div>`}<div class="small">Secure payment processing by Stripe.</div></div></body></html>`;
}

function dashboardHtml(data: any) {
  const currency = (value: number, code = "usd") => `${((value || 0) / 100).toFixed(2)} ${(code || "usd").toUpperCase()}`;
  const rows = data.rows.map((r: any) => `
    <tr>
      <td><div class="customer"><div class="avatar">${escapeHtml((r.customer_email || "?").charAt(0).toUpperCase())}</div><div><strong>${escapeHtml(r.customer_email || "Unknown customer")}</strong><span>Subscription payment</span></div></div></td>
      <td class="money">${currency(r.amount, r.currency)}</td>
      <td><span class="failure">${escapeHtml(r.failure_code || "Payment failed")}</span></td>
      <td>${escapeHtml(r.created_at || "—")}</td>
      <td><span class="badge ${r.recovered_at ? "good" : "open"}"><i></i>${r.recovered_at ? "Recovered" : "Needs recovery"}</span></td>
    </tr>`).join("");
  const recoveryRate = data.failed_payments ? Math.round((data.recovered_payments / data.failed_payments) * 100) : 0;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Rescue — Revenue Recovery</title>
<style>
:root{--bg:#080a0f;--panel:#0f131c;--panel2:#121722;--line:#222938;--muted:#8992a5;--text:#f6f7fb;--purple:#8b7cff;--purple2:#a69cff;--green:#69d69a;--amber:#f0c76a}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 50% -10%,#17142b 0,#080a0f 38%);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:inherit}main{max-width:1240px;margin:auto;padding:30px 28px 70px}.nav{height:58px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);margin-bottom:38px}.logo{font-size:19px;font-weight:850;letter-spacing:-.5px}.logo b{color:var(--purple)}.navright{display:flex;align-items:center;gap:12px}.live{font-size:12px;color:#8f98aa;border:1px solid var(--line);background:#0d1119;border-radius:999px;padding:7px 11px}.dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--green);margin-right:6px}.avatarSmall{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:#242033;border:1px solid #37304e;color:#c9c3ff;font-size:12px;font-weight:700}.hero{display:flex;justify-content:space-between;gap:20px;align-items:end;margin-bottom:26px}.eyebrow{font-size:12px;color:var(--purple2);font-weight:700;text-transform:uppercase;letter-spacing:1.1px}.hero h1{font-size:34px;line-height:1.1;margin:8px 0 8px;letter-spacing:-1.3px}.hero p{margin:0;color:var(--muted);font-size:14px}.refresh{border:1px solid var(--line);background:#121722;color:#fff;padding:10px 14px;border-radius:9px;text-decoration:none;font-size:13px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:22px}.stat{background:linear-gradient(145deg,#111620,#0e121a);border:1px solid var(--line);border-radius:14px;padding:19px 20px;min-height:120px}.statTop{display:flex;justify-content:space-between;align-items:center}.statLabel{color:var(--muted);font-size:12px}.statIcon{width:28px;height:28px;border-radius:8px;background:#19162b;color:var(--purple2);display:grid;place-items:center;font-size:13px}.statValue{font-size:28px;font-weight:800;letter-spacing:-.8px;margin-top:14px}.statMeta{font-size:11px;color:#697286;margin-top:5px}.statMeta.good{color:var(--green)}.section{background:rgba(15,19,28,.9);border:1px solid var(--line);border-radius:15px;overflow:hidden}.sectionHead{display:flex;justify-content:space-between;align-items:center;padding:20px 21px;border-bottom:1px solid var(--line)}.sectionTitle{font-size:15px;font-weight:750}.sectionSub{font-size:12px;color:var(--muted);margin-top:4px}.pill{font-size:11px;color:#aeb5c4;border:1px solid var(--line);border-radius:8px;padding:7px 9px;background:#0b0f16}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:14px 18px;border-bottom:1px solid #1e2430;font-size:12px}th{font-size:10px;text-transform:uppercase;letter-spacing:.7px;color:#70798c;font-weight:700;background:#0d1118}td{color:#cbd0db}tbody tr:hover{background:#111621}.customer{display:flex;align-items:center;gap:10px}.customer strong{display:block;color:#e9ebf1;font-size:12px;font-weight:650}.customer span{display:block;color:#687286;font-size:10px;margin-top:3px}.avatar{width:31px;height:31px;border-radius:9px;background:#211c39;color:#bcb5ff;display:grid;place-items:center;font-size:11px;font-weight:800}.money{font-weight:700;color:#eef0f5}.failure{color:#929bad}.badge{display:inline-flex;align-items:center;gap:6px;padding:5px 8px;border-radius:999px;font-size:10px;font-weight:700}.badge i{width:5px;height:5px;border-radius:50%;display:block}.badge.open{background:#292315;color:var(--amber)}.badge.open i{background:var(--amber)}.badge.good{background:#13251b;color:var(--green)}.badge.good i{background:var(--green)}.empty{padding:65px;text-align:center;color:var(--muted)}.bottom{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px}.mini{background:#0f131c;border:1px solid var(--line);border-radius:14px;padding:20px}.mini h3{font-size:13px;margin:0 0 6px}.mini p{font-size:12px;color:var(--muted);line-height:1.5;margin:0}.progress{height:7px;background:#1a1f2a;border-radius:99px;overflow:hidden;margin-top:15px}.progress span{display:block;height:100%;width:${recoveryRate}%;background:var(--purple);border-radius:99px}.footer{color:#555e70;font-size:10px;text-align:center;margin-top:30px}@media(max-width:900px){.stats{grid-template-columns:repeat(2,1fr)}.bottom{grid-template-columns:1fr}th:nth-child(3),td:nth-child(3){display:none}}@media(max-width:600px){main{padding:20px 14px}.nav{margin-bottom:25px}.hero h1{font-size:28px}.stats{grid-template-columns:1fr}.hero{align-items:start;flex-direction:column}table{min-width:720px}.section{overflow-x:auto}.sectionHead{min-width:720px}}
</style></head><body><main>
<div class="nav"><div class="logo"><b>Payment</b> Rescue</div><div class="navright"><div class="live"><span class="dot"></span>Stripe connected</div><div class="avatarSmall">PR</div></div></div>
<div class="hero"><div><div class="eyebrow">Revenue recovery</div><h1>Stop failed payments from becoming churn.</h1><p>Monitor failed subscription payments and recover revenue before customers disappear.</p></div><a class="refresh" href="/dashboard">↻ &nbsp; Refresh data</a></div>
<div class="stats">
<div class="stat"><div class="statTop"><div class="statLabel">Failed payments</div><div class="statIcon">!</div></div><div class="statValue">${data.failed_payments}</div><div class="statMeta">Payments needing attention</div></div>
<div class="stat"><div class="statTop"><div class="statLabel">At-risk revenue</div><div class="statIcon">$</div></div><div class="statValue">${currency(data.open_amount_minor)}</div><div class="statMeta">Currently unresolved</div></div>
<div class="stat"><div class="statTop"><div class="statLabel">Recovered</div><div class="statIcon">✓</div></div><div class="statValue">${data.recovered_payments}</div><div class="statMeta good">Successful recoveries</div></div>
<div class="stat"><div class="statTop"><div class="statLabel">Recovered revenue</div><div class="statIcon">↗</div></div><div class="statValue">${currency(data.recovered_amount_minor)}</div><div class="statMeta">Revenue saved</div></div>
</div>
<div class="section"><div class="sectionHead"><div><div class="sectionTitle">Payment activity</div><div class="sectionSub">Recent subscription payments requiring attention</div></div><div class="pill">Last 50 events</div></div>
<table><thead><tr><th>Customer</th><th>Amount</th><th>Failure</th><th>Received</th><th>Status</th></tr></thead><tbody>${rows || `<tr><td colspan="5"><div class="empty">No failed payments yet.<br><span>Once Stripe reports a failed subscription payment, it will appear here.</span></div></td></tr>`}</tbody></table></div>
<div class="bottom"><div class="mini"><h3>Recovery rate</h3><p>${recoveryRate}% of failed payments have been recovered.</p><div class="progress"><span></span></div></div><div class="mini"><h3>Automation status</h3><p>Stripe webhook connection is active. Recovery messaging can be enabled next.</p></div></div>
<div class="footer">Payment Rescue · Revenue recovery for subscription businesses</div>
</main></body></html>`;
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
        let customerEmail: string | null = null;
        if (customerId) {
          const customerResponse = await stripe(`customers/${customerId}`, env);
          if (customerResponse.ok) customerEmail = ((await customerResponse.json()) as any).email ?? null;
        }
        await env.DB.prepare(`INSERT OR IGNORE INTO failed_payments (stripe_event_id, customer_id, customer_email, invoice_id, amount, currency, failure_code) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(event.id, customerId ?? null, customerEmail, invoice?.id ?? null, invoice?.amount_due ?? 0, invoice?.currency ?? null, invoice?.last_finalization_error?.code ?? invoice?.payment_intent?.last_payment_error?.code ?? null).run();
        return json({ received: true, handled: "invoice.payment_failed" });
      }
      return json({ received: true });
    }
    return json({ error: "Not found" }, 404);
  }
};
