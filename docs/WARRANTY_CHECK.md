# Warranty / $20 replacement: past-order model check

John, Nov 18 2026 8:38 PM ET (via Jarvis): "you need to make sure that the phones that they ordered in the past are the models
that they're expecting to get a warranty replacement for at the twenty dollars... if they hadn't, you can just say ... the only
cases we have that you show that are warrantyable are the blank model, blank model, or blank model, and to please provide the
order details for that particular model phone to initiate the warranty process or the replacement process."

## What it does
On a $20 replacement / warranty request, the requester's **own** past quantacase.com orders are compared with the phone model
they want a replacement case for. Shared logic: `vendor/sitemail/src/mailbox/warranty.js`.

| Result | When | Reply |
|---|---|---|
| match | every requested model is on one of their orders | normal replacement answer (PR #75 wording, prompts 1.9.27) |
| mismatch | they have orders, but not for the requested model | "The only cases we show as warrantable under [this email / this phone number ending in 1234 / that order number] are for the [A] and [B]. The $20 replacement applies only to those models, for as long as you own that phone. For your [requested] case, you would need to buy it at the regular price, or send us the order details for it. If the order was placed with a different email or phone number, please let us know, or contact us from that email or call us from that number, to access warranty information." |
| no_orders | no verified orders | "We don't show any warrantable orders under [this email / this phone number ending in 1234]. If the order was placed with a different email or phone number, ..." plus the ask for the order number, or the name, email and phone number used on the order |
| no_model | orders found, no phone named | ask which phone the replacement is for |
| no_items | items could not be read (live lookup failed) | normal replacement answer, no claim about which phone the order was for |

Model names are exact keys (`bots.phoneKeys`, most specific wins): iPhone 16 Pro and iPhone 16 Pro Max are different phones, and
so are the Galaxy S24, S24+ (S24 Plus) and S24 Ultra, and the iPhone 16 and 16e. Galaxy Z Fold / Z Flip get their own keys.

The identifier wording follows John, Nov 18 2026 8:48 PM ET: "let them know that the only cases we show are warrantable under
this phone number or email, whichever one it is and then you can make a list of 'em ... if the order was placed from a different
email or phone number ... to please let you know. Or to please call us from that number or use that email." The reply never
repeats the email address or more than the last 4 digits of a phone number.

Per-model rule (John, Nov 18 2026 8:54 PM ET): "the warranty is applied only toward the phone models that have been purchased.
And they're good for as long as you own that phone." When one message asks about an owned model and a model that is not on
their orders, the owned model gets the normal $20 answer and the other gets the mismatch wording ("partial match").

## Paths and flags
- **Mailbox** (callbots.org `/inbox`): runs inside the existing order index (`SITEMAIL_ORDER_INDEX=1`, already on in production
  since Nov 16). Only orders matched by the **sender email** are used (`orderindex.factsFor`); a phone number typed in the body
  stays unverified and names nothing. The result is a "Replacement check against this sender's past orders" section in the
  System notes for the writer and checker, plus a deterministic checker rule: a mismatch reply must include the mismatch sentences
  word for word, and a no-orders reply must include the no-warrantable-orders sentences and ask for the order number, or the name,
  email and phone on the order (the checker adds missing text as an edit so the revise loop fixes it). No prompt text changed, so prompt defaults stay 1.9.27 and saved custom
  prompts are untouched. With the index off, nothing changes.
- **Phone and text**: new `warranty_check` tool, listed only when the tenant's `order_lookup_enabled` is on (the same gate as
  `order_status`). `order_lookup_enabled` is **off** in production and this PR does not change it, so the tool is not offered
  on calls or texts until John approves turning order lookup on. It uses caller ID (or the SMS sender number), or an order number
  plus the email or phone on that order (same verification as `order_status`). A spoken email or phone alone never lists orders.
  The Admin search by caller ID is free-text, so every result is re-verified against the order's own phone fields.

## Privacy
Only phone models (and, on a match, the requester's own matching order number) leave the server. No addresses, prices,
payment details, full tracking numbers or other customers' data. Read-only Shopify queries only; no writes.
