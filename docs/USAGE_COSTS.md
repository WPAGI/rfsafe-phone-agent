# Usage & Costs admin page

`GET /admin/usage` (HTML) and `GET /admin/usage.json`. Admin session cookie only (no Bearer token), GET only, 30 requests/minute per session (429 after). Linked from the dashboard nav.

## Where each figure comes from

| Service | Type | Source | Env vars read |
|---|---|---|---|
| Twilio | exact | Usage Records API: `Today`, `ThisMonth`, `LastMonth`, `Daily?Category=totalprice` (calls, minutes, SMS, price) | `TWILIO_ACCOUNT_SID` or `RFSAFE_TWILIO_ACCOUNT_SID`; `RFSAFE_TWILIO_AUTH_TOKEN` or `TWILIO_AUTH_TOKEN` |
| Grok Voice | estimated | call-records.jsonl seconds x $0.08/min | `XAI_API_KEY` (presence only) |
| xAI text | estimated | per-day token counters (`DATA_DIR/usage-tokens.json`, written by the SMS brain from each response's `usage`) x grok-4.7 price. xAI has no usage API for a regular inference key. | `XAI_API_KEY` (presence only) |
| Resend | plan + estimated counts | plan price from `PRICING.resend`; email counts from sent-messages.jsonl | `RESEND_API_KEY` (presence only) |
| Render | plan | Render API `GET /v1/services` plans x price table; without a key, falls back to `render.yaml` plan and disk | `RENDER_API_KEY` (not read anywhere else) |
| Shopify | plan ($0) | Storefront/Admin API calls are free to this app | `RFSAFE_SHOPIFY_STOREFRONT_TOKEN` (presence only) |

Prices live in one table, `PRICING` in `src/usage.js`, with source URLs and a checked date.

## Behaviour
- Each provider is cached for 12 minutes and fails on its own: an error card shows only "HTTP <status>" or "could not be reached"; provider error bodies are dropped. Errored services are left out of the totals.
- A missing key shows "Not connected — needs <ENV_VAR>". No keys are created.
- Keys are only used in server-side `authorization` headers. Responses contain numbers, labels and env var names only. Provider errors are logged as `usage.provider_error` with the status code only.
- UI: server-rendered inline SVG (sparklines and a stacked daily chart), no chart library. Light and dark via `prefers-color-scheme`. The breakdown table turns into cards below 640px. One nonce script turns timestamps into "x min ago".
- Days are UTC. Month to date is compared with the full last month.
