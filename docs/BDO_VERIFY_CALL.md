# Best Deal On: Verify by call + inbound claim (branch feature/bdo-verify-call-claims)

Tenant `bestdealon` only. RF Safe tenant, number +17276775572 and main are untouched. Everything defaults OFF.

| Env | Default | Meaning |
|---|---|---|
| `BDO_VERIFY_CALLS` | `off` | `dryrun` = accept signed requests, record, dial nothing. `live` = place ONE Twilio call (inline TwiML) |
| `BDO_INBOUND_CLAIM` | `off` | `on` + tenant `"bdo_claims": true` adds tools `bdo_listing_for_caller`, `bdo_start_claim` |
| `BDO_CALLBOT_SHARED_SECRET` | — | HMAC secret shared with bestdealon.app (`CALLBOT_SHARED_SECRET` there) |
| `BDO_SITE_URL` | — | `https://bestdealon.app` |
| `BDO_TWILIO_ACCOUNT_SID`, `BDO_TWILIO_API_KEY_SID`, `BDO_TWILIO_API_KEY_SECRET` | — | live calls only |

Routes: `POST /bdo/verify-call` (signed by the site; `to` must equal `+1<listing_phone>`; RF Safe and any tenant number refused; From = bestdealon's own number; 3 calls/number/hour; 120 s time limit) and `POST /bdo/verify-gather` (Twilio-signed; `To` must match the listing; posts keyed digits to the site's `/api/callbot/verify-check`).
Modes: `read` speaks the code twice (the person types it on the site); `keyin` gathers 6 DTMF digits (the bot never receives the code).
Claims: the bot only creates a *pending* claim on a spoken yes. Caller ID is never proof.
Tests: `node --test test/bdo-verify-call.test.js` (mock driver; no network).
