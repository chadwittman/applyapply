// Chrome Web Store screenshots at 1280x800 from the shipped extension code,
// against a throwaway local server with an invented candidate and job.
// Run: AA_TEST_SUITES=tools/store-screenshots.mjs npm test
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const jwt = require('jsonwebtoken');
const db = require('./db');

const origin = process.env.APP_ORIGIN;
const out = new URL('../store-assets/', import.meta.url).pathname;
const email = 'jordan@example.com';
const url = 'https://jobs.lever.co/fieldnote/head-of-product';
const key = jwt.sign({ email }, process.env.APPLYAPPLY_JWT_SECRET);
const W = 1280, H = 800;

const profile = {
  first_name: 'Jordan', last_name: 'Rivera', email, phone: '(555) 014-2290',
  linkedin: 'linkedin.com/in/jordan-rivera-pm', website: 'jordanrivera.co', location: 'Denver, CO',
  current_employer: 'Parcelworks', school: 'University of Michigan', work_authorization: 'yes', sponsorship: 'no',
  target_roles: 'Head of Product, Director of Product', location_pref: 'remote',
};

await db.getOrCreateUser(email);
await db.pool.query('UPDATE users SET credits=$1 WHERE email=$2', [240, email]);
await db.setProfile(email, profile, true);
await db.saveKit({
  id: 'store-kit', user_email: email, url, company: 'Fieldnote', role: 'Head of Product', fit_score: 9, profile,
  tailored: {
    headline: 'Product leader who takes AI features from prototype to paid adoption',
    why_role: 'Fieldnote is turning field research into structured data, and that is the problem I have spent six years on. At Parcelworks I led the team that moved route planning from spreadsheets to a model-assisted workflow used by 4,000 dispatchers. I want to do that again for researchers, with a product that earns trust by showing its work.',
    cover_note: 'Hi Fieldnote team,\n\nI lead product at Parcelworks, where I built our first AI-assisted planning tool and grew it to 38% of revenue in two years. The part I am proudest of is the review step: every suggestion shows its source, and dispatchers accept 81% of them.\n\nYour note-to-dataset pipeline has the same shape. I would love to talk about where it goes next.\n\nJordan',
    qa: [
      { q: 'Describe a product you took from zero to one.', a: 'Route Assist at Parcelworks. I ran 30 dispatcher interviews, shipped a rules-based beta in six weeks, then replaced the rules with a model once we had 200k labeled routes. It reached 4,000 weekly users within a year.' },
      { q: 'How do you decide what not to build?', a: 'I write the success metric before the spec. If we cannot name the number that moves and who notices, it goes to the parking lot. That cut our 2025 roadmap from 19 bets to 7.' },
      { q: 'Tell us about a launch that did not go to plan.', a: 'Our first auto-scheduling release overbooked drivers in two regions. I paused it within a day, added a human confirmation step, and relaunched three weeks later with a 0.4% override rate.' },
    ],
  },
  tailored_resume: {
    name: 'Jordan Rivera', version: 2, generated_at: new Date().toISOString(),
    summary: 'Product leader with six years building AI-assisted workflow tools. Took Route Assist from research to 4,000 weekly users and 38% of revenue.',
    experience: [
      { company: 'Parcelworks', title: 'Director of Product', dates: '2022 – Present', bullets: [
        'Led a 14-person product and design team across planning, dispatch and billing.',
        'Launched Route Assist, a model-assisted planner now used by 4,000 dispatchers weekly.',
        'Raised suggestion acceptance from 52% to 81% by adding source-backed explanations.'] },
      { company: 'Tallyhouse', title: 'Senior Product Manager', dates: '2019 – 2022', bullets: [
        'Owned self-serve onboarding; cut time to first report from 3 days to 40 minutes.',
        'Shipped usage-based pricing that lifted net revenue retention to 118%.'] },
    ],
    skills: ['Product strategy', 'AI product design', 'Pricing', 'Discovery research', 'SQL'],
    coverage: { confidence: 'strong', gaps: [] },
  },
});

