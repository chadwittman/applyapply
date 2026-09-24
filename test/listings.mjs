// "2,790 pulled, 4 fit" is not something anybody should have to take on trust.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const db = require('./db.js');
const jwt = require('jsonwebtoken');
const origin = process.env.APP_ORIGIN;
const EMAIL = 'listings@test.local';
const T = jwt.sign({ email: EMAIL }, 'e2e-test-secret-not-production', { expiresIn: '1d' });
await db.getOrCreateUser(EMAIL);
await db.setProfile(EMAIL, { target_functions: 'product', target_seniority: 'director, exec' }, true);
await db.upsertListings('We Work Remotely', [
  { url: 'https://example.com/a', company: 'Watershed', role: 'Head of Product', location: 'Remote', posted_at: new Date().toISOString() },
  { url: 'https://example.com/b', company: 'Acme', role: 'Staff Software Engineer', location: 'NYC', posted_at: new Date().toISOString() },
  { url: 'https://example.com/c', company: 'Orb', role: 'Technical Recruiter', location: 'SF', posted_at: new Date().toISOString() },
]);

const page = await (await fetch(origin + '/listings', { headers: { authorization: 'Bearer ' + T } })).text();
// Everything pulled is here, not only what matched.
for (const company of ['Watershed', 'Acme', 'Orb']) assert.ok(page.includes(company), company + ' is listed');
assert.match(page, /Every listing we hold/);
// And each carries what we decided about it, so a miss is visible rather than silent.
assert.match(page, /"c":"Watershed"[^}]*"f":true/, 'the product role fits');
assert.match(page, /"c":"Acme"[^}]*"f":false/, 'the engineering role does not');
assert.match(page, /"c":"Orb"[^}]*"f":false/, 'and the recruiter role is nobody\'s target');
assert.match(page, /fit what you are looking for/, 'it says how many fit');
// The page opens on everything. A first view that can be empty is how a page
// holding twelve thousand jobs looks broken.
assert.match(page, /<option value="all">All jobs<\/option>\s*<option value="fit">/, 'all jobs is the default option');
// And somebody who has not said what they want is told that, not shown zero.
const anon = await (await fetch(origin + '/listings')).text();
assert.match(anon, /Sign in.*to see which ones fit you/s);
console.log('PASS: every listing is browsable, with what we decided about each');

// Boards list one job once per location. That is one job to a reader.
await db.upsertListings('Himalayas', [
  { url: 'https://example.com/d1', company: 'Bjak', role: 'Mobile Engineer', location: 'Remote, Malaysia', posted_at: new Date().toISOString() },
  { url: 'https://example.com/d2', company: 'Bjak', role: 'Mobile Engineer', location: 'Remote, Thailand', posted_at: new Date().toISOString() },
  { url: 'https://example.com/d3', company: 'bjak', role: 'mobile engineer', location: 'Remote, Vietnam', posted_at: new Date().toISOString() },
]);
const grouped = await (await fetch(origin + '/listings', { headers: { authorization: 'Bearer ' + T } })).text();
const rows = JSON.parse(grouped.match(/var ROWS = (\[[\s\S]*?\]);\n/)[1]);
const bjak = rows.filter(r => r.c.toLowerCase() === 'bjak');
assert.equal(bjak.length, 1, 'one job, not three: ' + JSON.stringify(bjak.map(r => r.l)));
assert.equal(bjak[0].n, 3, 'and it says how many postings it stands for');
assert.equal(bjak[0].places.length, 3, 'with where they are');
assert.ok(bjak[0].fs, 'and when we first saw it');
assert.match(grouped, /postings, since boards list one job once per location/);
console.log('PASS: one role posted in three places is one job, dated from first sight');

// Signed out it still renders rather than erroring: it is the catalogue.
assert.equal((await fetch(origin + '/listings')).status, 200);
await db.pool.end();
