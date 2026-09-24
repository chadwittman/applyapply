// The real text line. The interesting part is not that a text writes a kit:
// it is that the From field of a message proves nothing, so an unrecognised
// number gets a link and nothing else.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const db = require('./db.js');
const sendblue = require('./sendblue.js');
const jwt = require('jsonwebtoken');

const origin = process.env.APP_ORIGIN || 'http://localhost:5099';
const OWNER = 'textline@test.local';
const OTHER = 'textline-other@test.local';
const MINE = '+15125550123';
const STRANGER = '+15125559999';
const T = email => jwt.sign({ email }, 'e2e-test-secret-not-production', { expiresIn: '1d' });
for (const e of [OWNER, OTHER]) await db.getOrCreateUser(e);

// Numbers are read the way people write them, or not at all.
assert.equal(sendblue.normalizePhone('(512) 555-0123'), MINE);
assert.equal(sendblue.normalizePhone('512-555-0123'), MINE);
assert.equal(sendblue.normalizePhone('+1 512 555 0123'), MINE);
assert.equal(sendblue.normalizePhone('15125550123'), MINE);
for (const bad of ['', 'hello', '555-0123', null, '+0123']) assert.equal(sendblue.normalizePhone(bad), null, String(bad));

// Sendblue's field names have moved around; the ones that mean the same thing
// are all read, and our own outbound messages are not treated as inbound.
assert.deepEqual(sendblue.parseInbound({ from_number: '(512) 555-0123', content: ' hi ' }), { from: MINE, content: 'hi', media: null, isOutbound: false });
assert.equal(sendblue.parseInbound({ number: MINE, message: 'hi' }).from, MINE);
assert.equal(sendblue.parseInbound({ from_number: MINE, content: 'hi', is_outbound: true }).isOutbound, true);

const hook = body => fetch(origin + '/sendblue/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const settle = () => new Promise(r => setTimeout(r, 700));

// An unknown number reaches no account, and is told nothing about whether one
// exists. Nothing is written to anyone's thread.
const before = (await db.getChatMessages(OWNER, 0)).length;
assert.equal((await hook({ from_number: STRANGER, content: 'https://jobs.lever.co/acme/head-of-product' })).status, 200);
await settle();
assert.equal(await db.accountForPhone(STRANGER), null, 'a stranger is still nobody');
assert.equal((await db.getChatMessages(OWNER, 0)).length, before, 'and wrote into nobody\'s conversation');
console.log('PASS: an unverified number reaches no account');

// The claim it was sent is spent in a signed-in browser, once.
const code = await db.createPhoneClaim(STRANGER);
const connect = (c, email) => fetch(origin + '/text/connect', { method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T(email) }, body: JSON.stringify({ code: c }) });
assert.equal((await fetch(origin + '/text/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401,
  'signing in is the whole point of the link');
assert.equal((await connect('not-a-code', OWNER)).status, 400);
const ok = await connect(code, OWNER);
assert.equal(ok.status, 200);
assert.equal((await ok.json()).phone, STRANGER);
assert.equal((await connect(code, OTHER)).status, 400, 'a code cannot be spent twice');
assert.equal(await db.accountForPhone(STRANGER), OWNER);
console.log('PASS: a number binds only through a signed-in browser, once');

// Now that number is the account, and a text lands in its conversation.
await db.linkPhone(MINE, OWNER);
const mark = (await db.getChatMessages(OWNER, 0)).length;
await hook({ from_number: '(512) 555-0123', content: 'corrections' });
await settle();
const after = await db.getChatMessages(OWNER, 0);
assert.ok(after.length > mark, 'the message reached the conversation');
assert.ok(after.some(m => m.direction === 'in' && m.body === 'corrections'), 'and was recorded as theirs');
console.log('PASS: a verified number talks to its own account');

// STOP is honoured before anything else, and survives as a standing state.
await hook({ from_number: MINE, content: 'STOP' });
await settle();
assert.equal(await db.accountForPhone(MINE), null, 'a stopped number is not routed anywhere');
assert.equal((await db.phonesForUser(OWNER)).find(p => p.phone === MINE)?.stopped, true, 'but it is still on record, so START can lift it');
await hook({ from_number: MINE, content: 'start' });
await settle();
assert.equal(await db.accountForPhone(MINE), OWNER);
console.log('PASS: STOP and START are honoured');

// A number belongs to one account: connecting it elsewhere moves it.
await db.linkPhone(MINE, OTHER);
assert.equal(await db.accountForPhone(MINE), OTHER);
assert.deepEqual((await db.phonesForUser(OWNER)).map(p => p.phone), [STRANGER]);

// And the owner can see and remove their own numbers, but not anyone else's.
const list = await (await fetch(origin + '/text/numbers', { headers: { authorization: 'Bearer ' + T(OWNER) } })).json();
assert.deepEqual(list.numbers.map(n => n.phone), [STRANGER]);
assert.equal((await fetch(origin + '/text/numbers/' + encodeURIComponent(MINE), { method: 'DELETE', headers: { authorization: 'Bearer ' + T(OWNER) } })).status, 200);
assert.equal(await db.accountForPhone(MINE), OTHER, 'deleting a number you do not own does nothing');
await fetch(origin + '/text/numbers/' + encodeURIComponent(STRANGER), { method: 'DELETE', headers: { authorization: 'Bearer ' + T(OWNER) } });
assert.deepEqual(await db.phonesForUser(OWNER), []);
console.log('PASS: numbers belong to one account and can be removed by it');

await db.pool.end();
