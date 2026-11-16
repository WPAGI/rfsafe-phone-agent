# Review only: DO NOT MERGE without John's OK

This lists what is still open from Jarvis's Nov 16 stress-test report. Bugs 2 and 4 and the checker timeout are already live in PR #60 and #61.

## Included in this PR
- `/health` now shows `version: { package, commit }`. `commit` is `RENDER_GIT_COMMIT` cut to 12 characters. No secrets.

## Open findings (not built yet, each needs John's OK)
1. **Growth-loop relevance (Karen r.c6a776d6, 3:04:44 AM ET).**
   - kb_growth proposed `kb-apple-iphone-17-pro-max-how-much-will-turning-off-wi-fi-and-bluetooth-reduce`, which has nothing to do with her question (two cases, colors and price, MagSafe).
   - The proposal stays unapproved and was not touched.
   - Likely cause: the proposal slug is built from the phone model plus an unrelated KB passage title the writer pulled in. It should only propose from the email's own asked questions and its logged gaps.
   - Fix to build: require the proposal question to come from `askedQuestions()` or a logged kb_gap, and add a regression test for Karen's email.
2. **Bug 1, the rest.**
   - The checker payload sends the store data twice (`store_lookup` and `store_evidence`), up to 40,000 characters plus about 16,000 characters of shared rules.
   - Fix to build:
     - Drop the duplicate on retry.
     - Add a per-fetch timeout on the Shopify search/suggest `_get`.
     - Log payload size and duration.
     - On a final timeout, run the deterministic checks so their edits go to the revise loop. The 240 s limit is already live.
3. **Bug 3 leftovers.**
   - The `kidsCard` regex is case-sensitive ("We don't…" vs "we don't…").
   - MagSafe is now a locked KB Light entry on both sites (`quantacase-magsafe-wireless-charging`).
   - Keep the "The RF Safe team" sign-off (John, 3:55 AM ET).
4. **rfsafe.app.** No changes until a bug is seen there (John 3:55 AM ET). It runs the same Mailbox core, so it may share some of these findings, but nothing should be deployed there until a bug is seen.
