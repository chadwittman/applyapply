// One date format across a tailored resume.
//
// The rewrite copies company, title and dates verbatim, on purpose: those are
// facts and the model must not invent them. But a resume written over ten
// years carries however many formats the person happened to use that year —
// "January 2014, January 2020" against "Mar 2020 – Present" — and the copy
// preserves the mess faithfully. Parsing them here keeps the facts exactly as
// written while making them look like one document.
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DASH = '-';

const PRESENT = /^(present|current(ly)?|now|today|ongoing|to date)$/i;

function monthIndex(word) {
  const w = String(word || '').toLowerCase().replace(/\.$/, '');
  if (!w) return -1;
  // "sept" is common and is not a three-letter prefix of "september".
  const exact = MONTHS.findIndex(m => m === w);
  if (exact >= 0) return exact;
  return MONTHS.findIndex(m => m.startsWith(w) && w.length >= 3);
}

// One endpoint of a range: a month and a year, a year, or "Present".
function parsePoint(text) {
  const t = String(text || '').trim().replace(/[.,]+$/, '');
  if (!t) return null;
  if (PRESENT.test(t)) return { present: true };

  let m = t.match(/^([A-Za-z]{3,9})\.?,?\s+((?:19|20)\d{2})$/);
  if (m && monthIndex(m[1]) >= 0) return { month: monthIndex(m[1]), year: Number(m[2]) };

  m = t.match(/^((?:19|20)\d{2})[/-](\d{1,2})$/); // 2014-03
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { month: Number(m[2]) - 1, year: Number(m[1]) };

  m = t.match(/^(\d{1,2})[/-]((?:19|20)\d{2})$/); // 03/2014
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return { month: Number(m[1]) - 1, year: Number(m[2]) };

  m = t.match(/^((?:19|20)\d{2})$/);
  if (m) return { year: Number(m[1]) };

  return null;
}

const render = point => point.present ? 'Present'
  : point.month === undefined ? String(point.year)
  : `${SHORT[point.month]} ${point.year}`;

// Splits a range without mistaking a date's own punctuation for a separator:
// "January, 2014" is one date, "January 2014, January 2020" is two.
function splitRange(text) {
  const separators = [/\s*[–—-]{1,2}\s*/, /\s+(?:to|until|through|thru)\s+/i, /\s*[|]\s*/, /\s*,\s*/];
  for (const sep of separators) {
    const parts = String(text).split(sep);
    if (parts.length !== 2) continue;
    const [a, b] = parts.map(p => parsePoint(p));
    if (a && b) return [a, b];
  }
  return null;
}

function normalizeDateRange(value) {
  const raw = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const range = splitRange(raw);
  if (range) return `${render(range[0])} ${DASH} ${render(range[1])}`;
  const single = parsePoint(raw);
  if (single) return render(single);
  // Unparseable is left exactly as the person wrote it: a date we do not
  // understand is still their fact, and dropping it would be worse.
  return raw;
}

function normalizeResumeDates(resume) {
  for (const entry of resume?.experience || []) {
    if (entry && entry.dates != null) entry.dates = normalizeDateRange(entry.dates);
  }
  return resume;
}

module.exports = { normalizeDateRange, normalizeResumeDates, parsePoint, DASH };
