# Research: Grok Voice + Twilio phone agent (checked 2026-10-29, ET)

All prices are published list prices read on 2026-10-29. Anything I could not confirm from a primary page is marked **UNCONFIRMED** with what would confirm it. Nothing was bought, signed up for, or called with credentials.

## 1. xAI Grok Voice (Speech to Speech)
| Question | Answer | Source |
|---|---|---|
| Price | `grok-voice-3.0` (alias `grok-voice-latest`): **$0.08/min ($4.80/hr)** + **$0.004 per text input**. `grok-voice-2.0` is deprecated, same price. | https://docs.x.ai/developers/pricing |
| Phone calls | **Direct SIP**: register a number with `POST /v2/phone-numbers`, `origin: "byo_trunk"`. The carrier routes to `sip:{number}@sip.voice.x.ai;transport=tls`. xAI sends a signed `realtime.call.incoming` webhook (`webhook-id`, `webhook-timestamp`, `webhook-signature`). The server then joins at `wss://api.x.ai/v1/realtime?call_id=…` and sends `session.update`. The signing secret is returned **once**. Twilio steps are documented (Elastic SIP Trunk, origination URI, enable call transfer). | https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech/sip |
| Tool / function calling on SIP calls | **Yes.** After joining, "the WebSocket behaves like any other Speech to Speech API session". Session `tools` supports `function`, `file_search` (Collections), `web_search`, `x_search` and `mcp`. Function calls arrive as `response.function_call_arguments.done`. You return `function_call_output`, then send one `response.create` after parallel calls. | SIP page (above) + https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech |
| MCP on phone calls | **Documented as a session tool type** (`type: "mcp"`, Streaming HTTP/SSE, `authorization`, `allowed_tools`). xAI executes it server-side. Using it on a SIP session specifically is not shown, but SIP sessions are stated to be ordinary sessions. **Latency on SIP is UNCONFIRMED**: measure it on the first test call. v0.1.0 uses **function tools** (our server executes them), so the link allowlist and no-payments rules stay in our code. | same |
| Transfer, hangup, DTMF | `POST /v1/realtime/calls/{call_id}/refer` with `target_uri` (`tel:` or `sip:`). The call blocks until resolved: 200 means answered, 502 is a downstream SIP reject, 504 is a timeout. If a transfer fails, the session stays live. `.../hangup`. DTMF is buffered to the model. | SIP page |
| Scripted disclosure | `force_message` speaks verbatim text, which is used for the AI and recording notice. | Speech to Speech page |
| Concurrency | Speech to Speech is limited by **concurrent sessions by tier: T0 10, T1 20, T2 50, T3 100, T4 200**. Higher tiers unlock with cumulative spend (T1 at $50, T2 at $250). **Per-number limits: UNCONFIRMED.** Nothing is published; ask xAI support. | https://docs.x.ai/developers/rate-limits |
| Text model for SMS replies | `grok-4.3`: $1.25 per 1M input tokens, $2.50 per 1M output. Collections search costs $2.50 per 1k calls. | https://docs.x.ai/developers/pricing |
| No-code fallback | Voice Agent Builder (beta) bills the API rate ($0.08/min), plus **$0.01/min telephony on its free provisioned number**. It has tools, MCP, transfer and guardrails. **SMS: UNCONFIRMED.** The announcement doesn't mention it. | https://x.ai/news/grok-voice-agent-builder |
| Webhook signature scheme | The header names are documented. The exact algorithm is **UNCONFIRMED**. The code assumes Standard Webhooks (HMAC-SHA256 over `id.timestamp.body`, `v1,<base64>`). Confirm by verifying one real webhook from a test call. If it differs, `src/xai.js#signWebhook` is the only function to change. | SIP page |
| xAI billing during and after transfer | **UNCONFIRMED.** Unknown whether session minutes keep accruing after a successful REFER. Confirm from xAI usage after one transferred test call, or ask xAI. | — |
| API for the existing Grok Bot teammate | **UNCONFIRMED / none found.** No public API is documented. The plan mirrors its instructions and KB into the tenant prompt and KB. | — |

