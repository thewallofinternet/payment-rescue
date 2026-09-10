# Payment Rescue MVP

A Cloudflare Worker + D1 starter for a Stripe failed-payment recovery service.

## What this version does

- Receives Stripe `invoice.payment_failed` webhook events.
- Looks up the affected customer.
- Stores failed-payment records in D1.
- Exposes a minimal dashboard API.
- Keeps Stripe credentials in Cloudflare Worker secrets.

## Deploy

1. Create a Cloudflare D1 database named `payment-rescue-db`.
2. Put its ID in `wrangler.jsonc`.
3. Run:
   `npm install`
   `npm run db:migrate`
   `npx wrangler secret put STRIPE_SECRET_KEY`
   `npx wrangler secret put STRIPE_WEBHOOK_SECRET`
   `npm run deploy`
4. Configure the Stripe webhook endpoint:
   `https://YOUR-WORKER.workers.dev/webhook`

## Next production step

Stripe webhook signature verification must be added before processing live events. After that, add Connect onboarding and the recovery-email provider.
