# Go live: RF Safe phone agent

The service at `https://rfsafe-phone-agent.onrender.com` stays in **demo** until the steps below are done. Demo answers with EXAMPLE tenants and does not call Twilio or xAI. Nothing in this repository buys a number or places an API call. `scripts/provision-number.js` is dry-run unless you pass `--apply`, and the server never starts it.

Business: Quanta X Technology. The agent answers RF Safe support, texts purchase and product links only, and never takes payment. The later public name is callbots.org. Other businesses use the same server (number, Shopify, website, knowledge base).

## Env vars

Set these in the Render dashboard. Generate each random value with `openssl rand -base64 32`. Do not put them in git.

| Name | When | What |
|---|---|---|
| `PA_MODE` | last | Leave `demo` until step 8. Then set `live`. |
| `NODE_VERSION` | already | `22` |
| `DATA_DIR` | already | `/var/data` (the disk) |
| `TENANTS_DIR` | already | `/var/data/tenants` |
| `PUBLIC_BASE_URL` | before live | `https://rfsafe-phone-agent.onrender.com` with no trailing slash |
| `PA_ADMIN_TOKEN` | before `/admin` | random. Bearer token for `GET /admin` |
| `PA_STATE_SECRET` | before live | random. Signs connect-state cookies |
| `PA_MASTER_KEY` | before live | random, and it must decode to exactly 32 bytes |
| `XAI_API_KEY` | before live | xAI console key. Billing must be on |
| `XAI_TEXT_MODEL` | optional | `grok-4.7` is the default for SMS replies |
| `TWILIO_ACCOUNT_SID` | before the script | Twilio account SID |
| `RFSAFE_TWILIO_AUTH_TOKEN` | before live | Twilio auth token. The tenant file references this name |
| `RFSAFE_PHONE_NUMBER` | after purchase | the new number in E.164, such as `+1` and ten digits |
| `RFSAFE_XAI_WEBHOOK_SECRET` | after `--apply` | returned once by xAI. Not shown again |
| `RFSAFE_SHOPIFY_STOREFRONT_TOKEN` | optional | public product JSON works with no token |

`GET /health` is public and only reports that the process is up. `GET /admin` with `Authorization: Bearer` plus the admin token is the readiness checklist. It says which of the rows above are missing. It does not print secret values. On a public host the built-in demo token is rejected, so set `PA_ADMIN_TOKEN` while mode is still demo, redeploy, then open `/admin`.

## Steps

1. **Confirm demo.** `GET /health` returns `"ok": true` and `"mode": "demo"`. `/` is the public CallBots page. Logs must not show raw phone numbers or secret values.
2. **Set the random secrets and `PUBLIC_BASE_URL`.** Leave `PA_MODE` as `demo`. Redeploy. Open `/admin` and read the checklist.
3. **Buy one Twilio local number** for Quanta X Technology / RF Safe. Do not reuse a personal number. Cost is about $1.15 per month.
4. **Dry-run the trunk script** from a machine that has the env vars, not from the web process:
   ```bash
   node scripts/provision-number.js
   ```
   Read the printed plan. It should show an Elastic SIP trunk, origination `sip:+1NUMBER@sip.voice.x.ai;transport=tls`, call transfer enabled, disaster recovery `POST /twilio/voice`, SMS `POST /twilio/sms`, and status `POST /twilio/sms/status`, then xAI `POST /v2/phone-numbers` with `origin: byo_trunk`.
5. **Apply once**, when the plan looks right:
   ```bash
   node scripts/provision-number.js --apply
   ```
   Copy the signing secret into `RFSAFE_XAI_WEBHOOK_SECRET` immediately. The script prints it and does not write it to disk.
