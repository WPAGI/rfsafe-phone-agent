# Deploy: DO NOT RUN until John approves each paid step (see "Approvals")

The exact go-live sequence, env vars, A2P 10DLC notes, and E911 notes are in `GO-LIVE.md`. Use that checklist. This file is the cost background.

Nothing here has been done. Every step that creates an account, buys something, or registers anything needs John's OK first.

## Approvals John must OK (with cost)
| # | Step | Cost |
|---|---|---|
| 1 | xAI API billing on the console (usage only) | $0.08/min voice; grok-4.3 SMS replies ~$1–2/mo |
| 2 | Twilio account + **one new local number** | $1.15/mo |
| 3 | Twilio Elastic SIP Trunk (origination to xAI, call transfer enabled) | $0.0034/min in, $0.0100/min per transfer leg |
| 4 | Register the number with xAI (`POST /v2/phone-numbers`, byo_trunk) | no fee listed |
| 5 | Render Hobby workspace + Starter service + 1 GB disk | $7.25/mo |
| 6 | A2P 10DLC brand + campaign (Low-volume standard; sole proprietor if no EIN) | $19 one-time + $1.50–10/mo (sole prop: $19 + $2/mo); ~<1 week |
| 7 | (optional) E911 on the number | $0.75/mo |
| 8 | (optional) Shopify custom app Storefront token. Public mode works without it. | free |
| 9 | Any website change, e.g. publishing the number on quantacase.com or rfsafe.org | free, needs sign-off |

**Pilot estimate: ~$42–53/mo** (300 AI min, 30 transferred min, about 200 SMS segments each way). See RESEARCH.md.

## Interim texting
Until step 6 is approved, keep `sms_enabled: false` (the default in `deploy/rfsafe.tenant.json`). **The existing Grok Bot Text & Voicemail bot keeps handling texts through Google Voice/Gmail, and that path can only reply to people who texted first.**

## Steps (after approval)
1. **Render:** New, then Blueprint, pointing at `deploy/render.yaml`. Set the env vars listed in `deploy/env.example`:
   - Generate random values for `PA_ADMIN_TOKEN`, `PA_STATE_SECRET` and `PA_MASTER_KEY` (32 bytes, base64).
   - Set `XAI_API_KEY`.
   - Set `PUBLIC_BASE_URL=https://<service>.onrender.com`.
   - Set `PA_MODE=live`. The server refuses to start in live mode if anything is missing.
2. **Twilio:**
   - Buy a number.
   - Under Elastic SIP Trunking, create a trunk. Set the Origination URI to `sip:+1NUMBER@sip.voice.x.ai;transport=tls` and turn on **Call Transfer (SIP REFER)**.
   - Attach the number to the trunk.
   - Set the number's Messaging webhook to `POST {PUBLIC_BASE_URL}/twilio/sms`.
3. **xAI:**
   - `POST https://api.x.ai/v2/phone-numbers` with `{ "phone_number": "+1NUMBER", "origin": "byo_trunk", "webhook_url": "{PUBLIC_BASE_URL}/xai/webhook" }`. Check the exact body against the docs at that time.
   - **Copy the signing secret immediately**, because it is shown only once. Save it as `RFSAFE_XAI_WEBHOOK_SECRET`.
4. **Tenant:** edit `deploy/rfsafe.tenant.json`:
   - the real number;
   - the Quanta X Technology staff transfer number;
   - business hours.
   Then load it with the admin API (`POST /admin/tenants`) or copy it to `TENANTS_DIR`.
5. **KB:** run `node scripts/export-kb.js` to copy the approved wiki and rfsafe.org pages into the tenant KB dir. Redeploy.

## Verify (first test call)
- `GET /health` returns 200.
- Call the number. You should hear the disclosure first. Ask about a product, a SAR question, and then ask for a human.
- Check the logs for `webhook verified`. If the signature fails, the xAI signing scheme differs from Standard Webhooks; fix `src/xai.js#signWebhook`.
- Confirm the live WebSocket connects with the auth header (Node 22 `WebSocket`).
- After a transferred call, check xAI usage to see whether minutes billed after the REFER.

## Rollback
- Render: Deploys, then roll back to the previous deploy.
- Emergency: remove the origination URI from the trunk, or set the number's voice to forward to Quanta X Technology staff. Calls then stop reaching the AI.
- To fully stop: in xAI, `DELETE` the phone number registration. Suspend the Render service.
