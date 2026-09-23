// Placing a form field by meaning, for the labels the extension's rules miss.
const assert = require('node:assert/strict');
const path = require('node:path');
let respond = null;
require.cache[require.resolve(path.join(__dirname, '../server/typesafe'))] = { exports: { evaluate: async (_key, state, questions) => respond(state, questions) } };
const fieldMap = require('../server/field-map');

const PROFILE = { first_name: 'Alice', last_name: 'Nguyen', email: 'alice@example.com', phone: '555-0100',
  linkedin: 'https://linkedin.com/in/alice', website: '', github: '', twitter: '',
  location: 'Austin, TX', current_employer: 'Dolly', school: 'Wisconsin' };

(async () => {
  // Only pieces the profile actually holds are offered, and full name is built
  // from the two halves rather than being a stored field.
  const offered = fieldMap.valuesFor(PROFILE).map(f => f.key);
  assert.ok(offered.includes('full_name'));
  assert.ok(!offered.includes('website'), 'an empty profile value is never offered');
  assert.equal(fieldMap.valuesFor(PROFILE).find(f => f.key === 'full_name').value, 'Alice Nguyen');

  // The label that started this: "Full Name" matched no rule in the extension.
  const keyOf = (state, name) => state.available_profile_pieces.findIndex(p => p.piece === name);
  respond = (state, questions) => {
    const answers = {};
    for (const [id, q] of Object.entries(questions)) {
      const label = q.instructions.match(/labelled "([^"]+)"/)[1].toLowerCase();
      const pick = /full name|your name/.test(label) ? 'full_name'
        : /linkedin/.test(label) ? 'linkedin'
        : /based|located|city/.test(label) ? 'location'
        : null;
      answers[id] = pick ? { choice: 'k' + keyOf(state, pick), confidence: 0.94 } : { choice: 'none', confidence: 0.97 };
    }
    return { answers };
  };
  const mapped = await fieldMap.mapFields('key', ['Full Name', 'Where are you based?', 'LinkedIn Profile URL', 'Desired salary', 'Why do you want to work here?'], PROFILE);
  assert.deepEqual(mapped.map(m => [m.label, m.value]), [
    ['Full Name', 'Alice Nguyen'],
    ['Where are you based?', 'Austin, TX'],
    ['LinkedIn Profile URL', 'https://linkedin.com/in/alice'],
  ], 'identity fields placed, judgment questions left alone');

  // A guess is not an answer: below the bar, the field stays blank and the
  // candidate fills it themselves.
  respond = (state, questions) => ({ answers: Object.fromEntries(Object.keys(questions).map(id => [id, { choice: 'k0', confidence: 0.55 }])) });
  assert.deepEqual(await fieldMap.mapFields('key', ['Full Name'], PROFILE), [], 'low confidence fills nothing');

  // Nothing to offer, nothing to ask.
  respond = () => { throw new Error('should not be called'); };
  assert.deepEqual(await fieldMap.mapFields('key', ['Full Name'], {}), []);
  assert.deepEqual(await fieldMap.mapFields('key', [], PROFILE), []);
  assert.deepEqual(await fieldMap.mapFields('', ['Full Name'], PROFILE), []);

  // Eligibility and pay are never offered as choices at all.
  const keys = fieldMap.MAPPABLE.map(([k]) => k);
  for (const forbidden of ['salary', 'work_authorization', 'sponsorship', 'start_date']) {
    assert.ok(!keys.includes(forbidden), forbidden + ' must not be answerable from the profile');
  }

  console.log('PASS: fields are placed by meaning, with a confidence bar and no judgment calls');
})();
