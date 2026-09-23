// An assistant installing applyapply the way claude.ai, ChatGPT or Grok do:
// discover, register itself, have the person approve, exchange the code.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const jwt = require('jsonwebtoken');
const db = require('./db');
const origin = process.env.APP_ORIGIN;
const person = 'oauth@test.local';
await db.getOrCreateUser(person);
const session = jwt.sign({ email: person }, process.env.APPLYAPPLY_JWT_SECRET);
const json = async (path, options) => { const r = await fetch(origin + path, options); return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) }; };
const post = (path, body, key) => json(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) }, body: JSON.stringify(body) });

// 1. Discovery: an unauthenticated call to /mcp says where to sign in.
const challenge401 = await fetch(origin + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
assert.equal(challenge401.status, 401);
assert.match(challenge401.headers.get('www-authenticate'), /resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource"/);
const resource = await json('/.well-known/oauth-protected-resource');
assert.equal(resource.body.resource, origin + '/mcp');
assert.deepEqual(resource.body.authorization_servers, [origin]);
const server = await json('/.well-known/oauth-authorization-server');
assert.deepEqual(server.body.code_challenge_methods_supported, ['S256']);
assert.equal(server.body.registration_endpoint, origin + '/oauth/register');

// 2. The assistant registers itself.
const registered = await post('/oauth/register', { client_name: 'Grok', redirect_uris: ['https://grok.com/connectors/callback'] });
assert.equal(registered.status, 201);
assert.match(registered.body.client_id, /^aac_/);
assert.equal((await post('/oauth/register', { client_name: 'Bad', redirect_uris: ['javascript:alert(1)'] })).status, 400, 'Dangerous return addresses refused');

// 3. The person approves in their browser (PKCE S256).
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const authorize = `/oauth/authorize?response_type=code&client_id=${registered.body.client_id}&redirect_uri=${encodeURIComponent('https://grok.com/connectors/callback')}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`;
const consent = await fetch(origin + authorize);
assert.equal(consent.status, 200);
const consentHtml = await consent.text();
assert.match(consentHtml, /Connect Grok/);
assert.match(consentHtml, /cannot submit an application/);

const wrongAddress = await fetch(origin + authorize.replace(encodeURIComponent('https://grok.com/connectors/callback'), encodeURIComponent('https://evil.example/steal')));
assert.equal(wrongAddress.status, 400, 'An unregistered return address is refused, not redirected to');

assert.equal((await post('/oauth/approve', { client_id: registered.body.client_id, redirect_uri: 'https://grok.com/connectors/callback', code_challenge: challenge })).status, 401, 'Approval needs the person');
const approved = await post('/oauth/approve', { client_id: registered.body.client_id, redirect_uri: 'https://grok.com/connectors/callback', state: 'xyz', code_challenge: challenge }, session);
assert.equal(approved.status, 200);
const back = new URL(approved.body.redirect_to);
assert.equal(back.origin + back.pathname, 'https://grok.com/connectors/callback');
assert.equal(back.searchParams.get('state'), 'xyz');
const code = back.searchParams.get('code');

// 4. The token exchange: only with the matching verifier, and only once.
const exchange = body => post('/oauth/token', { grant_type: 'authorization_code', redirect_uri: 'https://grok.com/connectors/callback', client_id: registered.body.client_id, ...body });
assert.equal((await exchange({ code, code_verifier: 'wrong-verifier' })).status, 400, 'PKCE is enforced');
const token = await exchange({ code, code_verifier: verifier });
assert.equal(token.status, 200);
assert.match(token.body.access_token, /^aa_live_/);
assert.equal(token.body.token_type, 'Bearer');
assert.equal((await exchange({ code, code_verifier: verifier })).status, 400, 'A code works once');

// 5. The token works on /mcp, and the person can see and revoke it.
const call = await fetch(origin + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token.body.access_token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
assert.equal((await call.json()).result.tools.length > 10, true);
const keys = await (await fetch(origin + '/api-keys', { headers: { 'x-api-key': session } })).json();
assert.ok(keys.some(k => k.name === 'Grok'), 'It appears as a revocable key named after the assistant');
await post('/oauth/revoke', { token: token.body.access_token });
const afterRevoke = await fetch(origin + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token.body.access_token }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
assert.equal(afterRevoke.status, 401, 'Revoking stops it immediately');
console.log('PASS: an assistant can discover, register, be approved, exchange with PKCE, and be revoked');
await db.pool.end();
