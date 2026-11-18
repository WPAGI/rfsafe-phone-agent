# Edge testing screenshots (2026-11-17)

Taken from the real app code on a local port with **mock data only**:

- **Tests:** the shipped redacted seed (`seeds/edge-tests/<site>.json`), i.e. real test questions from the edge test library with PII removed. Order numbers other than test order 1173 show as `[redacted order number]`. Names are first-name test personas only. No customer email, phone, address or tracking number appears.
- **Model:** a local mock of the xAI chat endpoint (slow on purpose so the progress bar can be captured). The sorter, writer, checker and grader words, grades, held/would-send counts and costs are mock output, not a prediction of a real rerun.
- **Store:** a local mock of the public storefront built from the product links already in the seed. No Shopify Admin API, no order lookups.
- Nothing was emailed, no thread was touched; the send spy stayed at 0.

| File | What it shows |
| --- | --- |
| 01-test-list-desktop.png | Test list: question, newest reply with run tag, status chips, filters, cost estimate and daily cap |
| 02-side-by-side-desktop.png | One test: question, expected behaviour, run list, side-by-side compare, agent grade, human pass/fail review |
| 03-rerun-in-progress-desktop.png | "Rerun edge testing" in progress: run tag, progress bar, current test, cost so far, button disabled |
| 04/05/06-*-mobile-390.png | Same three views at 390px (single column below the 980px breakpoint) |

Design note: the page uses the existing admin login and shell, has no JavaScript (the CSP allows none), refreshes every 5 s while a run is going, and stores everything in one JSON file next to the other admin data.
