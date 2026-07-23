# applyapply

AI-powered job search tool: a Chrome extension that auto-fills job applications, backed by a Node.js server that handles AI generation, a credit system, and Stripe payments.

## Structure

- `extension/` — Chrome extension (load unpacked in Chrome locally)
- `server/` — Express API server (runs on Replit, port 5000)
- `source.js` — Job sourcing agent (uses Hyperbrowser + Claude to scrape job boards)
- `open-new.js` — CLI utility to open sourced jobs as Chrome tabs

## Running the server

```
cd server && npm start
```

The server runs on port 5000. When running on Replit, the extension should point to the Replit dev domain URL instead of `http://localhost:3747`.

## Required secrets

- `ANTHROPIC_API_KEY` — for AI generation (required)
- `STRIPE_SECRET_KEY` — for Stripe checkout (optional)
- `STRIPE_WEBHOOK_SECRET` — for Stripe webhook verification (optional)
- `APPLYAPPLY_ADMIN_SECRET` — for admin endpoints (optional)
- `HYPERBROWSER_API_KEY` — for the job sourcing agent (optional)

## Extension setup

1. Open Chrome → `chrome://extensions`
2. Enable Developer mode
3. Load Unpacked → select the `extension/` folder
4. In the extension settings, update the server URL from `http://localhost:3747` to your Replit dev domain (e.g. `https://your-repl.replit.dev`)

## User preferences
