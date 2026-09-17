# Credit System Audit

Updated 2026-09-17 for server `0.26.0`.

## What is correct

- Every billable API action reserves credits in a Postgres transaction while locking the owning user row. Concurrent requests cannot drive a balance below zero.
- Idempotency keys and active-resource uniqueness prevent duplicate work from charging twice. Replays of completed operations return the recorded result.
- A failed response, explicit `res.noCharge()`, expired lease, or failed sourcing worker refunds exactly once. Refunds and the ledger entry commit together.
- Stripe fulfillment requires a signed webhook, `payment_status = paid`, a recorded purchase, matching email/currency/amount/session, and a one-time `fulfilled_at` transition. Concurrent webhook deliveries and event replays were tested.
- Cached kits are unbillable reads. A successful generation, cover letter, resume tailor, analysis, interview generation, voice answer, and quick answer each has one server-owned price.

These claims are backed by the 19 adversarial groups in `test/hardening.cjs`, including 32 concurrent reservations, concurrent refunds, expired work, failed workers, Stripe replay, and unpaid-event rejection. Stripe's fulfillment guidance likewise requires webhook fulfillment, a paid-status check, and protection against concurrent duplicate fulfillment: https://docs.stripe.com/checkout/fulfillment.

## Economic risks still open

1. **Provider cost is modeled, not measured.** `HB_CENTS_PER_RUN = 50` and the Claude token assumptions are estimates. If Hyperbrowser sessions or model output cost more than assumed, a sourcing run can be underpriced. The current 20% markup is not a guarantee of margin.
2. **Admin adjustments are not ledgered.** `/admin/credits/add-by-email` updates `users.credits` directly. The adjustment is intentional and authenticated, but it is absent from `credit_ledger`, so a balance cannot be fully reconstructed from the ledger alone.
3. **Legacy Stripe sessions need reconciliation.** New checkout sessions carry `metadata.purchase_id`; older paid sessions do not and are deliberately rejected by fulfillment. Reconcile or drain those before relying on the new webhook path.
4. **Crash settlement is conservative.** If the process dies after an AI result is persisted but before operation settlement, lease recovery can refund the operation. This protects the customer but can give away completed work.

## Recommended launch controls

- Export Hyperbrowser and Anthropic usage/costs per operation, compare actual cents to charged credits weekly, and raise catalog prices before the reserve is exhausted if the 20% buffer is breached.
- Route admin grants through a typed `credit_adjustment` ledger entry with an admin identity, reason, and idempotency key. Add a reconciliation report: `users.credits` versus the opening balance plus ledger sum.
- Run one live Stripe test purchase and replay its webhook after every billing change. Reconcile all pre-metadata sessions before inviting paying users.
- Add an alert for refunded operations, unfulfilled paid purchases, and operations older than their lease. These are the three states most likely to hide revenue leakage or a broken customer experience.
- Keep the public promise aligned with actual economics: automated sourcing overnight, then a reviewable tailored resume, cover note, and answers for each role. Do not promise a fixed number of runs until provider metering confirms it.
