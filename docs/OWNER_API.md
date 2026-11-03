# Owner API (`/api/owner/v1/*`) – Best Deal On Bot extension

Read-only, one business per request. Branch `owner-api` (off `bestdealon`). Not on main; RF Safe is unaffected (no RF Safe tenant has `bizinator_phone`, so every request for it is 404).

**Auth:** `Authorization: Bearer bdo_<id>_<48hex>` (Bizinator per-phone token from the extension's "Connect to Best Deal On").
The server calls `${BIZINATOR_URL}/api/v1/me` (needs `token.phone` + `modules:read`) and `/api/v1/businesses/{phone}` (owner-only in Bizinator). Answer cached 60 s (no: 10 s) by SHA-256 of the token; the token is never logged or stored.
**Tenant binding:** the tenant whose `bizinator_phone` equals the token's phone. `bizinator_phone` is set only by the platform admin (`PATCH /admin/tenants/{id}`, Bearer PA_ADMIN_TOKEN). No tenant id is accepted from the client.

| GET | returns |
|---|---|
| `/status` | business, safe config allowlist, channels (sms note), onboarding checklist, ready |
| `/subscribers[.csv]?q&offset&limit` | newsletter rows for this tenant (pending included) + `asked_on_calls` |
| `/calls[.csv]?from&to&number&offset&limit` | call records for this tenant |
| `/kb-gaps[.csv]` | unanswered questions (no tenant column) |
| `/messages[.csv]?type=email|sms[&id]` | sent messages for this tenant; `id` of another tenant → 404 |

Everything else: 404. Non-GET: 405. CORS: `chrome-extension://hheielialecldbibdenjkepdhdbnbmig` + env `OWNER_API_ORIGINS`. Rate limit 60/min/token.
Env: `BIZINATOR_URL` (default https://bestdealon.app), `OWNER_API_ORIGINS` (optional). No new secrets.
Tests: `test/owner-api.test.js`.
