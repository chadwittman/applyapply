# ApplyApply adversarial pre-launch audit

Reviewed 2026-09-16 at `6f11104`, server 0.25.0, extension 1.10.2.

Historical baseline: the findings and reproduction results below describe that revision, not the subsequent fixes. See [HARDENING.md](HARDENING.md) for implementation, current verification, remaining risks, and deployment gates. `test/hardening.cjs` is the regression gate; the original adversarial harness intentionally asserted unsafe baseline behavior.

## Verdict

Do not open a paid, multi-user beta at this revision. The product direction is promising, especially candidate evidence collection and keeping final submission with the applicant. The implementation still permits cross-account writes, discloses sourcing activity, makes unsupported assertions on applications, and charges for failed work.

The stack is adequate for a small beta. The missing pieces are enforceable ownership, durable work and billing records, trustworthy source processing, and measured application correctness. Changing hosting providers, adding more agents, or changing models would not resolve these findings.

## Evidence and scope

- Read the server's auth, billing, kit, profile, resume, voice, scheduling, sourcing and rendering paths; database helpers; sourcing engine; relevant extension lifecycle, permissions and filling code; tests and deployment configuration.
- `npm run check`: passed, including six scanner self-tests and ESLint.
- Original `npm test`: initially failed because its default Playwright executable was absent. Reran with `AA_CHROME` pointing to installed Google Chrome: all four suites passed, comprising 35 isolation assertions, 15 kit/profile assertions, seven evidence assertions, and six page checks. The brief's headline of 54 does not match these totals.
- `node test/adversarial-audit.cjs`: 22 unsafe behaviors reproduced and three positive controls passed. These are observations across the root causes below, not 22 independent security vulnerabilities.
- The audit harness creates and drops a uniquely named database on localhost. It uses the real Express handlers and Postgres queries, redirects log files to a temporary directory, mocks model responses and child processes, and blocks external provider fetches. Concurrency tests identify their controlled interleavings. No production writes, purchases, emails, AI calls, or sourcing runs were made.
- Local Node was 25.6.0, outside the repository's declared `>=20 <23` range. Passing local results do not substitute for running the release gate on the deployment runtime.
- Application code was not changed. The additions are this report and its reproduction harness.

The harness asserts the current defects so another reviewer can reproduce them. `OBSERVED` is not a safety pass. Convert these cases into assertions of the desired behavior when fixing them; do not use its successful exit as a release gate.

## Findings

### 1. P1: Kit generation can replace another account's paid kit

Locations: `server/db.js:487`, `server/server.js:2453`.

`kits.id` is globally unique and comes from the model's company/role slug. `saveKit` reads the prior kit without owner scope, then overwrites `user_email` and all data on ID conflict. Two ordinary applicants generating the same role can therefore collide. Prior URL aliases can also carry over between owners.

Reproduced through two authenticated `/generate` requests with identical synthetic model IDs: Alice first gets a kit; Bob generates the same role; Alice's subsequent read returns 403 and the stored owner is Bob. This does not require a bypass of the read-side ownership check. That check works after the write has reassigned the object.

Fix: generate immutable IDs in application code; identify kits by an authenticated owner and canonical posting; prohibit owner mutation on upsert. Every kit read and write must require its owner. Include concurrent generation and regeneration in the cross-user tests.

### 2. P1: Anonymous sourcing HTML and authenticated audit APIs disclose other users' activity

Locations: `server/server.js:3265`, `server/server.js:3307`, `server/server.js:4184`, `server/server.js:4194`, `server/server.js:4200`; shared files in `source.js:756` onward.

`/sourcing` reads the shared `last-run-detail.json` and embeds its jobs in public HTML. It also computes kit badges using every user's kits. The authenticated `/audit/data` and `/audit/feedback` endpoints merely check that someone is signed in; they return shared files without owner scope. Feedback writes match by URL alone.

Reproduced: anonymous GET `/sourcing` returned the synthetic private company's name. Bob read Alice's synthetic last-run record and private feedback note through the audit APIs. The authenticated leak and the public HTML leak are separate surfaces.

Fix: persist run details, feedback and opened activity with an owner/run ID in Postgres. Public HTML should contain an empty shell; authenticated requests load only that user's records. Authenticated SSR is also viable once there is a reliable session mechanism. Gate the entire rendered response, not just its JSON equivalents.

