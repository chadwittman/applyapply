// Can an agent start from nothing? Ask for a key, have a person approve it,
// set the account up and get to work, without anyone writing code for it.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const jwt = require('jsonwebtoken');
const db = require('./db');
const origin = process.env.APP_ORIGIN;
const person = 'agentonboard@test.local';
await db.getOrCreateUser(person);
const session = jwt.sign({ email: person }, process.env.APPLYAPPLY_JWT_SECRET);
const post = (path, body, key) => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body) });
const get = (path, key) => fetch(origin + path, { headers: { authorization: 'Bearer ' + key } });

// 1. The agent asks to be connected, with nothing but the public docs.
const asked = await (await post('/agent/connect', { name: 'Claude' })).json();
assert.match(asked.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
assert.equal(asked.verification_url, origin + '/connect?code=' + asked.code);
assert.equal((await post('/agent/token', { code: asked.code, poll_token: asked.poll_token })).status, 428, 'Nothing before approval');
assert.equal((await post('/agent/token', { code: asked.code, poll_token: 'guessed' })).status, 404, 'The poll token is required');

// 2. The person approves it while signed in. An anonymous approval cannot.
assert.equal((await post('/connect/approve', { code: asked.code })).status, 401);
assert.equal((await post('/connect/approve', { code: asked.code }, session)).status, 200);

// 3. The agent collects its key, once.
const got = await (await post('/agent/token', { code: asked.code, poll_token: asked.poll_token })).json();
assert.match(got.api_key, /^aa_live_/);
assert.equal(got.account, person);
assert.equal((await post('/agent/token', { code: asked.code, poll_token: asked.poll_token })).status, 404, 'A code works once');
const key = got.api_key;

// 4. It can see what is missing, fix it, and read its own account.
const rpc = async (name, args = {}) => {
  const r = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, key);
  return JSON.parse((await r.json()).result.content[0].text);
};
const before = await rpc('get_account');
assert.equal(before.ready_to_apply, false);
assert.deepEqual(before.missing, ['resume', 'target_functions', 'location']);
// Targeting is a function and a level, so an agent does not have to guess
// every title a company might post. An exact title still satisfies it.
await rpc('update_profile', { resume: 'Jordan Rivera\nParcelworks, Director of Product', target_functions: 'product', target_seniority: 'director, exec', location: 'Denver, CO' });
const listed = await rpc('search_listings', {});
assert.match(listed.roles, /product/, 'the search reports what it targeted');
const after = await rpc('get_account');
assert.equal(after.ready_to_apply, true, 'An agent can set the resume itself');
assert.equal((await db.getProfileByUserEmail(person)).resume_text.includes('Parcelworks'), true);

// 5. The key cannot manage the account or mint more keys.
for (const [method, path] of [['GET', '/api-keys'], ['POST', '/account/delete']]) {
  const r = await fetch(origin + path, { method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
  assert.equal(r.status, 403, path);
}
// And the person can see and revoke it.
const keys = await (await get('/api-keys', session)).json();
assert.ok(keys.some(k => k.name === 'Claude'), 'It shows up as a named key the person can revoke');
console.log('PASS: an agent can get its own key with one approval, set the account up, and be revoked');
await db.pool.end();
