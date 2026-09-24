// What happens to dashes in model output. This has broken twice: once by
// turning an em dash into a period, which chopped clauses into fragments, and
// once when a bulk edit rewrote the pattern itself into a hyphen, which put a
// period inside every date range.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../server/server.js'), 'utf8');
// eslint-disable-next-line no-eval
eval(source.match(/function cleanEmDashes\(obj\)[\s\S]*?\n}\n/)[0]);

// An em dash is a comma, not a full stop: a period here makes fragments.
assert.equal(cleanEmDashes('Led the team — 12 engineers — through a replatform.'),
  'Led the team, 12 engineers, through a replatform.');
assert.equal(cleanEmDashes('Grew revenue 4x – from 2M to 8M – in 18 months.'),
  'Grew revenue 4x, from 2M to 8M, in 18 months.');
assert.ok(!cleanEmDashes('a — b').includes('.'), 'no period is invented');

// Hyphens are left alone. Date ranges, compound words and ranges all use them.
for (const kept of ['Jan 2014 - Jan 2020', '2014 - 2020', 'Took it 0-to-1', 'well-known, full-time', 'Series A - Series C']) {
  assert.equal(cleanEmDashes(kept), kept, kept);
}

// No doubled or floating punctuation comes out of it.
assert.equal(cleanEmDashes('one — , two'), 'one, two');
assert.equal(cleanEmDashes('ends here — .'), 'ends here.');
assert.equal(cleanEmDashes('  padded — out  '), 'padded, out');

// It reaches into the shapes a kit actually arrives in.
const kit = cleanEmDashes({ summary: 'A — B', experience: [{ bullets: ['C — D', 'plain-hyphen stays'] }] });
assert.equal(kit.summary, 'A, B');
assert.deepEqual(kit.experience[0].bullets, ['C, D', 'plain-hyphen stays']);

// The patterns are written as escapes, so a search and replace over the file
// cannot quietly change what they match.
const fn = source.match(/function cleanEmDashes\(obj\)[\s\S]*?\n}\n/)[0];
assert.ok(fn.includes('\\u2014') && fn.includes('\\u2013'), 'dashes are escapes, not literal characters');
assert.ok(!/replace\(\/\\s\*-\\s\*\//.test(fn), 'and the pattern never matches a plain hyphen');
console.log('PASS: em dashes become commas, hyphens and date ranges survive');
