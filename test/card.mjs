// The card a kit link unfurls to, and the tags that point at it. In Messages
// this is most of what a person sees before they tap.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const db = require('./db.js');
const card = require('./card.js');
const jwt = require('jsonwebtoken');
const origin = process.env.APP_ORIGIN || 'http://localhost:5099';
const EMAIL = 'card@test.local';
const T = jwt.sign({ email: EMAIL }, 'e2e-test-secret-not-production', { expiresIn: '1d' });
await db.getOrCreateUser(EMAIL);
await db.saveKit({ id: 'cardkit', user_email: EMAIL, url: 'https://jobs.lever.co/acme/head-of-product',
  company: 'Watershed', role: 'Head of Product, Climate Platform',
  tailored: { cover_note: 'Dear team', qa: [{ q: 'Why?', a: 'Because' }, { q: 'When?', a: '' }] },
  tailored_resume: { name: 'A', summary: 's', experience: [], skills: [], jev_match: { score: 4.1 } } });

// Long titles wrap rather than overflow, and what does not fit is marked.
assert.equal(card.wrap('Head of Product', 68, 900, 2).length, 1);
const many = card.wrap('Director of Product Management for Enterprise Platform and Developer Experience Worldwide', 68, 900, 2);
assert.equal(many.length, 2);
assert.match(many[1], /…$/, 'a title too long to fit says so');
assert.deepEqual(card.piecesFor({ tailored: { cover_note: 'x', qa: [{ q: 'a', a: 'b' }] }, tailored_resume: {} }),
  ['Tailored resume', 'Cover note', '1 answer', 'PDFs']);

const link = await (await fetch(origin + '/kit-link', { method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T },
  body: JSON.stringify({ appId: 'cardkit' }) })).json();
const token = String(link.kit_url || '').split('/k/')[1];
assert.ok(token, 'a kit link was issued: ' + JSON.stringify(link));

const page = await (await fetch(origin + '/k/' + token)).text();
assert.match(page, /og:image/);
assert.match(page, new RegExp('/k/' + token + '/card\\.png'), 'the card is the kit\'s own');
assert.match(page, /og:title" content="Head of Product, Climate Platform at Watershed/);
assert.match(page, /82% match/, 'the description says what the kit is worth');
assert.match(page, /summary_large_image/);

const img = await fetch(origin + '/k/' + token + '/card.png');
assert.equal(img.status, 200);
assert.equal(img.headers.get('content-type'), 'image/png');
const bytes = Buffer.from(await img.arrayBuffer());
assert.ok(bytes.length > 3000, 'a real image, not a placeholder: ' + bytes.length);
assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
console.log('PASS: a kit link unfurls with its own card, drawn for that job');

// An expired or invented token gives the brand card, never an error and never
// somebody else's kit.
const missing = await fetch(origin + '/k/doesnotexist/card.png');
assert.equal(missing.status, 200);
assert.equal(missing.headers.get('content-type'), 'image/png');
console.log('PASS: an unknown link still previews, with nothing private in it');
await db.pool.end();
