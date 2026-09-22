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
const { fetchATSJobText } = requireServer('./server');

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
})().catch(e => { console.error(e); process.exitCode = 1; });
