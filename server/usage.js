const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

function begin() {
  const usage = { anthropic: { calls: 0, input_tokens: 0, output_tokens: 0 }, openrouter: { calls: 0, input_tokens: 0, output_tokens: 0 } };
  return { usage, snapshot() { return JSON.parse(JSON.stringify(usage)); }, run(fn) { return storage.run(usage, fn); } };
}

function record(provider, data) {
  const current = storage.getStore();
  if (!current || !data || typeof data !== 'object') return;
  const bucket = current[provider] || (current[provider] = { calls: 0, input_tokens: 0, output_tokens: 0 });
  bucket.calls++;
  bucket.input_tokens += Number(data.input_tokens || data.prompt_tokens || 0);
  bucket.output_tokens += Number(data.output_tokens || data.completion_tokens || 0);
}

module.exports = { begin, record };