### 3. P1: The sign-in success page permits reflected script injection

Location: `server/server.js:989`.

Untrusted `session` and `ext` query parameters are interpolated into an inline script with `JSON.stringify`. JSON encoding does not escape an HTML `</script>` terminator. `/auth/success` also accepts requests with no valid session.

Reproduced at the HTTP response level: an unauthenticated `ext` parameter containing a closing script tag and a harmless marker script appears verbatim as executable markup. No Content Security Policy is present. Browser execution of the marker was not driven during this audit; the concrete HTML breakout is established. Same-origin execution would put the application's localStorage session token at risk.

Fix: validate extension IDs and require a valid session for this route; use HTML-safe serialization or remove inline user-controlled script data. Apply context-appropriate escaping throughout server and extension rendering. Add CSP as defense in depth and test script terminators, quotes and HTML attribute payloads.

### 4. P1: Application filling asserts qualifications and authorization without candidate evidence

Locations: `extension/content.js:1096`, `extension/content.js:1481`, `server/server.js:2119`.

The deterministic extension filler always answers authorization Yes and sponsorship No. Its Greenhouse helper also answers Yes to product-marketing management, AI experience, and 10+ years of product-marketing questions. These answers are functions of the question text alone. The AI field-mapping prompt repeats the authorization and sponsorship defaults regardless of the supplied profile.

Reproduced by executing the actual binary-answer helper without any candidate profile: experience Yes, sponsorship No. A full ATS form interaction was not driven. The extension also auto-fills an existing kit when an application page opens (`extension/content.js:268`), so an explicit final submit is not an adequate safeguard against incorrect answers being inserted.

Fix: represent authorization, sponsorship, location constraints and factual qualifications explicitly, including an unknown state. Deterministic values must come from verified candidate data; unknown answers remain blank and require confirmation. Never infer a qualification from the wording of the question. Preserve existing user-entered answers unless replacement is requested.

### 5. P1: User-supplied URLs cause unrestricted server-side fetches

Locations: `server/server.js:1945`, `server/server.js:2328`, `source.js:128`, `source.js:798`.

`/generate` fetches an arbitrary URL, follows redirects, and includes its response text in a model request. There is no private-address restriction or equivalent network boundary. Sourcing also fetches URLs returned by model extraction without validating them against the collected link set.

Reproduced: an authenticated generation request fetched a separate loopback HTTP listener; its synthetic internal canary reached the mocked model prompt. No real internal service or metadata endpoint was accessed.

Fix: centralize a bounded public-URL fetcher, restrict schemes, validate resolved IPv4/IPv6 destinations and redirects, and enforce the boundary at network egress where practical. Add response-size limits as well as timeouts. Restrict extracted source URLs to observed, validated candidates. A hostname substring test is insufficient.

### 6. P1: Sourcing admits duplicate work, loses refunds, and reports failures as success

Locations: `server/server.js:3141`, `server/server.js:3163`, `server/server.js:3198`, `server/server.js:2992`, `server/server.js:3008`, `source.js:666`, `source.js:726`, `source.js:778`.

The manual run guard is an in-memory map checked before asynchronous reads and updated only after spawning. The conditional debit's return value is ignored. The manual exit handler sends completion mail even on nonzero exit and never refunds. The scheduled path also ignores failed debits, stamps the schedule before durable execution exists, and does not atomically claim work.

Reproduced with real DB operations and synthetic children:

- Two manual requests, synchronized after reading a balance that funds one run, both report started; only one debit succeeds.
- Both children then fail; the spent credits remain spent and the success-email path executes.
- Dispatching the same due schedule twice starts two children and charges twice. This directly invokes the scheduler dispatch function; overlapping production schedulers were not exercised.
- The real sourcing `main` function resolves normally with no run row when Hyperbrowser is absent or when session creation fails. Consequently, even a scheduled refund keyed to nonzero process exit cannot catch these failures.

Fix: create a durable operation before spending or spawning. Atomically claim it, reserve credits once, record source outcomes, and finalize or refund once. Use leases/recovery for process death. A Postgres-backed queue is sufficient; separate infrastructure is not required merely to achieve these guarantees. Completion notifications should be derived from the committed operation outcome.

### 7. P1: Google source caching changes matching jobs into rejected jobs

Locations: `source.js:347`, `source.js:517`, `source.js:618`, `source.js:679`.

