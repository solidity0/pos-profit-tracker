# Ledger's email service

A small Cloudflare Worker that sends Ledger's password reset and "confirm your email" emails
through Brevo. Firebase still creates the one-time codes, but the emails and links are Ledger's.
If this service is down or Brevo refuses an email, the app falls back to Firebase's own email.

Tests: `tests/run.sh email` (runs `worker.js` against the Auth emulator).

## Deploying

From this folder:

1. `npx wrangler@4 login`
2. `npx wrangler@4 deploy`. If the URL it prints changes, update `EMAIL_SERVICE` in `../app.js`.
3. Add the two keys. They are stored by Cloudflare and never go in this repo:
   - `npx wrangler@4 secret put BREVO_API_KEY` and paste a Brevo API key (Brevo → SMTP & API →
     API keys; it isn't the same as an SMTP key).
   - `npx wrangler@4 secret put SERVICE_ACCOUNT_JSON < path/to/key.json`, using a key from
     Firebase → Project settings → Service accounts → Generate new private key. Delete the
     downloaded file afterwards.

If Brevo blocks the Worker's address, turn off blocking of unknown IP addresses for API keys in
Brevo → Security → Authorized IPs, because Cloudflare doesn't send from one fixed address.

The sender in `wrangler.toml` must be a verified Brevo sender.
