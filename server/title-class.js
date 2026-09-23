// What a job title is: which functions it belongs to and at what level.
//
// Measured on 2,328 distinct titles from real boards, the word rules in
// roles.js place 79% of them and get 95% of product/growth right — but they
// are systematically wrong on a whole class of title ("AWS GTM Partnership
// Lead" is sales, not growth), and they cannot read a wording nobody wrote a
// rule for. Jev reads the title instead, at about $0.000018 each.
//
// The rules do not go away. They answer instantly, for free, whenever a title
// has not been decided yet, so nothing waits on a network call to show a
// person their pipeline. Jev decides, once per distinct title, and that
// decision is kept forever: titles repeat across thousands of postings, so the
// steady-state cost of this is close to nothing.
const { evaluate } = require('./typesafe');
const { classify, normalize, FUNCTION_NAMES } = require('./roles');

const CRITERIA = {
  product: 'Product management: owning what gets built and why (product manager, product lead, product owner, head of product)',
  growth: 'Growth: acquisition, activation, retention, monetisation, or the growth side of go-to-market, owned as a product or marketing discipline',
  marketing: 'Marketing: brand, content, communications, product marketing, demand generation',
  design: 'Design: product design, UX, UI, brand or creative design',
  engineering: 'Engineering: building or leading the building of software, infrastructure or ML systems',
  data: 'Data: analytics, data science, research on data, data platforms',
  operations: 'Operations: business operations, programs, strategy execution, chief of staff work',
  sales: 'Sales: selling, account management, channel or technology partnerships, customer success, revenue',
  none: 'None of these: a different profession entirely (legal, finance, recruiting, support, clinical, facilities, security guarding), or a title too vague to place',
};

const LEVELS = {
  ic: 'An individual contributor doing the work, with no stated seniority (Product Manager, Software Engineer, Designer)',
  senior: 'A senior individual contributor (Senior, Staff, Sr.)',
  lead: 'A lead, a principal, or a manager of a small team (Lead, Principal, Engineering Manager, Founding)',
  director: 'A director or a head of a function (Director, Head of, Group)',
  exec: 'An executive over a whole function or company (VP, SVP, Chief, C-level, General Manager)',
};

const key = title => normalize(title);
const BATCH = 20;
const CONCURRENCY = 4;

async function decideBatch(apiKey, titles) {
  const questions = {};
  titles.forEach((t, i) => {
    questions[`f${i}`] = { type: 'choice', criteria: CRITERIA,
      instructions: `A job posting is titled "${t}". Which job function is this role in? Choose none if it is a different profession, or if the title does not say.` };
    questions[`l${i}`] = { type: 'choice', criteria: LEVELS,
      instructions: `A job posting is titled "${t}". How senior is it? Judge only from the title. A "Product Manager" with no other word is an individual contributor; an "Engineering Manager" manages people.` };
  });
  const data = await evaluate(apiKey, { note: 'Classifying job titles so a job seeker can target a function and a level' }, questions);
  return titles.map((title, i) => {
    const fn = data.answers?.[`f${i}`], lvl = data.answers?.[`l${i}`];
    const rules = classify(title);
    // A confident read wins; anything less keeps whatever the rules said, so a
    // hedge never costs us a listing the rules would have placed.
    const functions = fn?.choice && fn.choice !== 'none' && Number(fn.confidence) >= 0.7 && FUNCTION_NAMES.includes(fn.choice)
      ? [...new Set([fn.choice, ...rules.functions.filter(f => f !== fn.choice && rules.functions.length > 1)])]
      : fn?.choice === 'none' && Number(fn.confidence) >= 0.8 ? []
      : rules.functions;
    const band = lvl?.choice && LEVELS[lvl.choice] && Number(lvl.confidence) >= 0.7 ? lvl.choice : rules.seniority;
    return { key: key(title), title, functions, band: functions.length ? band : null, decidedBy: 'jev' };
  });
}

// Decide every title that has not been decided before, and keep the decisions.
// Returns what was added. Never throws: a failure here leaves the rules in
// charge, which is the behaviour this replaced.
async function classifyNewTitles(db, apiKey, titles, { log = () => {} } = {}) {
  if (!apiKey) return { decided: 0, cached: 0, skipped: 'no TypeSafe key' };
  const cache = await db.getTitleClasses();
  const pending = [...new Map(titles.filter(t => t && !cache.has(key(t))).map(t => [key(t), t])).values()];
  if (!pending.length) return { decided: 0, cached: cache.size };
  const batches = [];
  for (let i = 0; i < pending.length; i += BATCH) batches.push(pending.slice(i, i + BATCH));
  let decided = 0;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const group = await Promise.all(batches.slice(i, i + CONCURRENCY).map(b =>
      decideBatch(apiKey, b).catch(e => { log('   title classify failed: ' + e.message); return null; })));
    for (const entries of group) {
      if (!entries) continue;
      await db.saveTitleClasses(entries);
      decided += entries.length;
    }
  }
  log(`   classified ${decided} new title${decided === 1 ? '' : 's'} (${cache.size} already known)`);
  return { decided, cached: cache.size };
}

// The lookup used everywhere a title needs placing: the kept decision when
// there is one, the word rules when there is not.
function classifierFor(classes) {
  return title => {
    const hit = classes?.get(key(title));
    if (hit) return { functions: hit.functions, function: hit.functions[0] || null, seniority: hit.band, decidedBy: hit.decidedBy };
    const rules = classify(title);
    return { ...rules, decidedBy: 'rules' };
  };
}

module.exports = { classifyNewTitles, classifierFor, key, CRITERIA, LEVELS };
