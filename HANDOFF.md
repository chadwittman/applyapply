# ApplyApply model handoff

Updated: 2026-09-21

ApplyApply is an Express/Postgres job-search product with a Chrome MV3 extension, scheduled sourcing workers, Claude generation, TypeSafe/Jev review, and Stripe credits.

## Current production

- Site: https://applyapply.xyz
- Health: https://applyapply.xyz/health
- Version: 0.32.0
- Latest commit: 917440f (deployed successfully on Railway)
- Extension: 1.19.3, submitted to the Chrome Web Store 2026-09-21 and tagged `store-1.19.3`. `npm test` re-runs the extension suites against every `store-*` tag; keep server routes backward compatible. at https://applyapply.xyz/extension.zip
- Railway project/service IDs are intentionally omitted here; use the local Railway context or production notes if infrastructure work is needed.

## Recent shipped behavior

- Listings ledger (`listings`, `ingest_state`): a shared ingest runs every 6 hours and at startup (`JAA_INGEST=1 node source.js`); a first pull or weekly refresh takes everything listed, and later pulls take the last 24 hours. User runs read the ledger and only ingest a source themselves if it is over 8 hours stale (advisory lock per source).
- Sources: a16z and Sequoia (browser), plus Himalayas, We Work Remotely and Hacker News "Who is hiring" (plain HTTP, `server/feeds.js`). The six Google-search sources are retired: Google CAPTCHAs every automated search, stealth sessions included. Remotive was tried and dropped.
- A run fails only if every source fails; failed sources are refunded in the commit transaction (`partial_refund` in credit_ledger). An unreadable job page is checked from its listing instead of failing the run.
- Role matching is word-based (`server/roles.js`) and rejects titles naming another function.
- Agent access: personal API keys (`aa_live_…`, hashed) in Profile & settings, MCP server at `/mcp` (`server/mcp.js`), docs at `/agents`, `/llms.txt`.
- New accounts get 30 starter credits (`STARTER_CREDITS`), once per address via credit_ledger. Account deletion was broken (magic_links column) and is fixed.
- /terms and /support are live; the privacy policy lists TypeSafe and Chrome speech recognition.

- Sequoia sourcing fixed (it had been returning 0 jobs): the search API takes the page's own CSRF token and pages through results, and the window is applied by posting day because Sequoia stamps are date-only.
- a16z reads exact `<time datetime>` stamps from the page and stops paging once past the 24-hour window.
- The shared source cache key includes the search window, and the nightly prefetch warms each window in use.
- The run view labels each source's window: exact 24h, by posting day, some undated, or best-effort 24h (Google).

- Extension is toolbar-first: job pages open the sidebar; unrelated pages open the pipeline. Opening never generates or charges.
- Sourcing has focused steps for one-time searches and automatic hunting, with Only / Select all / None source controls.
- Scheduled sourcing supports Last 24 hours or All currently listed.
- Run emails distinguish one-time searches from scheduled searches and explain pulled/window/new/filtered results.
- Sequoia's current CSRF bootstrap/API path is supported with a DOM fallback.
- Profile settings include account export and typed-confirmation account deletion.
- Privacy policy states no advertising use or general-model training and matches extension behavior.

## Verify locally

```sh
npm install
npm --prefix server install
npm run check
npm test
```

Tests require local Postgres and Chrome. `test/run.sh` creates a throwaway database. Do not run against production.

## Important open caveat

Google-indexed sources rely on Google's `after:` date filter and are labeled best-effort in the UI. Board sources report their own precision per run.

## Sensitive files excluded from the handoff archive

`.env`, `.git`, `node_modules`, `applications/`, `data/`, local databases, generated logs, and screenshots are excluded. Production credentials remain in Railway variables and must never be committed or copied into a model prompt.

## Next useful work

1. Company-level ATS feeds: Greenhouse, Lever and Ashby have public per-company job APIs; the ledger's a16z/Sequoia apply URLs give a list of company boards to poll directly.
2. Replace pdf-parse 1.1.1 (random "bad XRef entry" on ~1 in 20 parses; currently retried three times).
3. Continue the Google Flights-style simplification pass through profile setup and application review.
2. Finish Chrome Web Store submission (needs 1280x800 screenshots; listing copy and promo tiles are ready) and replace the unpacked-extension install flow.