## 2. Twilio (US)
| Item | Price | Source |
|---|---|---|
| Local number | **$1.15/mo** | https://www.twilio.com/en-us/sip-trunking/pricing/us ; https://www.twilio.com/en-us/sms/pricing/us |
| Elastic SIP origination (inbound to the trunk, local) | **$0.0034/min** | SIP trunking pricing |
| Elastic SIP termination (outbound legs, e.g. a transfer to a staff phone; US 48 states, Zone 1) | **$0.0100/min** | SIP trunking pricing |
| Concurrency | "Unlimited Call Concurrency: Included" | SIP trunking pricing |
| Emergency calling (optional) | $0.75/mo per number | SIP trunking pricing |
| Call recording (optional) | $0.0025/min | SIP trunking pricing |
| SMS (long code) | **$0.0083 per segment, outbound or inbound**. Failed message: $0.001. | SMS pricing |
| Carrier fees per SMS segment | Outbound: AT&T $0.0035, T-Mobile $0.0045, Verizon $0.005, others $0.0042. Inbound: AT&T $0.0035, T-Mobile $0.0025, Verizon none listed. | SMS pricing |
| A2P 10DLC, Low-volume standard (EIN, < 6,000 segments/day) | **$4 one-time brand + $15 one-time campaign vetting + $1.50–$10/mo per campaign** | https://www.twilio.com/en-us/phone-numbers/a2p-10dlc |
| A2P 10DLC, Sole proprietor (no EIN) | $4 brand + $15 vetting + **$2/mo** | same |
| A2P 10DLC, Standard | $44 brand + $15 vetting + $1.50–$10/mo | same |
| A2P approval time | Twilio "estimate[s] that it takes under one week" | same |

**How a transfer is billed (best reading of the published pages):**
- Twilio keeps billing the caller's inbound leg at $0.0034/min.
- The new leg to the staff phone bills at $0.0100/min of termination.
- xAI may keep billing $0.08/min (UNCONFIRMED, see above).
- Worst case for a transferred minute: $0.0934. Best case: $0.0134.

## 3. Is quantacase.com on Shopify? **Yes (confirmed 2026-10-29).**
- The response headers include `powered-by: Shopify`.
- The page preconnects to `https://cdn.shopify.com` and serves theme assets from `/cdn/shop/t/10/...`.
- `https://quantacase.com/products.json` returns a Shopify product feed, for example "QuantaCase RFS1 for Samsung Galaxy A57".
- `https://quantacase.com/search/suggest.json?q=iphone&resources[type]=product` returns product results.

So v0.1.0 can do read-only product lookup **with no token** ("public" mode). A Storefront token (custom app, `unauthenticated_read_product_listings`) is optional. It needs John's Shopify admin to create it, which costs nothing.

## 4. Hosting (small always-on WebSocket service)
| Host | What you'd pay for this service | Notes | Source |
|---|---|---|---|
| **Render (pick)** | Hobby workspace **$0/mo** + Starter web service (0.5 CPU / 512 MB) **$7/mo** + 1 GB persistent disk **$0.25/mo** = **$7.25/mo**, a fixed price | WebSockets, custom domain and automatic TLS included. The Free instance is not suitable because it is not always-on. | https://render.com/pricing |
| Railway | Hobby plan **$5/mo**, including $5 of usage. Usage is metered at $10 per GB-month of RAM and $20 per vCPU-month, so a 0.5 GB service holding its RAM all month is ~$5 of RAM alone, plus CPU. Estimated **~$5–8/mo**, variable. Volume $0.15/GB-month. | Per-second billing, so the cost moves with load. | https://railway.com/pricing |
| Fly.io | Not compared. I did not pull Fly's pricing page, and I won't quote numbers I didn't read. | — | — |

**Pick: Render Starter.** It is the only option with a fixed, predictable $7.25/mo for an always-on process. It has a persistent disk for the consent ledger and the encrypted token store, plus health checks, rollbacks, and Blueprint config (`deploy/render.yaml`). Railway might come in a dollar or two cheaper, but its bill varies.
