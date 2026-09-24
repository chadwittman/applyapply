// One date format across a tailored resume, without changing any fact.
// A plain hyphen: applyapply's copy does not use fancy dashes anywhere.
const assert = require('node:assert/strict');
const { normalizeDateRange, normalizeResumeDates } = require('../server/resume-dates');

// The shapes a real resume mixes, including the one that started this: a comma
// where a dash belongs.
const cases = [
  ['January 2014, January 2020', 'Jan 2014 - Jan 2020'],
  ['January 2014 - January 2020', 'Jan 2014 - Jan 2020'],
  ['Jan 2014 - Jun 2018', 'Jan 2014 - Jun 2018'],
  ['Mar 2020 - Present', 'Mar 2020 - Present'],
  ['Sept 2019 to Present', 'Sep 2019 - Present'],
  ['2016 - present', '2016 - Present'],
  ['03/2014 - 06/2018', 'Mar 2014 - Jun 2018'],
  ['2014/03 - 2018/06', 'Mar 2014 - Jun 2018'],
  ['Jan. 2014 - Dec. 2016', 'Jan 2014 - Dec 2016'],
  ['2014-2020', '2014 - 2020'],
  ['May 2020', 'May 2020'],
  ['2019', '2019'],
];
for (const [input, want] of cases) assert.equal(normalizeDateRange(input), want, input);

// A comma inside one date is not a range.
assert.equal(normalizeDateRange('January, 2014'), 'Jan 2014');
// Anything we cannot read stays exactly as written: it is still their fact.
for (const odd of ['Summer 2018', 'Q3 2019 - Q1 2021', 'various', '']) {
  assert.equal(normalizeDateRange(odd), odd, odd);
}
// Months are never invented, and a bad month number is not a month.
assert.equal(normalizeDateRange('13/2014'), '13/2014');

// Every role in a resume comes out in the same format.
const resume = { experience: [
  { company: 'Dolly', dates: 'January 2014, January 2020' },
  { company: 'EdgeRank Checker', dates: '2011 - 2014' },
  { company: 'applyapply', dates: 'Mar 2020 - Present' },
  { company: 'No dates', dates: '' },
] };
normalizeResumeDates(resume);
assert.deepEqual(resume.experience.map(e => e.dates),
  ['Jan 2014 - Jan 2020', '2011 - 2014', 'Mar 2020 - Present', '']);
const dashes = new Set(resume.experience.map(e => e.dates).filter(d => d.includes('-')).map(d => d.match(/\s(.)\s/)[1]));
assert.equal(dashes.size, 1, 'one separator across the document');
// The PDF an employer reads gets the same treatment, even for a kit written
// before any of this existed.
const { resumePdf } = require('../server/pdf');
const legacy = { name: 'Alice', summary: 's', skills: [], experience: [
  { company: 'Dolly', title: 'CEO', dates: 'January 2014, January 2020', bullets: ['Built it'] }] };
const out = resumePdf(legacy, { first_name: 'Alice' });
assert.ok(out.buffer?.length > 500, 'a PDF came out');
assert.equal(legacy.experience[0].dates, 'Jan 2014 - Jan 2020', 'and its dates were normalised on the way in');
console.log('PASS: resume dates read as one document, and unreadable ones are left alone');
