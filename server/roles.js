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

// ── Function and seniority ───────────────────────────────────────────────────
// Targeting by exact title is a gate on the user's imagination: if they never
// typed "Group Product Manager", they never saw one. Job titles are formulaic
// though — a function word and a seniority word — so classify the title
// instead, let people target a function and a level, and let them filter what
// arrives rather than deciding in advance what may arrive at all.

// Order matters: the first function whose signal appears, after the ones that
// steal its words have been ruled out. "Product Marketing Manager" is
// marketing; "Growth Product Manager" is growth; "Product Designer" is design.
const FUNCTIONS = [
  ['design', [/\bdesign(er|ing)?\b/, /\bux\b/, /\bui\b/, /\buser experience\b/, /\bcreative director\b/]],
  ['engineering', [/\bengineer(ing)?\b/, /\bdeveloper\b/, /\bswe\b/, /\barchitect\b/, /\bdevops\b/, /\bsre\b/, /\bcto\b/, /\bprogrammer\b/, /\btech lead\b/]],
  ['data', [/\bdata\b/, /\banalytics\b/, /\banalyst\b/, /\bmachine learning\b/, /\bml\b/, /\bstatistic/, /\bresearch scientist\b/]],
  ['growth', [/\bgrowth\b/, /\bdemand gen(eration)?\b/, /\buser acquisition\b/, /\bperformance marketing\b/, /\blifecycle\b/, /\bretention\b/, /\bgtm\b/, /\bgo to market\b/]],
  ['marketing', [/\bmarketing\b/, /\bbrand\b/, /\bcontent\b/, /\bcommunications\b/, /\bseo\b/, /\bpmm\b/, /\bcmo\b/, /\bpublic relations\b/]],
  ['sales', [/\bsales\b/, /\baccount executive\b/, /\bae\b/, /\bbusiness development\b/, /\bbizdev\b/, /\brevenue\b/, /\bcro\b/, /\bpartnerships\b/, /\baccount manager\b/]],
  ['product', [/\bproduct\b/, /\bpm\b/, /\bcpo\b/, /\bproduct owner\b/, /\bgpm\b/]],
  ['operations', [/\boperations\b/, /\bops\b/, /\bchief of staff\b/, /\bprogram manager\b/, /\bcoo\b/, /\bproject manager\b/]],
];

// Functions that are nobody's target here, so a title carrying them is not
// offered to anyone rather than being classified into the nearest match.
const EXCLUDED = [/\brecruit/, /\btalent acquisition\b/, /\bcounsel\b/, /\blegal\b/, /\bparalegal\b/, /\baccountant\b/, /\bbookkeep/,
  /\bnurse\b/, /\bphysician\b/, /\btherapist\b/, /\bteacher\b/, /\bdriver\b/, /\bwarehouse\b/, /\bcustodian\b/,
  /\bintern\b/, /\binternship\b/, /\bcontract(or)?\b/, /\bpart[- ]time\b/, /\bvolunteer\b/];

const SENIORITY = [
  ['exec', [/\bchief\b/, /\bc[topmr]o\b/, /\bvp\b/, /\bvice president\b/, /\bpresident\b/, /\bpartner\b/, /\bgeneral manager\b/, /\bgm\b/]],
  ['director', [/\bdirector\b/, /\bhead\b/, /\bgroup\b/]],
  ['lead', [/\blead\b/, /\bmanager\b/, /\bmanagement\b/, /\bfounding\b/, /\bprincipal\b/]],
  ['senior', [/\bsenior\b/, /\bstaff\b/, /\bsr\b/, /\bexperienced\b/, /\bii+\b/]],
  ['ic', [/\bassociate\b/, /\bjunior\b/, /\bentry\b/, /\bcoordinator\b/, /\bspecialist\b/, /\bi\b/]],
];

const BANDS = ['ic', 'senior', 'lead', 'director', 'exec'];
const FUNCTION_NAMES = FUNCTIONS.map(([name]) => name).sort();

