// The remaining per-user surfaces: kits, resumes, profiles, and the
// destructive /clear.
import { createRequire } from 'module';
const require = createRequire('/Users/chaztyler/job-search/server/package.json');
const jwt = require('jsonwebtoken');
const db = require('/Users/chaztyler/job-search/server/db.js');
const B = 'http://localhost:5099';
const T = e => jwt.sign({ email: e }, 'e2e-test-secret-not-production', { expiresIn: '1d' });
const A = T('alice@test.local'), Bo = T('bob@test.local');
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const call = async (m, p, t, body) => {
  const r = await fetch(B + p, { method: m, headers: { ...(t ? { 'x-api-key': t } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, d };
};

for (const e of ['alice@test.local', 'bob@test.local']) { await db.getOrCreateUser(e); await db.addUserCredits(e, 200); }
await db.saveKit({ id: 'alice-kit', url: 'https://x.test/a', company: 'AliceCo', role: 'PM',
                   user_email: 'alice@test.local', tailored: { why_role: 'secret' }, created_at: new Date().toISOString() });
// setProfile keys on api_key unless told the key is an email.
await db.setProfile('alice@test.local', { first_name: 'Alice', bio: 'alice bio', resume_text: 'ALICE RESUME' }, true);
await db.setProfile('bob@test.local', { first_name: 'Bob', bio: 'bob bio' }, true);

console.log('\n── kits ──');
ok('alice reads her kit', (await call('GET', '/application?url=' + encodeURIComponent('https://x.test/a'), A)).d?.id === 'alice-kit');
const steal = await call('GET', '/application?url=' + encodeURIComponent('https://x.test/a'), Bo);
ok('bob cannot read it', steal.status >= 400 || !steal.d?.id, `status ${steal.status} id ${steal.d?.id}`);
const byId = await call('GET', '/application/alice-kit', Bo);
ok('bob cannot read it by id', byId.status >= 400 || !byId.d?.id, `status ${byId.status}`);
ok('bob kit list is empty', ((await call('GET', '/applications', Bo)).d || []).length === 0);
ok('alice kit list has 1', ((await call('GET', '/applications', A)).d || []).length === 1);

console.log('\n── profile ──');
ok('alice profile is hers', (await call('GET', '/profile', A)).d?.first_name === 'Alice');
ok('bob profile is his', (await call('GET', '/profile', Bo)).d?.first_name === 'Bob');
await call('POST', '/profile', Bo, { first_name: 'Bobby' });
ok('bob write did not touch alice', (await call('GET', '/profile', A)).d?.first_name === 'Alice');
ok('partial write kept bob bio', (await call('GET', '/profile', Bo)).d?.bio === 'bob bio');
ok('partial write kept alice resume_text', (await call('GET', '/profile', A)).d?.resume_text === 'ALICE RESUME');

console.log('\n── a profile never inherits somebody else\'s identity ──');
// The extension and the server both used to carry one real person's name,
// email and phone as fallbacks, so a new account with gaps in its profile got
// those values written into its applications.
await db.getOrCreateUser('empty@test.local');
const E = T('empty@test.local');
const ep = (await call('GET', '/profile', E)).d || {};
const LEAK = /wittman|Wittman|920-378|chadwittman|ELDRICK/;
ok('empty account gets an empty profile', !LEAK.test(JSON.stringify(ep)), JSON.stringify(ep).slice(0, 80));
await call('POST', '/profile', E, { first_name: 'Dana' });
const partial = (await call('GET', '/profile', E)).d || {};
ok('partial profile stays partial', partial.first_name === 'Dana' && !partial.phone, JSON.stringify(partial).slice(0, 90));
ok('no leaked identity anywhere in it', !LEAK.test(JSON.stringify(partial)));

console.log('\n── /clear is scoped and authenticated ──');
ok('anonymous /clear -> 401', (await call('POST', '/clear', null)).status === 401);
await call('POST', '/clear', Bo, {});
ok('bob clearing did not delete alice kit', ((await call('GET', '/applications', A)).d || []).length === 1);

console.log(`\n${'─'.repeat(46)}\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
