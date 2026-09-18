const API = 'https://api.typesafe.ai/v1/systemone';

async function evaluate(apiKey, state, questions) {
  if (!apiKey) throw new Error('TypeSafe API key is not configured');
  const response = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'jev-latest', state, questions }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.text();
  let data;
  try { data = JSON.parse(body); } catch { data = null; }
  if (!response.ok) throw new Error(`TypeSafe API error ${response.status}: ${body.slice(0, 240)}`);
  if (!data?.answers || typeof data.answers !== 'object') throw new Error('TypeSafe returned no typed answers');
  return data;
}

module.exports = { evaluate };
