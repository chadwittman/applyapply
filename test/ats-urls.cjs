// Job links must reach the posting itself, not a page of navigation: each
// supported platform has an API, and these are the URL shapes we map to it.
const assert = require('node:assert/strict');
const path = require('node:path');
const requireServer = require('node:module').createRequire(path.resolve(__dirname, '../server/package.json'));
const asked = [];
require.cache[require.resolve(path.resolve(__dirname, '../server/public-fetch'))] = { exports: {
  ...requireServer('./public-fetch'),
  publicFetch: async (url) => {
    asked.push(url);
    const body = /wday\/cxs/.test(url)
      ? JSON.stringify({ jobPostingInfo: { title: 'Product Leader', location: 'Remote USA', jobDescription: '<p>About the role: own the product. Responsibilities: ship. Qualifications: experience.</p>' } })
      : /boards-api\.greenhouse\.io/.test(url) && /\/pinterest\//.test(url)
        ? JSON.stringify({ title: 'Sr. Ads Product Marketing Manager', location: { name: 'SF' }, content: '&lt;p&gt;About the role: ads.&lt;/p&gt;' })
        : /api\.lever\.co/.test(url)
          ? JSON.stringify({ text: 'Head of Product', categories: { location: 'Remote' }, descriptionPlain: 'About the role: lever.' })
          : null;
    return body
      ? { ok: true, status: 200, headers: {}, text: async () => body, json: async () => JSON.parse(body) }
      : { ok: false, status: 404, headers: {}, text: async () => '', json: async () => ({}) };
  },
} };
const { fetchATSJobText, fetchATSFormQuestions, greenhouseTokenGuesses } = requireServer('./server');

(async () => {
  const workday = await fetchATSJobText('https://devoted.wd1.myworkdayjobs.com/en-US/Devoted/details/Product-Leader_R3649');
  assert.match(workday, /Job title: Product Leader/);
  assert.match(workday, /Location: Remote USA/);
  assert.ok(asked.some(u => u === 'https://devoted.wd1.myworkdayjobs.com/wday/cxs/devoted/Devoted/job/Product-Leader_R3649'), asked.join(' '));

  // A Greenhouse job embedded on a company careers domain: the board token is
  // guessed from the host (pinterestcareers -> pinterest).
  const embedded = await fetchATSJobText('https://www.pinterestcareers.com/jobs/8095322/sr-ads/?gh_jid=8095322');
  assert.match(embedded, /Sr\. Ads Product Marketing Manager/);
  assert.ok(asked.some(u => u.includes('/boards/pinterest/jobs/8095322')));

  const lever = await fetchATSJobText('https://jobs.lever.co/acme/head-of-product');
  assert.match(lever, /Head of Product[\s\S]*About the role: lever/);

  assert.equal(await fetchATSJobText('https://careers.example.com/jobs/123'), null, 'Unknown sites fall back to the page');
  console.log('PASS: Workday, embedded Greenhouse and Lever links reach the posting itself');

  // The employer's board token is not always in the host. Contentstack serves
  // its Greenhouse board from ats.comparably.com, where guessing from the host
  // asked for a board called "ats" and the posting looked question-free.
  const guesses = url => { const u = new URL(url); return greenhouseTokenGuesses(u, u.pathname.split('/').filter(Boolean)); };
  assert.equal(guesses('https://ats.comparably.com/api/v1/gh/contentstack/jobs/7999429003?gh_jid=7999429003')[0], 'contentstack');
  assert.equal(guesses('https://careers.acme.com/openings?gh_jid=123')[0], 'acme', 'careers.acme.com is acme, not careers');
  assert.equal(guesses('https://www.acmecareers.com/jobs/456?gh_jid=456')[0], 'acmecareers');
  assert.ok(guesses('https://www.acmecareers.com/jobs/456?gh_jid=456').includes('acme'), 'and acme is tried too');
  for (const generic of ['api', 'v1', 'gh', 'jobs', 'ats', 'careers', 'boards']) {
    assert.ok(!guesses('https://ats.comparably.com/api/v1/gh/contentstack/jobs/1?gh_jid=1').includes(generic), generic + ' is not an employer');
  }

  // And the questions follow the same resolution, not the host alone.
  // greenhouseQuestions calls global fetch, so that is what gets watched.
  const realFetch = globalThis.fetch;
  const boardsAsked = [];
  globalThis.fetch = async (url) => {
    boardsAsked.push(String(url));
    if (!String(url).includes('/boards/contentstack/')) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ questions: [
      { label: 'First Name', fields: [{ name: 'first_name' }] },
      { label: 'Are you willing to travel?', fields: [{ name: 'question_1' }] },
      { label: 'Do you have a Non-Compete in place?', fields: [{ name: 'question_2' }] },
    ] }) };
  };
  try {
    const qs = await fetchATSFormQuestions('https://ats.comparably.com/api/v1/gh/contentstack/jobs/7999429003?gh_jid=7999429003');
    assert.deepEqual(qs, ['Are you willing to travel?', 'Do you have a Non-Compete in place?'],
      'the real questions come back, without the fields we fill from the profile');
    assert.ok(boardsAsked.some(u => u.includes('/boards/contentstack/jobs/7999429003')), boardsAsked.join(' '));
    assert.ok(!boardsAsked.some(u => u.includes('/boards/ats/')), 'and the host is never mistaken for the employer');
  } finally { globalThis.fetch = realFetch; }
  console.log('PASS: a board fronted by someone else\'s domain still resolves');
})().catch(e => { console.error(e); process.exitCode = 1; });
