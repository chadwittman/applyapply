// Deciding what a title is: kept once per distinct wording, with the word
// rules answering for anything not decided yet.
const assert = require('node:assert/strict');
const path = require('node:path');
let respond = null, calls = 0;
require.cache[require.resolve(path.join(__dirname, '../server/typesafe'))] = { exports: { evaluate: async (_k, _s, questions) => { calls++; return respond(questions); } } };
const { classifyNewTitles, classifierFor, key } = require('../server/title-class');

const store = new Map();
const db = {
  getTitleClasses: async () => new Map(store),
  saveTitleClasses: async entries => { for (const e of entries) store.set(e.key, { functions: e.functions, band: e.band, decidedBy: e.decidedBy }); return entries.length; },
};

(async () => {
  // Jev reads the title; the rules are what it improves on.
  respond = questions => {
    const answers = {};
    for (const [id, q] of Object.entries(questions)) {
      const title = q.instructions.match(/titled "([^"]+)"/)[1];
      if (id.startsWith('f')) {
        const choice = /gtm|partnership/i.test(title) ? 'sales' : /product/i.test(title) ? 'product' : 'none';
        answers[id] = { choice, confidence: choice === 'none' ? 0.95 : 0.93 };
      } else {
        answers[id] = { choice: /head|director/i.test(title) ? 'director' : 'ic', confidence: 0.9 };
      }
    }
    return { answers };
  };
  const titles = ['AWS GTM Partnership Lead, Enterprise', 'Head of Product', 'Staff Nurse, Oncology'];
  const first = await classifyNewTitles(db, 'key', titles);
  assert.equal(first.decided, 3);
  const place = classifierFor(await db.getTitleClasses());

  // The systematic error the rules make, corrected and kept.
  assert.deepEqual(place('AWS GTM Partnership Lead, Enterprise').functions, ['sales'], 'GTM partnerships is sales, not growth');
  assert.deepEqual(place('Head of Product').functions, ['product']);
  assert.equal(place('Head of Product').seniority, 'director');
  assert.deepEqual(place('Staff Nurse, Oncology').functions, [], 'a different profession is placed nowhere');

  // Decided once. The same titles again cost nothing, and a different casing
  // or spacing is the same title.
  const before = calls;
  const second = await classifyNewTitles(db, 'key', ['Head of Product', 'head of  product', 'AWS GTM Partnership Lead, Enterprise']);
  assert.equal(second.decided, 0, 'nothing re-decided');
  assert.equal(calls, before, 'and nothing re-requested');
  assert.equal(key('Head of Product'), key('head of  product'));
  console.log('PASS: titles are decided once, kept, and matched regardless of wording');

  // Whatever goes wrong, the rules still answer.
  respond = () => { throw new Error('TypeSafe is down'); };
  const failed = await classifyNewTitles(db, 'key', ['Senior Product Manager, Payments']);
  assert.equal(failed.decided, 0);
  const still = classifierFor(await db.getTitleClasses());
  assert.deepEqual(still('Senior Product Manager, Payments').functions, ['product'], 'the rules carry it');
  assert.equal(still('Senior Product Manager, Payments').decidedBy, 'rules');
  assert.deepEqual((await classifyNewTitles(db, '', ['Anything'])).skipped, 'no TypeSafe key');
  console.log('PASS: a failed or absent classifier leaves the word rules in charge');
})();
