# ApplyApply model-swap handoff

_Last updated: 2026-09-14_

## Current deployment

- Railway project: `remarkable-education`
- Service: `applyapply`
- Environment: `production`
- Public API: `https://applyapply-production.up.railway.app`
- Health check: `https://applyapply-production.up.railway.app/health`
- Database: Railway Postgres, connected through `DATABASE_URL`
- Current provider detected by `/health`: Anthropic

## Current model configuration

The server supports Anthropic through `ANTHROPIC_API_KEY` and OpenRouter through
`OPENROUTER_API_KEY`. The server currently reports Anthropic as the active
provider when the Anthropic key is present.

Do not put API keys, webhook secrets, JWT secrets, or payment credentials in
this file or in Git.

## Model swap checklist

1. Decide whether the new model is accessed through Anthropic or OpenRouter.
2. Update the corresponding Railway variable through Railway Variables.
3. If the code needs a model identifier, update the model constant/config in
   `server/server.js` and commit it.
4. Redeploy the `applyapply` service.
5. Verify `/health` and generate a test application kit.
6. Confirm that credits are deducted only once and that Yes/No fields remain
   structured selections.

## Extension

- Current extension version: `1.9.2`
- Cloud API URL: `https://applyapply-production.up.railway.app`
- Latest local ZIP: `dist/applyapply-extension-1.9.2.zip`
- Downloads copy: `~/Downloads/applyapply-extension-1.9.2.zip`

## Git handoff

- Repository: `https://github.com/chadwittman/applyapply.git`
- Branch: `main`
- Latest extension commit: `fd5473e`

