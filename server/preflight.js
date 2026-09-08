#!/usr/bin/env node

// Safe to run in CI or immediately before deployment. It validates presence and
// shape only; secrets are never printed.
const required = [
  'APP_ORIGIN',
  'CORS_ORIGINS',
  'DATABASE_URL',
  'APPLYAPPLY_JWT_SECRET',
  'ANTHROPIC_API_KEY',
  'RESEND_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_ID',
  'APPLYAPPLY_ADMIN_SECRET',
];

const missing = required.filter(name => !process.env[name]);
const errors = [];
if (process.env.NODE_ENV !== 'production') errors.push('NODE_ENV must be production');
if (process.env.APPLYAPPLY_JWT_SECRET === 'development-only-secret') errors.push('APPLYAPPLY_JWT_SECRET must not use the development value');

for (const name of ['APP_ORIGIN', 'CORS_ORIGINS']) {
  for (const value of (process.env[name] || '').split(',').filter(Boolean)) {
    try {
      const url = new URL(value.trim());
      if (url.protocol !== 'https:') errors.push(`${name} must use https in production`);
    } catch {
      errors.push(`${name} contains an invalid URL`);
    }
  }
}

if (missing.length || errors.length) {
  console.error('ApplyApply production preflight failed.');
  if (missing.length) console.error(`Missing: ${missing.join(', ')}`);
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log('ApplyApply production preflight passed.');