const jobPage = `<!doctype html><html><head><meta charset="utf-8"><title>Fieldnote - Head of Product</title><style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;color:#1f2328;background:#fff}
header{padding:22px 48px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;gap:12px}
.logo{width:34px;height:34px;border-radius:8px;background:#2f6f5e;color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center}
main{max-width:720px;padding:32px 48px}
h1{font-size:30px;margin:0 0 6px}.meta{color:#57606a;font-size:14px;margin-bottom:26px}
h2{font-size:17px;margin:28px 0 10px}p,li{font-size:15px;line-height:1.65;color:#374151}
form{margin-top:18px;border-top:1px solid #e5e7eb;padding-top:10px}
label{display:block;font-size:13px;font-weight:600;margin:16px 0 6px}
input,textarea,select{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d0d7de;border-radius:6px;font:inherit;font-size:14px}
textarea{min-height:110px}.row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
button.submit{margin-top:22px;background:#2f6f5e;color:#fff;border:0;border-radius:6px;padding:12px 22px;font-size:15px;font-weight:600}
</style></head><body>
<header><div class="logo">F</div><strong>Fieldnote</strong></header>
<main>
<h1>Head of Product</h1><div class="meta">Remote (US) · Product · Full-time</div>
<p>Fieldnote turns interviews, site visits and field notes into structured research data teams can query. We are 22 people, Series A, and our customers include research teams at hospitals, city governments and product companies.</p>
<h2>What you will do</h2>
<ul><li>Own the product roadmap from discovery through launch.</li><li>Build and lead a small team of product managers and designers.</li><li>Ship AI features researchers trust, with every answer traceable to its source.</li></ul>
<h2>Apply for this job</h2>
<form>
<div class="row"><div><label for="first">First name</label><input id="first" name="first_name"></div><div><label for="last">Last name</label><input id="last" name="last_name"></div></div>
<div class="row"><div><label for="em">Email</label><input id="em" type="email" name="email"></div><div><label for="ph">Phone</label><input id="ph" name="phone"></div></div>
<label for="li">LinkedIn profile</label><input id="li" name="linkedin">
<label for="loc">Current location</label><input id="loc" name="location">
<label for="auth">Are you legally authorized to work in the United States?</label><select id="auth"><option value="">Select</option><option value="yes">Yes</option><option value="no">No</option></select>
<label for="why">Why do you want to join Fieldnote?</label><textarea id="why"></textarea>
<label for="zero">Describe a product you took from zero to one.</label><textarea id="zero"></textarea>
<button type="button" class="submit">Submit application</button>
</form></main></body></html>`;

const stub = ({ origin, key }) => {
  window.__storage = { serverUrl: origin, apiKey: key, mode: 'cloud' };
  window.chrome = {
    storage: { sync: {
      get(_k, cb) { const r = { ...window.__storage }; if (cb) { setTimeout(() => cb(r), 0); return; } return Promise.resolve(r); },
      set(_v, cb) { cb?.(); }, remove(_v, cb) { cb?.(); } }, onChanged: { addListener() {} } },
    runtime: { id: 'store', onMessage: { addListener(fn) { window.__onMessage = fn; } }, sendMessage(msg, cb) {
      if (msg.type === 'GET_IFRAME_QUESTIONS') return cb?.({ questions: [] });
      if (msg.type !== 'SERVER_FETCH') return cb?.({ ok: false });
      window.transport(msg).then(cb).catch(e => cb?.({ ok: false, error: e.message }));
    } },
    permissions: { contains(_p, cb) { cb(false); }, request(_p, cb) { cb(false); }, remove(_p, cb) { cb(false); } },
    tabs: { query(_q, cb) { cb([{ id: 1, url }]); }, create() {}, sendMessage() {} },
  };
};

