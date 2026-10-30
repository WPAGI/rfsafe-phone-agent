---
title: Phone agent v0.1.0 (Grok Voice + Twilio): build status
date: 2026-10-29
tags: [phone-agent, rfsafe, quantacase, grok-voice, twilio]
status: built, not deployed
---
# Phone agent v0.1.0: build status

- **What:** an AI phone line for RF Safe / QuantaCase. Grok Voice is reached over Direct SIP from a new Twilio number, and our tool server (Render) runs the tools. The tools cover:
  - product lookup (read-only Shopify);
  - KB answers (wiki and rfsafe.org);
  - link-only SMS to quantacase.com and rfsafe.org;
  - transfer to John during hours, or a message.
- **Never:** payments, card data, or links to other domains. These are enforced in code.
- **Code:** `/workspace/code/phone-agent/`. Package: `dist/rfsafe-phone-agent-v0.1.0.zip`.
- **Status:** built and tested with mocks and EXAMPLE data. No accounts, purchases, A2P registration or deploy.
- **Cost:** ~$42–53/mo for the pilot, plus $19 one-time for A2P. Hosting is Render at $7.25/mo.
- **Texting now:** the existing Grok Bot Text & Voicemail bot (Google Voice/Gmail) keeps handling texts until A2P is approved. It can only reply to people who texted first.
- **Open (UNCONFIRMED):**
  - the xAI webhook signature scheme;
  - xAI billing after a transfer;
  - per-number concurrency;
  - whether there is an API for the Grok Bot teammate.
- **Next:** John approves the steps in DEPLOY.md, then one test call.
