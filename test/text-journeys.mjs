// Real persistent conversation state with a local paid-operation boundary.
// No provider calls or real messages. Assert requests and actual credit debits.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const db = require('./db');
const conversation = require('./conversation');
const { explicitAction } = require('./text-actions');
const { parseUpdates, digestWindow } = require('./text-updates');
const email = 'journeys@test.local';
const url = 'https://jobs.lever.co/journeys/product';
const calls = [];
let failDelivery = false;
const deliveries = [];

await db.getOrCreateUser(email);
await db.pool.query('UPDATE users SET credits=100 WHERE email=$1', [email]);
await db.setProfile(email, { bio: 'Product leader. Managed six people directly.', target_functions: 'product', target_seniority: 'director' }, true);
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const owner = req.headers.authorization.slice(7);
    calls.push({ path: req.url, owner, body });
    let data = {};
    if (req.url === '/generate') {
      assert.equal(await db.chargeCredits(owner, 10, 'journey-kit'), true);
      data = { id: 'journey-' + calls.length, user_email: owner, url: body.url, company: 'Acme', role: 'Director of Product',
        job_description: 'Manage a product team and launch consumer products.', tailored: { qa: [], cover_note: 'letter', why_role: 'fit' },
        tailored_resume: { coverage: { gaps: ['Managed a team', 'Launched a consumer product'] } } };
      await db.saveKit(data);
      await db.ensureJob({ id: data.id, user_email: owner, url: body.url, company: 'Acme', role: 'Director of Product', status: 'new' });
    } else if (req.url === '/resume-tailor') {
      assert.equal(await db.chargeCredits(owner, 8, 'journey-rewrite'), true);
      data = { evidence_used: 2, coverage: { gaps: [] } };
    } else if (req.url === '/auth/me') data = await db.getUser(owner);
    else if (req.url === '/source/status') data = { counts: {} };
    else if (req.url === '/profile') await db.setProfile(owner, body, true);
    else if (req.url === '/source/catalog') data = [{ name: 'One', on: true, credits: 3 }, { name: 'Two', on: true, credits: 4 }];
    else if (req.url === '/source/run') { await db.chargeCredits(owner, 7, 'journey-search'); data = { sources: body.sources }; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data));
  } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const opts = { db, port: server.address().port, origin: 'https://applyapply.test', signToken: e => e,
  kitLink: async () => 'test-kit-link-1234',
  deliver: async (_email, body) => { if (failDelivery) throw new Error('offline'); deliveries.push(body); return 'sent-' + deliveries.length; } };
let chat = conversation(opts);
const last = async () => (await db.recentChatMessages(email)).find(m => m.direction === 'out');
const paid = () => calls.filter(c => ['/generate', '/resume-tailor', '/source/run'].includes(c.path));

