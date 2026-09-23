// Corrections: the candidate's own statements about themselves, which outrank
// their resume, bio and saved answers in everything written afterwards.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const db = require('./db.js');
const jwt = require('jsonwebtoken');

const origin = process.env.APP_ORIGIN || 'http://localhost:5099';
const EMAIL = 'facts@test.local';
const T = jwt.sign({ email: EMAIL }, 'e2e-test-secret-not-production', { expiresIn: '1d' });
const auth = { 'content-type': 'application/json', authorization: 'Bearer ' + T };
await db.getOrCreateUser(EMAIL);

assert.equal((await fetch(origin + '/facts')).status, 401);

const add = text => fetch(origin + '/facts', { method: 'POST', headers: auth, body: JSON.stringify({ text }) });
assert.equal((await add('')).status, 400);
assert.equal((await add('x'.repeat(601))).status, 400);
assert.equal((await add('I have never sold a company.')).status, 200);
await add('  I have   never sold a company. '); // same fact, whitespace apart
const list = await (await fetch(origin + '/facts', { headers: auth })).json();
assert.equal(list.facts.length, 1, 'the same correction is not stored twice');
assert.equal(list.facts[0].text, 'I have never sold a company.');
console.log('PASS: a correction is saved once, trimmed, and refused when empty or huge');

// Another account cannot see or remove it.
const other = jwt.sign({ email: 'other@test.local' }, 'e2e-test-secret-not-production', { expiresIn: '1d' });
await db.getOrCreateUser('other@test.local');
const theirs = await (await fetch(origin + '/facts', { headers: { authorization: 'Bearer ' + other } })).json();
assert.equal(theirs.facts.length, 0);
await fetch(origin + '/facts/' + list.facts[0].id, { method: 'DELETE', headers: { authorization: 'Bearer ' + other } });
assert.equal((await (await fetch(origin + '/facts', { headers: auth })).json()).facts.length, 1, 'someone else cannot delete it');

await fetch(origin + '/facts/' + list.facts[0].id, { method: 'DELETE', headers: auth });
assert.equal((await (await fetch(origin + '/facts', { headers: auth })).json()).facts.length, 0);
console.log('PASS: corrections are private to the account and removable');

// The text line records one without any menu: "remember: ..." then it is on record.
const send = text => fetch(origin + '/imessage/send', { method: 'POST', headers: auth, body: JSON.stringify({ text }) });
const sent = await send('remember: I have never sold a company');
if (sent.status < 300) {
  await new Promise(r => setTimeout(r, 1200));
  const saved = await db.getFacts(EMAIL);
  assert.equal(saved.length, 1, 'the text line saved the correction');
  const msgs = await db.getChatMessages(EMAIL, 0).catch(() => []);
  assert.ok(msgs.some(m => m.direction === 'out' && /written against that/.test(m.body)), 'it confirms in plain words');
  await send('corrections'); // the list, not a new correction named "s"
  await new Promise(r => setTimeout(r, 200));
  assert.equal((await db.getFacts(EMAIL)).length, 1, '"corrections" lists, it does not record');
  await new Promise(r => setTimeout(r, 800));
  const after = await db.getChatMessages(EMAIL, 0).catch(() => []);
  assert.ok(after.some(m => /never sold a company/.test(m.body) && /forget 1/.test(m.body)), 'it lists them with a way to drop one');
  console.log('PASS: remember / corrections work over text');
}

await db.pool.end();
