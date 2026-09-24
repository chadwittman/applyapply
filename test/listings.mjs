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
assert.match(page, /match what you are targeting/);
console.log('PASS: every listing is browsable, with what we decided about each');

// Signed out it still renders rather than erroring: it is the catalogue.
assert.equal((await fetch(origin + '/listings')).status, 200);
await db.pool.end();