try {
  for (const text of ['do not write it', "don't write it", 'should i write it?', 'write a poem', 'what would it cost to write it?']) assert.equal(explicitAction(text, 'write'), false, text);
  assert.equal(explicitAction('write the first one', 'write'), true);
  await chat.handle(email, url, { handle: 'link-1' });
  assert.equal(paid().length, 0);
  assert.match((await last()).body, /10 credits/);
  chat = conversation(opts); // Restart between proposal and consent.
  await chat.handle(email, 'yes', { handle: 'yes-1' });
  assert.equal(paid().length, 1);
  assert.equal((await db.getUser(email)).credits, 90);
  assert.match((await last()).body, /test-kit-link-1234/);
  await chat.handle(email, 'yes', { handle: 'yes-1' });
  assert.equal((await last()).meta.kind, 'resume_offer', 'duplicate webhook is not a new answer');
  await chat.handle(email, '👍', { reaction: { kind: 'like' }, about: { url: url + '-other' } });
  assert.equal(paid().length, 1, 'a reaction on a role cannot buy a kit');
  console.log('PASS: price before spending, persistent consent, duplicate and reaction protection');

  await chat.handle(email, 'yes');
  assert.equal((await last()).meta.kind, 'gap_question');
  await chat.handle(email, 'I managed six people directly.');
  await chat.handle(email, 'Launched a consumer app with 20,000 customers.');
  assert.equal(paid().length, 1, 'answering never auto-rewrites');
  assert.match((await last()).body, /saved 2 answers/);
  await chat.handle(email, 'yes');
  assert.equal(paid().at(-1).path, '/resume-tailor');
  assert.equal((await db.getUser(email)).credits, 82);
  assert.ok(!deliveries.some(s => /% match/.test(s)));
  console.log('PASS: answers are free and the rewrite is separately authorized');

  await chat.handle(email, url + '-later');
  const pendingOffer = await last();
  await chat.handle(email, 'yes', { replyId: pendingOffer.id - 1, about: { url: url + '-different-role' } });
  assert.equal(paid().length, 2, 'replying to another role cannot accept the current offer');
  await chat.handle(email, url + '-later');
  await chat.handle(email, 'credits');
  await chat.handle(email, 'yes');
  assert.equal(paid().length, 2, 'yes after an interruption is ambiguous');
  await chat.handle(email, 'continue');
  assert.match((await last()).body, /10 credits/);
  await chat.handle(email, 'not now');
  assert.equal(paid().length, 2);
  await chat.handle(email, 'write it ' + url + '-next');
  assert.equal(paid().length, 3, 'clear repeat request uses previously accepted price');
  await chat.handle(email, 'yes');
  await chat.handle(email, 'pause');
  await chat.handle(email, 'credits');
  await chat.handle(email, 'continue');
  assert.match((await last()).body, /Managed a team/);
  console.log('PASS: interruptions do not consume stale offers, questions resume');

  await chat.handle(email, url + '-unasked');
  await chat.handle(email, 'not now');
  const beforeAgent = paid().length;
  let rounds = 0;
  chat = conversation({ ...opts, callModel: async () => {
    if (++rounds === 1) return { content: [{ type: 'tool_use', id: 'bad', name: 'write_kit', input: { url: url + '-unasked' } }] };
    throw new Error('model failed after calling a tool');
  } });
  await chat.handle(email, 'hmm');
  assert.equal(paid().length, beforeAgent, 'even a rogue tool call cannot spend');
  assert.match((await last()).body, /reply "yes"/);
  console.log('PASS: model failure or unrequested tool use preserves the confirmation');

  chat = conversation(opts);
  failDelivery = true;
  await chat.handle(email, 'write it ' + url + '-delivery');
  assert.ok((await last()).meta.delivery_failed);
  const afterFailure = paid().length;
  failDelivery = false;
  await chat.handle(email, 'did you finish?');
  assert.match((await last()).body, /test-kit-link-1234/);
  assert.equal(paid().length, afterFailure, 'recovering delivery does not regenerate or charge');
  console.log('PASS: generated work survives delivery failure and is recoverable free');

  await chat.handle(email, 'search');
  assert.match((await last()).body, /7 credits/);
  assert.equal(paid().length, afterFailure);
  await chat.handle(email, 'yes');
  assert.deepEqual(paid().at(-1).body.sources, ['One', 'Two']);
  await chat.handle(email, 'only remote');
  assert.equal((await db.getProfileByUserEmail(email)).location_pref, 'remote');
  await chat.handle(email, 'more like the second one', { about: { url: 'https://example.test/role', role: 'Senior Product Manager', company: 'Example' } });
  assert.equal((await last()).meta.kind, 'preference_offer');
  await chat.handle(email, 'yes');
  assert.equal((await db.getProfileByUserEmail(email)).target_seniority, 'senior');
  console.log('PASS: exact search price and explicit durable preference changes');

  const fresh = 'journey-new@test.local';
  await db.getOrCreateUser(fresh);
  await chat.handle(fresh, url + '-onboard');
  await chat.handle(fresh, 'yes');
  assert.equal((await db.lastChatMeta(fresh, 'needs_profile')).meta.url, url + '-onboard');
  assert.ok(!paid().some(c => c.owner === fresh), 'missing resume never generates placeholders');
  const claim = await db.createPhoneClaim('+15125550998', url + '-onboard');
  const context = await db.spendPhoneClaim(claim, true);
  assert.equal(context.pending_url, url + '-onboard');
  assert.equal(await db.spendPhoneClaim(claim, true), null);
  console.log('PASS: onboarding retains the posting and requires real background');

  assert.equal(parseUpdates('daily at 3am central'), null);
  assert.equal(parseUpdates('daily at 9am nonsense'), null);
  const prefs = parseUpdates('weekdays at 9am central');
  assert.equal(digestWindow(prefs, new Date('2026-09-25T14:30:00Z')), '2026-09-25');
  assert.equal(digestWindow(prefs, new Date('2026-09-26T14:30:00Z')), null);
  assert.equal(digestWindow({ ...prefs, last_sent: '2026-09-25' }, new Date('2026-09-25T14:30:00Z')), null);
  await db.linkPhone('+15125550997', email);
  await chat.handle(email, 'daily at 9am central');
  assert.ok((await db.textSubscribers()).some(s => s.user_email === email));
  await chat.handle(email, 'updates off');
  assert.ok(!(await db.textSubscribers()).some(s => s.user_email === email));
  const sent = deliveries.length;
  await chat.notifySearchDone(email, 3, { scheduled: true });
  assert.equal(deliveries.length, sent, 'scheduled searches cannot bypass digest opt-in');
  console.log('PASS: opt-in update cadence, local time, quiet hours and unsubscribe');

  const digestUser = 'journey-digest@test.local';
  await db.getOrCreateUser(digestUser);
  await db.setProfile(digestUser, { target_functions: 'product', target_seniority: 'director', location_pref: 'remote' }, true);
  await db.linkPhone('+15125550996', digestUser);
  const digestJobs = ['A', 'B', 'C', 'D', 'Skipped', 'Onsite'].map(company => ({ company, role: 'Director of Product', url: 'https://jobs.lever.co/digest/' + company, location: company === 'Onsite' ? 'New York' : 'Remote' }));
  await db.ensureJob({ ...digestJobs[4], id: 'digest-skipped', user_email: digestUser, status: 'skipped' });
  const digestChat = conversation({ ...opts, ledgerMatches: async owner => owner === digestUser ? digestJobs : [] });
  await db.setTextUpdates(digestUser, parseUpdates('daily at 9am central'));
  const digestStart = deliveries.length;
  const future = new Date('2030-09-25T14:05:00Z');
  await digestChat.sendDigests(future);
  const digest = deliveries.slice(digestStart);
  assert.equal(digest.filter(m => /^\d\)/.test(m)).length, 3, 'digest offers at most three roles');
  assert.ok(!digest.some(m => /skipped|onsite/i.test(m)), 'preferences and prior decisions apply to the shared ledger');
  await digestChat.sendDigests(future);
  assert.equal(deliveries.length - digestStart, 5, 'only one digest per local date, including after repeated ticks');
  assert.ok(!paid().some(c => c.owner === digestUser), 'digest cannot start paid work');
  await db.setPhoneStopped('+15125550996', true);
  assert.ok(!(await db.textSubscribers()).some(s => s.user_email === digestUser), 'STOP suppresses proactive messages');
  console.log('PASS: digest delivery is bounded, respects preferences and STOP, and never spends');

  const discussStart = paid().length;
  const discussionChat = conversation({ ...opts, readPosting: async () => 'The role manages six people.', askModel: async () => 'your management experience fits. location eligibility still needs checking.' });
  await discussionChat.handle(email, 'what do you think of ' + url + '-discussion?');
  assert.equal(paid().length, discussStart);
  assert.match((await last()).body, /management experience fits/);
  assert.equal((await last()).meta.kind, 'role_context');
  console.log('PASS: asking about a posting gets a discussion without a purchase');

  await db.addChatMessage(email, 'out', 'choose a role', { kind: 'matches', jobs: digestJobs.slice(0, 2) });
  const beforeApplied = calls.filter(c => c.path === '/sourced/status').length;
  await chat.handle(email, 'sent it');
  assert.equal(calls.filter(c => c.path === '/sourced/status').length, beforeApplied, 'ambiguous sent it cannot mark an older kit applied');
  assert.match((await last()).body, /which role did you apply to/);
  await chat.handle(email, url + '-price');
  const beforePrice = paid().length;
  await conversation({ ...opts, kitCost: 12 }).handle(email, 'yes');
  assert.equal(paid().length, beforePrice);
  assert.match((await last()).body, /12 credits/, 'a price change requires fresh consent');
  await chat.handle(email, 'write the application for an unlisted company');
  assert.equal(paid().length, beforePrice, 'an unknown named target must not resolve to the previous role');
  assert.match((await last()).body, /which role/);
  console.log('PASS: ambiguous applied reports and changed prices cannot silently act');
} finally {
  await new Promise(r => server.close(r));
  await db.pool.end();
}