Fresh Google extraction produces scored jobs. Its cached `allScanned` list instead stores blank company names and `fit_score: 0`. Cache hits treat those raw records as the final matched jobs. Downstream filtering evaluates `(fit_score || 5) >= 6`, so every such Google cache hit fails the threshold. The nightly prefetch is intended to warm precisely these caches.

Reproduced with the real cache helpers and source reader: one matching Product Manager posting is returned from cache with score zero; zero jobs survive the acceptance filter. The cache fixture has the exact shape written by the fresh Google branch. No live Google scrape was performed.

Fix: cache raw discovery separately and always perform the same extraction/normalization/scoring pipeline afterward, or cache validated extraction with all of its relevant inputs and version. Establish cold/warm equivalence: identical inputs must produce identical eligible postings and ranking.

### 8. P1/P2: Job identity is inconsistent across writes and cache lookups

Locations: `server/db.js:237`, `server/db.js:310`, `server/server.js:1836`, `server/server.js:2481`, `server/server.js:4229`, `source.js:851`.

There are several related failures:

- The per-owner URL index correctly separates identical literal URLs between users, but `/posting` and `/posting/apply` remain two independent rows. Reproduced with contradictory new/skipped states.
- Sourcing still derives the primary key from company, role and day. Distinct posting URLs with the same slug throw Postgres 23505. Reproduced through `upsertJob`. The run summary is written before its jobs, so a failed batch can leave misleading counts.
- Kit lookup compares pathname and path prefixes while ignoring hostname and query. Reproduced: a URL on an unrelated host returns an existing kit. Embedded ATS URLs whose posting identity lives in `gh_jid` or a similar parameter can also collapse into the wrong cache entry; this query-parameter case is code-reviewed, not separately exercised.
- `/generate` still calls `setKitGenerated(url)` without its new owner argument. Reproduced: Alice's generation stamps Bob's job. `/audit/missed` similarly omits owner in `getJobByUrl`, allowing another user's existing posting to block an insert.

Fix: use one ATS-aware canonical posting identity throughout jobs, kits, cache and status operations. Preserve identity-bearing query parameters; remove only known tracking and presentation variants. Use opaque row IDs. Make omitted ownership an error rather than a global query. Backfill existing variants with explicit status-resolution rules.

### 9. P1: Model output crosses into fields that application code should own

Locations: `server/server.js:2378`, `server/server.js:2453`, `server/server.js:2142`, `extension/content.js:1040`.

Candidate evidence, instructions, scraped descriptions and ATS questions are combined in a user-message prompt. Generation validates only that an `id` exists, then saves the model's profile, ID, URL and other fields. Field-mapping output is similarly returned without a strict schema or mapping allowlist.

Reproduced using deliberately incorrect synthetic model output: an invented candidate name and changed destination URL were accepted and persisted. This establishes the missing application boundary. It does not measure whether a particular hostile posting can induce Claude to produce those values.

The actual model calls here have no general tool interface. Claims that a prompt alone can directly read unrelated database rows, steal environment keys or write evidence would overstate the evidence. The concrete risks are corrupted application content, misdirected links/field values, and the global-ID overwrite described above. No automatic model-to-evidence write was established.

