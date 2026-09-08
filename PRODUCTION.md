# ApplyApply production-beta checklist

## Before each deploy

1. Set every value in `.env.example` in the deployment provider's encrypted secret store. Do not use local files as a secret source.
2. Run `NODE_ENV=production npm run preflight` in `server/`.
3. Deploy the API and extension from the same commit. The extension version must be incremented for every Chrome release.
4. Run the smoke test below against a staging account before sending traffic to production.

## Required production controls

- Use a managed Postgres database with automated backups and point-in-time recovery.
- Use a persistent shared store for generated kits. The current `applications/` directory is suitable only for one instance; move it to Postgres or object storage before horizontal scaling.
- Configure Stripe's webhook endpoint as `https://<app-origin>/webhook/stripe` with its signing secret. The API stores Stripe event IDs transactionally so retries do not duplicate credits; verify this with Stripe's webhook replay tool before launch.
- Put the app behind HTTPS. Configure `APP_ORIGIN` and `CORS_ORIGINS` to the exact public origin.
- Keep production logs free of resumes, magic links, JWTs, API keys, and Stripe payloads. Send error-only telemetry to the chosen error tracker.
- Publish a Privacy Policy, Terms of Service, and support email before inviting users. The policy must cover resume/profile processing, AI providers, retention, and account deletion.
- Do not auto-submit applications. Keep the applicant in control of all final answers and submissions.

## Smoke test

Use a non-production test user and Stripe test mode:

1. Request and consume a magic link.
2. Save a profile and upload a small PDF resume.
3. Generate an application kit from a Greenhouse job and verify Yes/No fields are selected as options.
4. Confirm credits decrease once for a successful generation and do not decrease for a failed request.
5. Complete a Stripe test checkout and replay its webhook; credits must be added only once.
6. Verify a second test user cannot retrieve the first user's profile, kit, jobs, or runs.

## Release gate

Do not open the beta until the smoke test passes, the Stripe webhook replay check passes, and a named owner is on call for support and payment failures.