6. **Replace the EXAMPLE tenant.** On the disk, edit `/var/data/tenants/rfsafe-demo.json` or add `rfsafe.json` from `deploy/rfsafe.tenant.json` with the real E.164 number, the Quanta X Technology staff transfer number (`tel:+1...`), business hours, and `owner_email`. Keep `sms_enabled` false. Keep `order_lookup_enabled` false. Secret fields stay references (`env:RFSAFE_XAI_WEBHOOK_SECRET`, `env:RFSAFE_TWILIO_AUTH_TOKEN`), never raw values. Remove or stop using the EXAMPLE demo tenant before live traffic so 555 numbers are not what xAI routes.
7. **A2P 10DLC, before any texting.** US long-code SMS to customers requires a registered brand and campaign. Use Low Volume Standard if there is an EIN, or Sole Proprietor if there is not. Budget about $19 up front and a few dollars a month, and about a week for approval. Until Twilio shows the campaign as approved, leave `sms_enabled` false. The voice agent will say texting is not on yet and will offer the link out loud or take a message. Inbound STOP, HELP, and START are already handled for the day texting is turned on. There is no payment language in those replies.
8. **E911.** Emergency calling on a Twilio number is optional and about $0.75 per month. This agent does not place emergency calls and does not advertise that it can. If the number can dial out at all, turn on E911 in the Twilio console and register a real service address for Quanta X Technology. That is separate from this server.
9. **Flip to live.** Set `PA_MODE` to `live` and redeploy. If a required variable or the disk is missing, the process exits before it listens and the log names each gap. `GET /health` should return `"mode": "live"`. `/admin` should show `ready_for_live: true` except the optional Shopify token and A2P, which stay false until texting is approved.
10. **Place one test call** from John's phone. The first thing spoken is the AI and recording disclosure. Ask a SAR question, ask for a QuantaCase link, and ask for a person during business hours. After hours, the agent must refuse the transfer and take a message. A failed SIP leg hits `/twilio/voice` and records a voicemail. Confirm logs contain `xai.webhook_verified` and `call.ended` and do not contain the caller's full number.

## Link texting rules (already enforced)

`send_link_sms` sends one https link on `quantacase.com` or `rfsafe.org` (or a subdomain), plus a short note. Three texts per call, five per caller per hour, ten per caller per day. Card numbers and payment wording are refused. STOP blocks further texts until START.

## callbots.org later

When the name is ready, add the domain in Render and point DNS at `rfsafe-phone-agent.onrender.com`. Change `PUBLIC_BASE_URL` to `https://callbots.org` with no trailing slash, then run the provision script again so Twilio and xAI get the new webhook URLs. Do that only after the certificate is active.

## If a live call misbehaves

- Render: roll back to the previous deploy. Demo mode is the safe default.
- Twilio: clear the trunk origination URI, or set the number to forward to Quanta X Technology staff. Calls stop reaching the AI.
- xAI: delete the phone-number registration. Suspend the Render service to stop all traffic.
- Disk files (`/var/data/consent.jsonl`, `secrets.enc.json`, `calls.jsonl`, `owner-outbox.jsonl`) survive a rollback. `owner-outbox.jsonl` is the only place a callback number is stored, mode 0600, so Quanta X Technology staff can return a voicemail. It is not written to the log stream.

## Shopify order lookup (QuantaCase)
- Dev Dashboard app "CallBots" on rf-safe-quantacase.myshopify.com, scopes read_orders, read_customers, read_products, read_fulfillments.
- Render env: `SHOPIFY_ADMIN_SHOP`, `SHOPIFY_ADMIN_CLIENT_ID`, `SHOPIFY_ADMIN_CLIENT_SECRET`. The server mints an Admin token with the
  client_credentials grant (`POST /admin/oauth/access_token`), caches it, refreshes 10 min before the 24h expiry, and retries once on 401.
  Admin GraphQL API version 2026-10. Queries only; mutations are refused in code.
- The env credentials bind only to the tenant whose `shopify.admin_shop` equals `SHOPIFY_ADMIN_SHOP`.
- Turn on after deploy: `PATCH /admin/tenants/rfsafe` with `deploy/rfsafe.order-lookup.patch.json`.
- Caller check: order number plus the email or phone on the order (caller ID counts). Max 3 failed checks per call.
  Returns status, items, carrier, last 4 of tracking, delivery estimate, city/state. Never the street address, payment, or prices.