Fix: build owner, ID, destination URL, contact information and verified facts deterministically. Let the model propose only bounded narrative fields and mappings for known fields, validated against a schema. Separate untrusted page content from instructions, minimize profile context, reject unknown output keys and require evidence references for factual claims. Validate all rendered output independently. Prompt hardening is an additional layer, not a replacement for those checks. See [Anthropic's prompt-injection guidance](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks).

### 10. P2: Credits and regeneration still have loss-of-value edge cases

Locations: `server/server.js:350`, `server/server.js:2337`, `server/server.js:2355`, `server/server.js:2492`, `server/server.js:2678`.

Positive controls: 32 simultaneous conditional DB deductions against 10 credits resulted in one successful 10-credit deduction and balance zero. Two simultaneous authenticated `/generate` calls against 10 credits returned one 200 and one 402. The primary reservation path does protect that race.

Remaining reproduced failures: a cached `/generate` returns 402 at zero balance because reservation precedes cache lookup; failed force regeneration deletes the old paid kit before the model succeeds. Normal cache lookup via GET still works at zero balance, so this is not a claim that every reopening flow is blocked.

Code-reviewed risks: refunds depend on the HTTP `finish` event and are best-effort asynchronous updates with no durable retry record. Disconnects, restarts and refund-write failures are not covered. Auto-tailoring checks balance, performs work, and ignores the later debit result. `/resume-tailor` swallows persistence failures while returning success. A resume's version number is incremented, but previous artifacts are overwritten rather than retained as immutable versions.

Fix: tie charges and refunds to durable operation IDs; resolve cache hits before reservation; preserve the previous artifact until replacement commits; store actual versions; finalize success only after persistence. Show the complete authorized cost, including automatic tailoring and paid field analysis.

### 11. P2: Stripe signature verification works locally, but fulfillment identity is too weak

Locations: `server/server.js:1207`, `server/db.js:450`.

Locally signed synthetic webhook requests reached the real handler. Replaying the exact event ID did not double-credit: a useful positive result after the fail-closed change. However, a completed event marked unpaid still granted credits, and two event IDs referring to the same checkout session granted credits twice.

This is not an unsigned-credit-mint exploit: all these fixtures were signed using a local fake secret. Current checkout creation explicitly allows card payments only (`server/server.js:1114`), reducing the immediate delayed-payment exposure. Live Stripe configuration and delivery behavior remain unverified.

Fix: fulfill a validated purchase/session once, check payment status, expected currency, expected product/price and purchase/account association. Keep event IDs for ingestion deduplication, but use the purchase identity for fulfillment deduplication. Test payment failure and repeated delivery as well as success. Stripe documents both [session fulfillment checks](https://docs.stripe.com/checkout/fulfillment) and [distinct events for the same object](https://docs.stripe.com/webhooks#handle-duplicate-events).

### 12. P2: Account switching leaves extension identity in memory

Locations: `extension/content.js:6`, `extension/content.js:604`, `extension/content.js:616`, `extension/popup.js:201`, `extension/background.js:6`.

Code-reviewed, not driven in Chrome: sign-out removes storage but does not clear the content script's `DEFAULTS` or `currentApp`. A replacement token rebuilds the sidebar without refetching that account's profile or kit. The background worker also reads its initial token once and does not subscribe to storage changes, although external SET_SESSION updates it. Existing tabs can therefore retain the prior person's data while the active account changes.

Fix: centralize session transitions; clear cached identity, kits and pending operations on every transition; reload only the new user's state; reject late responses from the prior session. Test Alice -> sign out -> Bob in an already-open tab with deliberately different profiles.

### 13. P2: Remaining single-user assumptions weaken product correctness

Code-reviewed examples:

- `/voice` still puts the developer's name, employers and university into every candidate's proper-noun correction prompt (`server/server.js:2808`). Removing `LOCAL_PROFILE` as a fallback did not remove all personal defaults from AI context.
- Source `main` overwrites the UI's requested roles with saved profile roles despite the environment-override comment (`source.js:254`, `source.js:636`).
- Location preferences are not applied consistently: the audit still describes only US remote or hybrid in the candidate's city; `any` does not become unrestricted (`source.js:165`, `source.js:266`).
- Google cache keys include roles but omit location preference, although that preference changes the query (`server/db.js:618`, `source.js:266`).
- `duration_ms` starts timing during saving, after sourcing and auditing finish (`source.js:849`). It is not the run duration.
- Empty runs have no durable run record. A valid zero-results search is indistinguishable in history from some failures.
- Several async Express 4 handlers can reject outside their local try/catch; the global rejection logger does not finish the HTTP response. Health also reports OK after suppressing a DB read failure (`server/server.js:2017`). Fault injection against DB outages remains needed.

These are evidence of unfinished generalization from one person's workflow. Fix or explicitly narrow supported users and use cases before presenting this as a general job-application product.

## What a stronger product approach looks like

The inferred goal is to help a candidate find suitable work and submit strong, truthful applications with less effort. Optimize for interviews and applicant trust, rather than the number of scraped links, generated words, or completed fields.

1. **Constrain the first supported workflow.** Start with a defined candidate segment and a small set of ATS platforms. Publish and test that support boundary. Broad permissions and heuristic filling do not establish reliable support for 28 platforms.
2. **Create a candidate fact store.** Preserve resume/evidence provenance, candidate corrections, verification state and unknown values. Distinguish user-provided facts, AI interpretations and job requirements. The existing interview feature is a good foundation, but questions and generated rewrites must not silently become verified experience.
3. **Make discovery deterministic where possible.** Prefer structured ATS/board feeds when available; use browser extraction as a fallback. Normalize identities and locations before deduplication. Share public discovery data, then apply user-specific eligibility and ranking with consistent cache semantics.
4. **Treat generation as an editable artifact.** Model-generated prose references supporting evidence. Unsupported claims are omitted or returned as questions. Preserve earlier versions, show meaningful changes, and require explicit confirmation for sensitive or uncertain answers before filling.
5. **Unify jobs, charges and progress.** One durable operation owns a quote, reservation, progress events, result, error and refund. The UI reads that record. A web disconnect or deployment must not change whether the customer paid or received the result.
6. **Measure quality and cost.** Track eligible new jobs per run, duplicate/dead-link rate, user correction rate, unsupported claims, form-field accuracy, time to reviewed application, and actual provider cost. Track interview outcomes where the candidate supplies them. Fit scores should have an explicit meaning and evaluated calibration; the current generation prompt restricts scores to 6-9 and is not a useful rejection mechanism.

The architecture can remain Express + Postgres + an extension. Extract a small number of shared modules for ownership, posting identity, billing/operations, provider access, and validated AI output. Add a worker with durable claims. A broad framework rewrite would consume time without proving these properties.

## Launch gates

| Gate | Required evidence |
| --- | --- |
| Isolation | Two accounts generate the same and different postings; no reads, ownership changes, aliases, status writes, HTML or audit records cross accounts. Include anonymous HTML. |
| Billing | Concurrent requests, duplicate retries, client disconnect, worker death, restart, model failure and DB-write failure each leave one explainable charge or refund per operation. Cached artifacts remain usable. |
| Sourcing | Cold and warm caches yield equivalent results; provider failure, valid zero results, partial success and duplicate postings are distinct durable outcomes. |
| Scheduling | A real staging scheduler tick runs, survives a restart, catches up around midnight, and cannot double-claim during overlapping instances. |
| Payments | Complete Stripe test checkout through actual delivery; replay and concurrent replay fulfill once; failure/unpaid cases do not credit. Validate live configuration before paid launch. |
| AI trust | Adversarial descriptions/questions cannot change IDs, owner, URL, factual profile or unauthorized mappings. A labeled candidate/posting set measures unsupported claims and useful output. |
| Extension | Real Chrome, clean install, sign-in/out/account switching, optional grants and revocation, custom domain, supported cross-origin iframe, SPA navigation, existing field values, and autosave failure/reload. |
| Operations | Tested backup restore, bounded provider calls and worker concurrency, useful readiness, persisted failure records, and a way to reconcile customer credits. |

`activeTab` provides temporary permission for the main-frame origin; it does not prove arbitrary cross-origin iframe coverage. Keep least-privilege permissions, but test and request additional origins where needed. See [Chrome's activeTab documentation](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab).

## Still not established

No live purchase, deployed cron execution, live sourcing UI session, real ATS extension run, optional-permission gesture, extension autosave interaction, production load test, backup restore, privacy/account-deletion workflow, full dependency/vendored-code security review, or real-model prompt-injection success-rate evaluation was completed. This audit does not revalidate the brief's production claims or current DNS/environment settings. The HTTP script-breakout reproduction is not a browser-executed exploit demonstration.

The existing regression suite remains valuable, but it misses several of these paths. Its empty-profile assertion calls GET `/profile`, which does not execute the generation-time `resolveProfile` merge. Its page checks verify loads and errors, not meaningful end-to-end completion. Absolute developer-machine imports and Chrome paths also prevent the advertised clone-and-run portability. The separate server smoke test still expects version 0.2.0 and is not included in the root test command.

## Reproduce

Requires local Postgres, permission to create a local database, and the installed server dependencies:

```sh
node test/adversarial-audit.cjs
```

The harness selects localhost itself and does not consume an ambient production `DATABASE_URL`. It drops only the unique database it creates and removes its temporary files afterward. It does not launch real sourcing children or call external providers.

Recommended order: contain public HTML/XSS and cross-user writes; remove invented application answers; centralize ownership and posting identity; implement durable billing/work; fix source cache equivalence; then complete the real-browser, scheduler and payment gates before inviting paid users.
