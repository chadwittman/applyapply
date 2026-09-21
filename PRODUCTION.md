# ApplyApply production-beta checklist

## Before each deploy

1. Set every value in `.env.example` in the deployment provider's encrypted secret store. Do not use local files as a secret source.
2. Run `NODE_ENV=production npm run preflight` in `server/`.
   Run `npm run check`, `npm --prefix server test`, and `npm test` on Node 22 first. Read [HARDENING.md](HARDENING.md), particularly payment cutover and migration requirements.
3. Deploy the API and extension from the same commit. The extension version must be incremented for every Chrome release.
4. Run the smoke test below against a staging account before sending traffic to production.

## Extension builds in review or in the wild

Every extension build submitted to the Chrome Web Store is tagged `store-<version>` (for example `store-1.19.3`). `npm test` re-runs the extension suites against each tagged build, so a server change that would break a build under review or already installed fails the tests. Keep server endpoints backward compatible; add fields, don't rename or remove them.

## Required production controls

- Use a managed Postgres database with automated backups and point-in-time recovery.
- Kits, revision history, run details, operation leases, progress events and credit movements are stored in Postgres. Do not run old and new server versions concurrently during the first migration. Validate backups and restore before applying it.
- Configure Stripe's webhook endpoint as `https://<app-origin>/webhook/stripe` with its signing secret. Fulfillment checks a paid session against a recorded purchase and credits it once, including distinct events for that session. Reconcile pre-upgrade checkout sessions before cutover.
- Put the app behind HTTPS. Configure `APP_ORIGIN` and `CORS_ORIGINS` to the exact public origin.
- Keep production logs free of resumes, magic links, JWTs, API keys, and Stripe payloads. Send error-only telemetry to the chosen error tracker.
- Publish a Privacy Policy, Terms of Service, and support email before inviting users. The policy must cover resume/profile processing, AI providers, retention, and account deletion.
- Do not auto-submit applications. Keep the applicant in control of all final answers and submissions.

## Smoke test

Use a non-production test user and Stripe test mode:

1. Request and consume a magic link.
2. Save a profile and upload a small PDF resume.
3. Generate a kit from a Greenhouse job. It must not auto-fill. Explicitly fill, preserve existing answers, and select Yes/No only for facts the candidate confirmed. Unknown qualifications and consent must stay unanswered.
4. Confirm credits decrease once for a successful generation and do not decrease for a failed request.
5. Complete a Stripe test checkout and replay its webhook; credits must be added only once.
6. Verify a second test user cannot retrieve the first user's profile, kit, jobs, or runs.

## Release gate

Do not open the beta until the smoke test passes, the Stripe webhook replay check passes, and a named owner is on call for support and payment failures.
