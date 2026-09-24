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
assert.deepEqual(sendblue.parseInbound({ from_number: '(512) 555-0123', content: ' hi ' }),
  { from: MINE, content: 'hi', media: null, handle: null, isOutbound: false, reaction: null });
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

// ── Verifying by holding the phone, instead of by email ──────────────────────
// The code goes to the number and the session says who asked: one proves the
// phone, the other proves the account, and neither is enough alone.
const CODE_PHONE = '+15125550777';
const smsCode = await db.createPhoneCode(CODE_PHONE, OWNER);
assert.match(smsCode, /^\d{6}$/);

// It is never stored where a database read would reveal it.
const stored = await db.pool.query('SELECT code_hash FROM phone_codes WHERE phone=$1', [CODE_PHONE]);
assert.notEqual(stored.rows[0].code_hash, smsCode);
assert.equal(stored.rows[0].code_hash.length, 64);

// Wrong guesses are bounded, and burn the code rather than the patience.
for (let i = 0; i < 5; i++) assert.equal((await db.checkPhoneCode(CODE_PHONE, '000000')).ok, false);
assert.equal((await db.checkPhoneCode(CODE_PHONE, smsCode)).reason, 'too_many', 'the right code does not save a burnt one');

// A fresh code works exactly once.
const again = await db.createPhoneCode(CODE_PHONE, OWNER);
assert.equal((await db.checkPhoneCode(CODE_PHONE, again)).user_email, OWNER);
assert.equal((await db.checkPhoneCode(CODE_PHONE, again)).reason, 'none', 'and cannot be replayed');

// Asking again replaces the pending code rather than leaving two that work.
const first = await db.createPhoneCode(CODE_PHONE, OWNER);
const second = await db.createPhoneCode(CODE_PHONE, OWNER);
assert.equal((await db.checkPhoneCode(CODE_PHONE, first)).ok, false, 'the older code stops working');
assert.equal((await db.checkPhoneCode(CODE_PHONE, second)).ok, true);

// Over HTTP: signing in is still required, and a code raised by one account
// cannot be confirmed by another.
const confirm = (phone, c, email) => fetch(origin + '/text/verify/confirm', { method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T(email) }, body: JSON.stringify({ phone, code: c }) });
assert.equal((await fetch(origin + '/text/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
const mine = await db.createPhoneCode(CODE_PHONE, OWNER);
assert.equal((await confirm(CODE_PHONE, mine, OTHER)).status, 400, 'a code for one account does not connect another');
const good = await db.createPhoneCode(CODE_PHONE, OWNER);
assert.equal((await confirm('(512) 555-0777', good, OWNER)).status, 200, 'and reads the number however it is typed');
assert.equal(await db.accountForPhone(CODE_PHONE), OWNER);
console.log('PASS: a number is verified by holding it, with the account proved separately');

// ── Voice and first contact ──────────────────────────────────────────────────
// Nobody wants to be asked for homework by something they just connected, so
// the first message carries roles rather than instructions.
const { getChatMessages } = db;
await db.linkPhone('+15125550444', OWNER);
const beforeHi = (await getChatMessages(OWNER, 0)).length;
await hook({ from_number: '+15125550444', content: 'hello' });
await new Promise(r => setTimeout(r, 1200));
const greeting = (await getChatMessages(OWNER, 0)).slice(beforeHi).find(m => m.direction === 'out');
assert.ok(greeting, 'a hello is answered');
assert.match(greeting.body, /applyapply/);
assert.ok(!/^Send me a job link/i.test(greeting.body), 'and does not open by asking for a link');
// Lower case, and short enough to read on a lock screen.
const letters = greeting.body.replace(/[^a-z]/gi, '');
const caps = letters.replace(/[^A-Z]/g, '').length;
assert.ok(caps / letters.length < 0.05, `the voice is lower case (${caps} capitals in ${letters.length})`);
console.log('PASS: a greeting brings roles, in applyapply\'s voice');

// A tapback is an instruction. 👍 on an offer is yes, 👎 is not now.
assert.equal(sendblue.readReaction({ content: '👍' }).kind, 'emoji');
assert.equal(sendblue.readReaction({ content: 'Liked "your kit is ready"' }).kind, 'like');
assert.equal(sendblue.readReaction({ content: 'send me the kit' }), null, 'ordinary text is not a reaction');
assert.equal(sendblue.parseInbound({ from_number: MINE, content: 'hi', message_handle: 'H-1' }).handle, 'H-1');
console.log('PASS: tapbacks are read as instructions, text is not');

await db.pool.end();
