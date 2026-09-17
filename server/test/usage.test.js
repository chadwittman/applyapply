const test = require('node:test');
const assert = require('node:assert/strict');
const usage = require('../usage');

test('provider usage is isolated per request context', async () => {
  const request = usage.begin();
  await request.run(async () => {
    usage.record('anthropic', { input_tokens: 120, output_tokens: 30 });
    usage.record('anthropic', { input_tokens: 10, output_tokens: 5 });
  });
  assert.deepEqual(request.snapshot().anthropic, { calls: 2, input_tokens: 130, output_tokens: 35 });
});

test('usage outside a request context is ignored', () => {
  usage.record('anthropic', { input_tokens: 999, output_tokens: 999 });
});
