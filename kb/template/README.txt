Empty knowledge base for a new Callbots business (format: callbots-kb v1, see docs/KB_TEMPLATE.md).

Copy this folder to kb/<tenant-id>/ and fill it from the owner's Best Deal On profile and website.
Nothing here is answerable until it is filled: the .md files have no body and the .jsonl files are empty,
so the bot says it does not have that information and logs the question as a KB gap.

  business.md            name, hours, address, service area, phone, website (front matter title/source + body)
  escalation.md          when to transfer, when to take a message
  products-services.jsonl, pricing.jsonl, faq.jsonl, policies.jsonl
                         one card per line: {"id","kind","title","position","body","sources","aliases","updated","producer"}
                         kind: business | product | service | pricing | faq | policy | escalation
                         sources: at least one https link on the business's own domains
  links.json             the tenant link_allowlist (bare domains), e.g. ["bestdealon.app"]

Rules: never invent prices, hours, policies or claims. Leave a field empty until the owner confirms it.
The owner approves the filled KB before it is loaded (scripts/kb-template.js check, then upload).