await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.AA_CHROME || undefined });
try {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.exposeFunction('transport', async msg => {
    const r = await fetch(msg.url, { method: msg.options.method, headers: msg.options.headers, body: msg.options.body || undefined });
    let data; try { data = await r.json(); } catch { data = null; }
    return { ok: r.ok, status: r.status, data };
  });
  await page.route('https://jobs.lever.co/**', route => route.fulfill({ contentType: 'text/html', body: jobPage }));
  await page.goto(url);
  await page.evaluate(stub, { origin, key });
  await page.addScriptTag({ path: new URL('../extension/vendor/jspdf.umd.min.js', import.meta.url).pathname });
  await page.addScriptTag({ content: await readFile(new URL('../extension/content.js', import.meta.url), 'utf8') });
  await page.waitForSelector('#jaa-root'); await page.waitForTimeout(1200);
  if (errors.length) throw new Error('Content script errors: ' + errors.join('; '));

  const collapse = names => page.evaluate(names => {
    for (const hd of shadow.querySelectorAll('.sec-hd[data-sec]')) hd.closest('.sec').classList.toggle('collapsed', names.includes(hd.dataset.sec));
  }, names);
  const scrollBody = sel => page.evaluate(sel => { const el = shadow.querySelector(sel); el?.scrollIntoView({ block: 'start' }); }, sel);
  const shot = async name => { await page.waitForTimeout(400); await page.screenshot({ path: out + name }); console.log('wrote store-assets/' + name); };

  // 1. The job page with the tailored kit beside it.
  await collapse(['profile']);
  await shot('screenshot-1-kit.png');

  // 2. The tailored resume, with download and attach.
  await page.locator('#jaa-resume-out .sec-hd').first().click();
  await collapse(['profile', 'why', 'cover', 'hl', 'qa']);
  await scrollBody('#jaa-resume-out');
  await shot('screenshot-2-resume.png');
  await page.locator('#jaa-resume-out .sec-hd').first().click();

  // 3. Reviewable answers to the application's questions.
  await collapse(['profile', 'why', 'cover', 'hl']);
  await scrollBody('.sec-hd[data-sec="qa"]');
  await shot('screenshot-3-answers.png');

  // 4. The form filled from the kit, with a fill control beside each field.
  await collapse(['why', 'cover', 'hl', 'qa']);
  await page.evaluate(() => { shadow.querySelector('.body').scrollTop = 0; });
  await page.locator('#jaa-root #jaa-fill').click();
  await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelector('form').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await shot('screenshot-4-fill.png');

  // 5. The toolbar popup over a job page: sign-in state, credits, auto-detect.
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 340, height: 700 });
  await popup.route('https://applyapply.xyz/**', async route => {
    const req = route.request(); const u = new URL(req.url());
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    // Forward as a same-origin call; the local server rejects unknown browser origins.
    const headers = Object.fromEntries(Object.entries(req.headers()).filter(([k]) => ['x-api-key', 'content-type', 'accept'].includes(k)));
    const r = await fetch(origin + u.pathname + u.search, { method: req.method(), headers });
    await route.fulfill({ status: r.status, contentType: r.headers.get('content-type') || 'application/json', headers: cors, body: Buffer.from(await r.arrayBuffer()) });
  });
  const popupErrors = []; popup.on('pageerror', e => popupErrors.push(e.message));
  await popup.route('https://popup.test/**', async route => {
    const file = new URL('../extension/' + new URL(route.request().url()).pathname.slice(1), import.meta.url);
    const type = { html: 'text/html', css: 'text/css', js: 'text/javascript' }[file.pathname.split('.').pop()];
    await route.fulfill({ contentType: type, body: await readFile(file) });
  });
  await popup.addInitScript(({ origin, key, email, profile, url }) => {
    window.chrome = {
      storage: { sync: { get(_k, cb) { setTimeout(() => cb({ apiKey: key, userEmail: email, profile }), 0); }, set(_v, cb) { cb?.(); }, remove(_v, cb) { cb?.(); } }, onChanged: { addListener() {} } },
      permissions: { contains(_p, cb) { cb(false); }, request(_p, cb) { cb(false); }, remove(_p, cb) { cb(false); } },
      tabs: { query(_q, cb) { cb([{ id: 1, url }]); }, create() {}, sendMessage() {} },
      runtime: { id: 'store', lastError: null }, scripting: { executeScript() {} },
    };
  }, { origin, key, email, profile, url });
  await popup.goto('https://popup.test/popup.html');
  await popup.waitForSelector('#status-text:text("ready")', { timeout: 10000 });
  await popup.click('#btn-settings-toggle');
  await popup.waitForSelector('#auth-credits:not(:empty)', { timeout: 10000 });
  await popup.waitForTimeout(400);
  if (popupErrors.length) throw new Error('Popup errors: ' + popupErrors.join('; '));
  const popupPng = await popup.locator('body').screenshot();
  await page.evaluate(() => { window.scrollTo(0, 0); shadow.getElementById('jaa-sidebar')?.classList.remove('open'); document.getElementById('jaa-root')?.remove(); document.querySelectorAll('[data-jaa-copy]').forEach(b => b.remove()); document.body.style.marginRight = ''; });
  await page.waitForTimeout(400);
  const bg = await page.screenshot();
  const comp = await ctx.newPage();
  await comp.setContent(`<body style="margin:0;width:${W}px;height:${H}px;overflow:hidden;position:relative">
    <img src="data:image/png;base64,${bg.toString('base64')}" style="position:absolute;inset:0;filter:brightness(.92)">
    <img src="data:image/png;base64,${popupPng.toString('base64')}" style="position:absolute;top:10px;right:24px;max-height:${H - 20}px;box-shadow:0 12px 40px rgba(0,0,0,.28);border:1px solid #ccc">
  </body>`);
  await comp.waitForTimeout(300);
  await comp.screenshot({ path: out + 'screenshot-5-popup.png' });
  console.log('wrote store-assets/screenshot-5-popup.png');
} finally { await browser.close(); await db.pool.end(); }
