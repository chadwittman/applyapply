// Full end-to-end suite against a locally running server on a scratch database.
// Covers the defect classes this project keeps producing: endpoints that treat
// "nobody" as "everybody", and two users sharing one row.
import { createRequire } from 'module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const jwt = require('jsonwebtoken');
const db = require('./db.js');
const B = process.env.APP_ORIGIN || 'http://localhost:5099';
const SECRET = 'e2e-test-secret-not-production';
const tok = e => jwt.sign({ email: e }, SECRET, { expiresIn: '1d' });
const ALICE = tok('alice@test.local'), BOB = tok('bob@test.local');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  (cond ? pass++ : fail++);
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const call = async (m, p, t, body) => {
  const r = await fetch(B + p, {
    method: m,
    headers: { ...(t ? { 'x-api-key': t } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, d };
};

// Seed: each user sources the SAME posting, as they would from a shared board.
const SHARED = 'https://job-boards.greenhouse.io/shared/jobs/1';
const base = { id: 'shared-pm', url: SHARED, company: 'Shared Co', role: 'Product Manager',
               found_at: new Date().toISOString(), status: 'new' };
await db.upsertJob({ ...base, user_email: 'alice@test.local' });
await db.upsertJob({ ...base, user_email: 'bob@test.local' });
await db.upsertJob({ id: 'alice-only', url: 'https://x.test/alice', company: 'AliceCo', role: 'PM',
                     found_at: new Date().toISOString(), status: 'new', user_email: 'alice@test.local' });

console.log('\n── 1. every user-scoped endpoint rejects an anonymous caller ──');
for (const [m, p] of [['GET','/sourced'],['GET','/sourced/counts'],['GET','/runs'],['GET','/applied'],
                      ['GET','/status'],['GET','/coverage'],['GET','/source/status'],['GET','/source/log'],
                      ['GET','/profile'],['GET','/credits'],['GET','/schedule'],['GET','/interview'],
                      ['GET','/applications'],['GET','/audit/data'],['GET','/audit/feedback'],
                      ['GET','/resume/meta'],['GET','/source/stream']]) {
  const r = await call(m, p, null);
  ok(`${m} ${p} anonymous -> 401`, r.status === 401, `got ${r.status}`);
}

console.log('\n── 2. mutations reject an anonymous caller ──');
for (const [p, body] of [['/sourced/status', { url: SHARED, status: 'skipped' }],
                         ['/sourced/skip', { url: SHARED }],
                         ['/sourced/mark-applied', { url: SHARED }],
                         ['/sourced/mark-reviewed', { ids: ['shared-pm'] }],
                         ['/applied', { appId: 'x', url: SHARED }],
                         ['/track/open', { url: SHARED }],
                         ['/audit/feedback', { url: SHARED, feedback: 'bad' }]]) {
  const r = await call('POST', p, null, body);
  ok(`POST ${p} anonymous -> 401`, r.status === 401, `got ${r.status}`);
}

console.log('\n── 3. two users, one posting: both own a copy ──');
const aList = await call('GET', '/sourced', ALICE);
const bList = await call('GET', '/sourced', BOB);
ok('alice sees her 2 jobs', aList.d?.length === 2, `got ${aList.d?.length}`);
ok('bob sees his 1 job', bList.d?.length === 1, `got ${bList.d?.length}`);
ok('bob does not see alice-only', !bList.d?.some(j => j.url === 'https://x.test/alice'));

console.log('\n── 4. one user\'s status change does not touch the other\'s copy ──');
await call('POST', '/sourced/status', ALICE, { url: SHARED, status: 'applied' });
const aAfter = (await call('GET', '/sourced', ALICE)).d.find(j => j.url === SHARED);
const bAfter = (await call('GET', '/sourced', BOB)).d.find(j => j.url === SHARED);
ok('alice copy is applied', aAfter?.status === 'applied', `got ${aAfter?.status}`);
ok('bob copy is untouched', bAfter?.status === 'new', `got ${bAfter?.status}`);

console.log('\n── 5. a user cannot mutate a job they do not own ──');
const steal = await call('POST', '/sourced/status', BOB, { url: 'https://x.test/alice', status: 'skipped' });
ok('bob mutating alice job -> 404', steal.status === 404, `got ${steal.status}`);
const aliceOnly = (await call('GET', '/sourced', ALICE)).d.find(j => j.url === 'https://x.test/alice');
ok('alice job still new', aliceOnly?.status === 'new', `got ${aliceOnly?.status}`);

console.log('\n── 6. coverage and counts are per-user ──');
const aCov = await call('GET', '/coverage', ALICE), bCov = await call('GET', '/coverage', BOB);
ok('alice total 2', aCov.d?.total === 2, `got ${aCov.d?.total}`);
ok('bob total 1', bCov.d?.total === 1, `got ${bCov.d?.total}`);

console.log('\n── 7. saving a schedule for a time already past does not fire now ──');
const now = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()).split(':').map(Number);
const pastH = (now[0] + 23) % 24;
await call('POST', '/schedule', ALICE, { hour: pastH, minute: 0, enabled: true });
const due = await db.getDueSchedules(now[0], now[1]);
ok('not immediately due', !due.some(r => r.user_email === 'alice@test.local'), `due rows: ${due.length}`);

// The failure this guards: at 00:20, a schedule saved for 23:00 reads as
// "later today" by the clock, while the due query reads the most recent 23:00
// as last night — an hour inside its catch-up window — and charges for a run
// nobody asked for. True at any hour, so the test says so at any hour.
for (const [h, m] of [[23, 0], [0, 5], [12, 30], [now[0], (now[1] + 59) % 60]]) {
  await call('POST', '/schedule', ALICE, { hour: h, minute: m, enabled: true });
  const rows = await db.getDueSchedules(now[0], now[1]);
  ok(`saving ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} does not fire now`,
    !rows.some(r => r.user_email === 'alice@test.local'), `due rows: ${rows.length}`);
}

console.log('\n── 8. a missed tick still gets picked up ──');
await db.setSchedule('bob@test.local', { hour: now[0], minute: now[1], enabled: true, sources: null }, false);
const due2 = await db.getDueSchedules(now[0], now[1] + 1 > 59 ? now[1] : now[1] + 1);
ok('bob is due after his minute passed', due2.some(r => r.user_email === 'bob@test.local'), `due rows: ${due2.length}`);

console.log(`\n${'─'.repeat(52)}\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
