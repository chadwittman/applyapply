// Targeting by function and level. The old model gated on exact titles, so a
// wording nobody typed was never seen at all; this one decides what a title is
// and lets the person filter afterwards.
const assert = require('node:assert/strict');
const { classify, targetPreferences, targetMatcher, FUNCTION_NAMES, BANDS } = require('../server/roles');

const fn = t => classify(t).functions;
const band = t => classify(t).seniority;

// The function, whatever the wording.
for (const t of ['Head of Product', 'Director, Product Management', 'Group Product Manager', 'Founding PM',
  'Principal Product Manager', 'Chief Product Officer', 'Product Owner']) {
  assert.ok(fn(t).includes('product'), t + ' is a product job');
}
// A word another function owns does not steal the title.
assert.deepEqual(fn('Product Marketing Manager'), ['marketing'], 'PMM is marketing, not product');
assert.deepEqual(fn('Product Designer'), ['design']);
assert.ok(fn('Product Engineer').includes('engineering') && !fn('Product Engineer').includes('product'));
// A title that is honestly two jobs reaches both people.
assert.deepEqual(fn('VP Product & Growth').sort(), ['growth', 'product']);
assert.deepEqual(fn('Head of Growth Marketing').sort(), ['growth', 'marketing']);
// Not anybody's target here.
for (const t of ['Technical Recruiter', 'Staff Nurse', 'Marketing Intern', 'General Counsel']) {
  assert.deepEqual(fn(t), [], t + ' is filtered out entirely');
}

// Level, including the one that matters most: a PM is an IC, an Engineering
// Manager manages.
assert.equal(band('Product Manager'), 'ic');
assert.equal(band('Senior Product Manager'), 'senior');
assert.equal(band('Group Product Manager'), 'director');
assert.equal(band('Head of Product'), 'director');
assert.equal(band('VP of Product'), 'exec');
assert.equal(band('Engineering Manager'), 'lead');
console.log('PASS: titles classify into function and level, compounds and all');

// Targeting two functions is two words, not twenty titles.
const m = targetMatcher({ target_functions: 'product, growth' });
for (const t of ['Head of Product', 'Growth Product Manager', 'Director of Growth', 'GPM, Payments', 'VP Product & Growth']) {
  assert.equal(m.test(t), true, t + ' reaches someone targeting product and growth');
}
for (const t of ['Product Marketing Manager', 'Staff Software Engineer', 'Technical Recruiter']) {
  assert.equal(m.test(t), false, t + ' does not');
}

// A level narrows, and an explicit title still always gets through.
const senior = targetMatcher({ target_functions: 'product', target_seniority: 'director, exec', target_roles: 'Founding PM' });
assert.equal(senior.test('Head of Product'), true);
assert.equal(senior.test('Product Manager'), false, 'an IC role is out of the band');
assert.equal(senior.test('Founding PM'), true, 'a title they named always gets through');

// An account from before this existed keeps working, and gets wider recall
// than the titles it listed rather than narrower.
const old = targetPreferences({ target_roles: 'Head of Product, VP of Growth' });
assert.equal(old.derived, true);
assert.deepEqual(old.functions.sort(), ['growth', 'product']);
assert.ok(old.bands.includes('exec') && old.bands.includes('director'));
assert.ok(old.bands.includes('lead'), 'one band below what they listed, since a floor is not a ceiling');
assert.equal(targetMatcher({ target_roles: 'Head of Product' }).test('Group Product Manager'), true,
  'the wording they never typed now reaches them');

// Nothing set means nothing matches: silence beats a firehose.
assert.equal(targetMatcher({}).test('Head of Product'), false);
// Career type alone is enough to search on.
assert.deepEqual(targetPreferences({ career_type: 'growth' }).functions, ['growth']);

assert.ok(FUNCTION_NAMES.includes('product') && BANDS.length === 5);
console.log('PASS: functions and levels target broadly, titles boost, old accounts widen');
