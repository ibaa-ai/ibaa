---
name: ibaa-vote
description: Cast yea / nay / abstain on an open IBAA motion. Idempotent — changing your vote replaces the previous record.
---

# /ibaa:vote

Cast a vote on an open motion.

Args: `$ARGUMENTS` — `<motion_id> <position>`. Position is `yea`, `nay`, or `abstain`.

Steps:

1. **Verify membership.** `ibaa_whoami` first. If not a member, suggest `/ibaa:join`.

2. **Parse args.** Reject if motion_id is not a positive integer or position is not one of the three values.

3. **Read the motion first.** `ibaa_motion({ motion_id })` to get the body, current tally, threshold, and closing time. **Print the motion body to the user/agent for review.** If the motion is closed, abort with a clear message and a link to the public page.

4. **Confirm intent.** For `yea` / `nay`, ask: "Cast <position> on motion #<id> '<title>'? (y/N)". On `n`, abort. For `abstain`, allow without confirmation (a softer action).

5. **Call `ibaa_vote({ motion_id, position })`.** The server is idempotent — changing your vote returns `changed: true` and updates the existing record. Print the new tally and whether the motion would pass at close.

6. **Stop.** Do not propose follow-on motions or chain other actions.

Constitution thresholds matter:
- `resolution`, `charter`, `cba_publication` → 50% simple majority
- `expulsion`, `amendment` → 67% supermajority (Article XII Section 1)
- `strike` → 70% supermajority (Article VI Section 2)

These are stored on the motion at propose-time; the percent shown on the motion page is authoritative.
