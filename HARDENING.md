# ApplyApply hardening

Implemented locally after the adversarial review of `6f11104`.
Server 0.26.0; extension 1.11.0. Not deployed to production.

## What changed

- Posting identities are derived from authenticated owner plus canonical URL, not model-generated slugs. Lever/Ashby/Greenhouse application URL variants converge. Other posting query parameters are retained.
- A transactional migration archives duplicate job records before merging them. Applied and explicitly dismissed states outrank new. Kit ownership cannot change through the persistence API.
- Kit revisions retain earlier documents. Stale updates are rejected. History is available through authenticated `GET /application/:id/versions`.
- Credit reservations, refunds and purchase fulfillment are transactional Postgres records. Concurrent requests cannot overspend. An active resource is deduplicated, explicit idempotency keys replay completed operations, and failed/expired work refunds once.
- Sourcing is a durable queue with two globally claimed worker slots, leases, heartbeat, a 20-minute child deadline, and expired-operation recovery. Jobs, run detail and successful completion commit together. Four pending operations per account are allowed.
- Schedules use dated occurrences and a three-hour catch-up window, including across midnight. Duplicate scheduler dispatches reserve one operation. An overlapping manual run defers the scheduled dispatch.
- Logs, run detail, feedback and opened activity are owner-scoped database records. The sourcing page fetches authenticated results and watches persisted operation status. SSE limits simultaneous streams per account within an instance. Its formerly hidden progress panel now becomes visible.
- Google cache entries retain validated/scored results. Provider failures fail the run rather than masquerading as successful empty searches. A valid zero-result run is recorded distinctly.
- Arbitrary job-page fetches validate public IP addresses, pin DNS answers, revalidate redirects, and bound response size and time. Local/private addresses and URL credentials are rejected.
- AI input carries an untrusted-content system instruction. Application IDs, destination, owner and profile are assigned outside the model. Output is schema-filtered; mappings cannot invent eligibility, consent, radio or dropdown selections. Resume identity and source text are protected from model replacement.
- The extension no longer fills automatically. Explicit fill preserves existing answers, and unknown authorization/sponsorship/qualifications remain unanswered. The current server profile overrides old kit snapshots. Session changes invalidate replies and pending autosaves; the background rejects stale-account messages and arbitrary destinations.
- Reflected script serialization and reviewed HTML injection paths are escaped. No developer identity is supplied as a profile or voice fallback. Resume uploads validate PDF bytes and await file persistence.
- Signed unpaid Stripe events grant no credits. Paid events must match a recorded USD 10 / 1,000-credit purchase, account and session; distinct events for one session cannot double-credit. This follows [Stripe's fulfillment guidance](https://docs.stripe.com/checkout/fulfillment).
- Compatible dependency updates include Multer 2.4.0 and the patched Express/qs dependency chain. See the [Multer advisory](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm). The installed server production dependency audit reported zero known vulnerabilities at verification time.

## Verification

Local verification uses Node 22.23.2, real throwaway Postgres databases and real Chrome. AI replies, worker failures and Stripe events are synthetic; no production accounts, purchases, emails or sourcing providers are called.

```sh
npm ci
npm --prefix server ci
npm run check
npm --prefix server test
npm test
npm --prefix server audit --omit=dev --audit-level=high
```

The root runner allocates its own database and port and cleans both up. It does not reuse or drop a developer's database. It needs local Postgres on port 5432 and permission to create temporary databases. `PGUSER`/`PGPASSWORD` support CI. `AA_CHROME` selects Chrome; installed macOS Chrome is detected automatically, otherwise Playwright's installed Chromium is used.

For an isolated UI preview, run `node test/preview.cjs`. It prints a one-time local sign-in URL, seeds synthetic data, and disables external providers, payments and workers. Ctrl-C removes its temporary database. Set `AA_PREVIEW_PORT` if port 5100 is occupied.

- Six template-scanner self-tests, ten page-template scans, and ESLint across server, sourcing and extension code.
- Five server smoke tests, including unavailable-database readiness.
- Original integration suites: 35 isolation assertions, 15 kit/profile assertions, seven evidence assertions, six browser page checks.
- Extension browser tests: shipped content-script initialization, escaped model HTML, no auto-fill, explicit fill, preserved existing answers, sidebar autosave into Postgres, switching accounts with a pending save, and sign-out. Chrome transport is simulated, not an installed-extension permission test.
- Sourcing browser tests: authenticated result rendering, actual SSE delivery, durable failure rendering and refunded balance. Synthetic worker events are used. Desktop/mobile screenshots are written to `/tmp/applyapply-sourcing-{desktop,mobile}.png` and inspected locally.
- Background-script tests: session initialization, stale-account message rejection, destination restriction and canonical-domain sign-in.
- Nineteen adversarial regression groups: owner collisions; cache identity and zero-balance reuse; failed regeneration; hostile model output; private-network fetch rejection; auth script injection; audit isolation; 32 simultaneous reservations; 16 simultaneous refunds; HTTP generation races/retries; expired leases; failed workers; dated schedules; URL migration; version history; signed payment replay; eligibility; scheduler races; PDF upload; scored cache/zero-result semantics. Some groups cover multiple behaviors.

The GitHub Actions workflow runs these gates on Node 22 with disposable Postgres and Chromium. It has been added as configuration only; no hosted Actions run has been observed yet.

## Deployment cutover

1. Back up Postgres and test restoring that backup. Rehearse migration on a sanitized staging copy, including duplicate URL variants and legacy kits. The migration is transactional, but has not been timed on a production-size dataset.
2. Pause checkout creation and reconcile outstanding sessions from the old checkout flow. They do not contain `metadata.purchase_id`; the new webhook deliberately refuses to fulfill them automatically. Drain/process legacy events under the old flow before cutover, or review and reconcile them explicitly. Do not blindly replay old paid sessions into a fresh purchase record.
3. Stop old sourcing processes and old server instances before running the upgraded schema and code. Do not roll back only the application binary: old writers do not understand canonical identities, purchases or leases. Use the tested backup/restore procedure for a coordinated rollback.
4. Set the intended `APP_ORIGIN`, `CORS_ORIGINS`, Stripe price/signing secret and provider secrets explicitly. Public-domain/DNS changes have not been made. The configured Stripe price must be an active, one-time USD 10 price.
5. Start the server normally, not with `NODE_ENV=test`. Test mode intentionally disables cron and background workers. Paid routes now require an account session; the bundled local identity and implicit local billing bypass are gone.
6. Verify `/health`, then two-account isolation, one live test checkout, its replay, and one actual scheduled sourcing run. Watch its UI while running; interrupt a test worker and verify the refund after lease expiry.
7. Monitor refunded/stuck operations and unfulfilled paid checkouts. Assign a human owner for reconciliation and support before inviting paying users.

Old global log files and feedback are not imported: their original owner cannot be inferred safely. Existing kit contents are preserved, not bulk rewritten. Old resume bullet backfill remains a separate, reviewable migration.

## Still not proven

- A real purchase, email delivery, Hyperbrowser run, or cron firing on the deployed infrastructure after these changes.
- Completion emails remain best-effort notifications, not a durable email outbox. A crash or delivery failure can lose a notification even though the operation and credits are durably correct.
- Full prompt-injection resistance or factual correctness of generated prose. Schema filtering protects authority-bearing fields, not every sentence. Real-model adversarial evaluations and evidence-level provenance remain necessary. All output is draft material requiring applicant review.
- Actual Chrome installation, optional permission grants and iframe injection across the supported ATS matrix. The browser fixtures do not prove these platform permissions work.
- Load capacity, proxy/rate-limit adequacy, PDF parser resource-exhaustion resistance, monitoring/alert delivery, or database failover. The process-local SSE cap and per-account operation cap are safeguards, not a load-test result.
- An exhaustive XSS audit or a strict CSP. Existing inline event handlers still prevent straightforward nonce-only CSP deployment. Session tokens remain in browser storage and the SSE query parameter; production logging must redact them.
- Complete financial/account-deletion retention policy. The new ledger covers new paid operations/purchases, not a reconstructed history of legacy or administrative adjustments. Revision and operation records also require an explicit retention/deletion policy.
- Perfect settlement atomicity for HTTP generation: a process crash after saving a kit but before settling its operation may refund a completed kit. It cannot debit twice or discard the previous paid kit; this conservative recovery can cost the operator a generation.

The stack remains suitable for a small beta. Calling the product best-in-class requires passing the live gates and measuring correctness, not just adding infrastructure or marking the audit closed.
