# ApplyApply model handoff

Updated: 2026-09-21

ApplyApply is an Express/Postgres job-search product with a Chrome MV3 extension, scheduled sourcing workers, Claude generation, TypeSafe/Jev review, and Stripe credits.

## Current production

- Site: https://applyapply.xyz
- Health: https://applyapply.xyz/health
- Version: 0.27.0
- Latest commit: 69df938 (deployed successfully on Railway)
- Extension: 1.19.0 at https://applyapply.xyz/extension.zip
- Railway project/service IDs are intentionally omitted here; use the local Railway context or production notes if infrastructure work is needed.

## Recent shipped behavior

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

The 24-hour window is exact for sources exposing a posting timestamp and date-filtered for Google-indexed sources. Some indexed listings do not expose a reliable timestamp; they remain visible with pulled/window counts rather than being falsely treated as exact.

## Sensitive files excluded from the handoff archive

`.env`, `.git`, `node_modules`, `applications/`, `data/`, local databases, generated logs, and screenshots are excluded. Production credentials remain in Railway variables and must never be committed or copied into a model prompt.

## Next useful work

1. Run a real scheduled 24-hour search and inspect Sequoia's pulled/window/match counts.
2. Add source-specific timestamp confidence to the UI so users can see which sources are exact versus best-effort.
3. Continue the Google Flights-style simplification pass through profile setup and application review.
4. Finish Chrome Web Store submission and replace the unpacked-extension install flow.
