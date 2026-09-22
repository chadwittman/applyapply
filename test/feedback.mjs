// "Make this better" notes and unreadable-posting alerts: both saved and mailed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const db = require('./db');
const origin = process.env.APP_ORIGIN;
const page = await fetch(origin + '/feedback').then(r => r.text());
assert.match(page, /Make this better/);
assert.equal((await fetch(origin + '/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'no' }) })).status, 400);
const r = await fetch(origin + '/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'The Q&A answers repeat themselves on Workday jobs.', page: '/pipeline' }) });
assert.equal(r.status, 200);
const rows = await db.pool.query("SELECT kind, message, context, user_email FROM feedback ORDER BY id DESC LIMIT 1");
assert.equal(rows.rows[0].kind, 'idea');
assert.match(rows.rows[0].message, /Workday/);
console.log('PASS: feedback is saved from the page, short notes refused');

// A posting we cannot read is reported once a day per site.
const { addFeedback, feedbackSeenToday } = db;
await addFeedback({ kind: 'unreadable_posting', message: 'x', context: { fingerprint: 'careers.example' } });
assert.equal(await feedbackSeenToday('unreadable_posting', 'careers.example'), true);
assert.equal(await feedbackSeenToday('unreadable_posting', 'other.example'), false);
console.log('PASS: unreadable postings are reported once per site per day');
await db.pool.end();
