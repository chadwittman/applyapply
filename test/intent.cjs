// Reading what a text means, for everything the command list does not cover.
const assert = require('node:assert/strict');
const path = require('node:path');
let respond = null;
require.cache[require.resolve(path.join(__dirname, '../server/typesafe'))] = { exports: { evaluate: async (_k, state, questions) => respond(state, questions) } };
const { readIntent, pickFromList, factFrom } = require('../server/intent');

const LISTED = [{ company: 'Watershed', role: 'Head of Product' }, { company: 'Orb', role: 'Director of Product' }, { company: 'Ramp', role: 'Growth PM' }];

(async () => {
  respond = (state) => {
    const m = String(state.message).toLowerCase();
    const pick = /anything good|what do you have|show me/.test(m) ? 'matches'
      : /go look|find me|search/.test(m) ? 'search'
      : /watershed|first one/.test(m) ? 'pick'
      : /never|actually i/.test(m) ? 'remember'
      : /how much|cost/.test(m) ? 'credits'
      : 'none';
    return { answers: { intent: { choice: pick, confidence: pick === 'none' ? 0.9 : 0.92 } } };
  };
  for (const [text, want] of [
    ['anything good today?', 'matches'],
    ['can you go look for product roles', 'search'],
    ['do the watershed one', 'pick'],
    ['actually i never worked at google', 'remember'],
    ['how much does this cost', 'credits'],
    ['the weather is nice', null],
  ]) {
    const got = await readIntent('key', text, { listed: LISTED });
    assert.equal(got?.intent ?? null, want, text);
  }

  // A guess is not an instruction: below the bar we would rather say what we do.
  respond = () => ({ answers: { intent: { choice: 'search', confidence: 0.6 } } });
  assert.equal(await readIntent('key', 'hmm', {}), null, 'low confidence does nothing');

  // Without a key, or a message, nothing is asked of anybody.
  respond = () => { throw new Error('should not be called'); };
  assert.equal(await readIntent('', 'anything good?', {}), null);
  assert.equal(await readIntent('key', '', {}), null);
  assert.equal(await readIntent('key', 'x'.repeat(2001), {}), null);

  // A failure is quiet: the menu is a fine fallback, an error is not.
  respond = () => { throw new Error('TypeSafe down'); };
  assert.equal(await readIntent('key', 'anything good?', {}), null);

  // The model says they are picking; code works out which, because a name
  // match is exact and a guess about money is not.
  assert.equal(pickFromList('do the watershed one', LISTED), 0);
  assert.equal(pickFromList('ramp please', LISTED), 2);
  assert.equal(pickFromList('the second one', LISTED), 1);
  assert.equal(pickFromList('the first', LISTED), 0);
  assert.equal(pickFromList('none of those', LISTED), -1);

  // A correction reads as a fact, without the lead-in.
  assert.equal(factFrom('just so you know, I have never sold a company'), 'I have never sold a company');
  assert.equal(factFrom('remember: I left Dolly in 2024'), 'I left Dolly in 2024');
  assert.equal(factFrom('FYI I am based in Austin'), 'I am based in Austin');
  assert.equal(factFrom('I have two kids'), 'I have two kids');
  console.log('PASS: a text is read for what it asks, and a guess is never acted on');
})();
