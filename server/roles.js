// Matches job titles against a user's target roles by words, not phrases:
// every meaningful word of a target role must appear in the title. So
// "Director of Product" matches "Director, Product Management", and
// "Senior Product Manager" matches "Sr. Product Manager, Payments".
const STOP = new Set(['of', 'the', 'and', 'for', 'a', 'an', 'to', 'in', 'at', 'on']);
const SYNONYMS = [
  [/\bvice[\s-]+president\b/g, 'vp'], [/\bsvp\b/g, 'senior vp'], [/\bevp\b/g, 'executive vp'],
  [/\bsr\b/g, 'senior'], [/\bjr\b/g, 'junior'], [/\bmgr\b/g, 'manager'], [/\bdir\b/g, 'director'],
  [/\bpm\b/g, 'product manager'], [/\bgpm\b/g, 'group product manager'], [/\bmgmt\b/g, 'management'],
];
function normalize(title) {
  let t = String(title || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ');
  for (const [from, to] of SYNONYMS) t = t.replace(from, to);
  return t.trim();
}
// A title that names a different function is a different job, even when it
// contains every word of the target: "Senior Product Marketing Manager" is
// not a "Senior Product Manager".
const OTHER_FUNCTIONS = ['marketing', 'design', 'designer', 'engineer', 'engineering', 'developer', 'counsel', 'legal', 'sales',
  'recruiter', 'recruiting', 'finance', 'accounting', 'partnerships', 'operations', 'support', 'analyst', 'scientist', 'security', 'compliance'];

function roleMatcher(titles) {
  const targets = String(titles || '').split(',')
    .map(t => normalize(t).split(' ').filter(w => w && !STOP.has(w)))
    .filter(words => words.length);
  const matches = title => {
    const words = new Set(normalize(title).split(' '));
    // "management" satisfies "manager" and "manager" satisfies "management".
    const has = w => words.has(w) || (w === 'manager' && words.has('management')) || (w === 'management' && words.has('manager'));
    return targets.some(target => target.every(has) && !OTHER_FUNCTIONS.some(f => words.has(f) && !target.includes(f)));
  };
  return {
    targets,
    test(title) {
      if (!targets.length) return false;
      // Hacker News posts often list several roles in one title.
      return matches(title) || String(title || '').split(/[,·;|]| \/ /).some(part => part.trim() && matches(part));
    },
  };
}
module.exports = { roleMatcher, normalize };