// Compounds where one function's word is really part of another's name.
// "Product Marketing Manager" is a marketing job that happens to say product,
// and a product person should not be shown it.
const COMPOUNDS = [
  [/\bproduct marketing\b/g, ' marketing '],
  [/\bproduct design(er)?\b/g, ' design '],
  [/\bproduct engineer(ing)?\b/g, ' engineering '],
  [/\bdata engineer(ing)?\b/g, ' engineering data '],
  [/\bsales engineer(ing)?\b/g, ' engineering '],
  [/\bdesign(er)? manager\b/g, ' design manager '],
];

// "Senior Product Manager" is senior, not lead, even though "manager" is in
// it: the modifier in front of a function's own noun is what sets the level.
const LEVEL_NOUN = /\b(manager|management|lead)\b/;

// A title can belong to more than one function, and usually the honest answer
// is both: "VP Product & Growth" is a real job for a product person and for a
// growth person. Returning one label would hide it from one of them.
function classify(title) {
  const raw = normalize(title);
  if (!raw) return { functions: [], function: null, seniority: null };
  if (EXCLUDED.some(re => re.test(raw))) return { functions: [], function: null, seniority: null };
  let t = raw;
  for (const [re, to] of COMPOUNDS) t = t.replace(re, to);
  const functions = FUNCTIONS.filter(([, signals]) => signals.some(re => re.test(t))).map(([name]) => name);
  // "Product Manager" is the function's own name, not a statement about level:
  // a PM is an individual contributor, while an Engineering Manager manages.
  const level = raw.replace(/\b(product|program|project|account|community|partner)\s+(manager|management)\b/g, ' $1 ');
  let seniority = null;
  for (const [band, signals] of SENIORITY) {
    if (!signals.some(re => re.test(level))) continue;
    if (band === 'lead' && LEVEL_NOUN.test(level) && /\b(senior|staff|sr|principal)\b/.test(level) && !/\bfounding\b/.test(level)) continue;
    seniority = band;
    break;
  }
  // A bare "Product Manager" is the entry point of its function, not unranked.
  if (!seniority && functions.length) seniority = 'ic';
  return { functions, function: functions[0] || null, seniority };
}

const parseList = value => String(value || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);

// What a person is actually targeting. Functions and bands when they have set
// them; otherwise derived from whatever they have already told us, so an
// account from before this existed keeps working and gets wider recall rather
// than a blank search.
function targetPreferences(profile) {
  const functions = parseList(profile?.target_functions).filter(f => FUNCTION_NAMES.includes(f));
  const bands = parseList(profile?.target_seniority).filter(b => BANDS.includes(b));
  if (functions.length) return { functions, bands, titles: profile?.target_roles || '', derived: false };

  const derived = new Set(), derivedBands = new Set();
  for (const title of parseList(profile?.target_roles)) {
    const c = classify(title);
    for (const f of c.functions) derived.add(f);
    if (c.seniority) derivedBands.add(c.seniority);
  }
  const career = String(profile?.career_type || '').toLowerCase();
  if (!derived.size && FUNCTION_NAMES.includes(career)) derived.add(career);
  // One stated level is a floor, not a ceiling: someone targeting Head of
  // Product will take a VP role, and often a strong senior one.
  const floor = Math.min(...[...derivedBands].map(b => BANDS.indexOf(b)).filter(i => i >= 0));
  const bandsOut = Number.isFinite(floor) ? BANDS.slice(Math.max(0, floor - 1)) : [];
  return { functions: [...derived], bands: bandsOut, titles: profile?.target_roles || '', derived: true };
}

// Recall is set by the function and the level. An exact title the person asked
// for always gets through, whatever the classifier thinks, so the list stays a
// safety valve rather than a cage.
function targetMatcher(profile, classifier = classify) {
  const prefs = targetPreferences(profile);
  const titles = roleMatcher(prefs.titles);
  const test = title => {
    if (titles.test(title)) return true;
    if (!prefs.functions.length) return false;
    const c = classifier(title);
    if (!c.functions.some(f => prefs.functions.includes(f))) return false;
    return !prefs.bands.length || prefs.bands.includes(c.seniority);
  };
  return { ...prefs, test, classify: classifier };
}

module.exports.classify = classify;
module.exports.targetPreferences = targetPreferences;
module.exports.targetMatcher = targetMatcher;
module.exports.FUNCTION_NAMES = FUNCTION_NAMES;
module.exports.BANDS = BANDS;

