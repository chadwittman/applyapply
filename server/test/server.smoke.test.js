const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:password@127.0.0.1:65432/applyapply';
process.env.APPLYAPPLY_JWT_SECRET = 'test-session-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.APP_ORIGIN = 'https://applyapply.example';
process.env.CORS_ORIGINS = 'https://applyapply.example';

const { app } = require('../server');

let server;
let origin;

test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

test('health endpoint reports a healthy service', async () => {
  const response = await fetch(`${origin}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.version, '0.2.0');
});

test('resume parsing requires an authenticated user', async () => {
  const response = await fetch(`${origin}/resume/parse`, { method: 'POST' });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Sign in required' });
});

test('API only grants CORS access to configured web origins', async () => {
  const response = await fetch(`${origin}/health`, {
    headers: { Origin: 'https://applyapply.example' },
  });
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://applyapply.example');
});

test('API rejects a browser origin that is not configured', async () => {
  const response = await fetch(`${origin}/health`, {
    headers: { Origin: 'https://untrusted.example' },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Origin not allowed' });
});
