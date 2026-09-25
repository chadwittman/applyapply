// The card a kit link unfurls to, and the tags that point at it. In Messages
// this is most of what a person sees before they tap.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const db = require('./db.js');
const card = require('./card.js');
const jwt = require('jsonwebtoken');
const origin = process.env.APP_ORIGIN || 'http://localhost:5099';
const EMAIL = 'card@test.local';
const T = jwt.sign({ email: EMAIL }, 'e2e-test-secret-not-production', { expiresIn: '1d' });
await db.getOrCreateUser(EMAIL);
await db.saveKit({ id: 'cardkit', user_email: EMAIL, url: 'https://jobs.lever.co/acme/head-of-product',
  company: 'Watershed', role: 'Head of Product, Climate Platform',
  tailored: { cover_note: 'Dear team', qa: [{ q: 'Why?', a: 'Because' }, { q: 'When?', a: '' }] },
  tailored_resume: { name: 'A', summary: 's', experience: [], skills: [], jev_match: { score: 4.1 } } });

// Long titles wrap rather than overflow, and what does not fit is marked.
assert.equal(card.wrap('Head of Product', 68, 900, 2).length, 1);
const many = card.wrap('Director of Product Management for Enterprise Platform and Developer Experience Worldwide', 68, 900, 2);
assert.equal(many.length, 2);
assert.match(many[1], /…$/, 'a title too long to fit says so');
assert.deepEqual(card.piecesFor({ tailored: { cover_note: 'x', qa: [{ q: 'a', a: 'b' }] }, tailored_resume: {} }),
  ['Tailored resume', 'Cover note', '1 answer', 'PDFs']);

const link = await (await fetch(origin + '/kit-link', { method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T },
  body: JSON.stringify({ appId: 'cardkit' }) })).json();
const token = String(link.kit_url || '').split('/k/')[1];
assert.ok(token, 'a kit link was issued: ' + JSON.stringify(link));

const page = await (await fetch(origin + '/k/' + token)).text();
assert.match(page, /og:image/);
assert.match(page, new RegExp('/k/' + token + '/card\\.png'), 'the card is the kit\'s own');
assert.match(page, /og:title" content="head of product, climate platform at watershed/);
assert.match(page, /82% resume coverage/, 'coverage is not a hiring probability');
assert.match(page, /summary_large_image/);

const img = await fetch(origin + '/k/' + token + '/card.png');
assert.equal(img.status, 200);
assert.equal(img.headers.get('content-type'), 'image/png');
const bytes = Buffer.from(await img.arrayBuffer());
assert.ok(bytes.length > 3000, 'a real image, not a placeholder: ' + bytes.length);
assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
console.log('PASS: a kit link unfurls with its own card, drawn for that job');

// An expired or invented token gives the brand card, never an error and never
// somebody else's kit.
const missing = await fetch(origin + '/k/doesnotexist/card.png');
assert.equal(missing.status, 200);
assert.equal(missing.headers.get('content-type'), 'image/png');
console.log('PASS: an unknown link still previews, with nothing private in it');

assert.doesNotMatch(card.kitSvg({ role: 'product manager', match: null }), /0%/, 'missing scores are not zero');
assert.doesNotMatch(card.kitSvg({ role: 'product manager' }), /0%/);
const jobUrl = 'https://jobs.lever.co/preview/product';
const jobToken = await db.jobLinkToken(EMAIL, jobUrl, { company: 'Preview & Co', role: 'Head of Product', location: 'Remote', reason: 'private fit rationale', email: EMAIL });
assert.equal(await db.jobLinkToken(EMAIL, jobUrl), jobToken, 'stable links preserve snapshots');
const snapshot = await db.jobLinkPreview(jobToken);
assert.equal(snapshot.role, 'Head of Product');
assert.ok(!JSON.stringify(snapshot).includes('private fit rationale'));
assert.ok(!JSON.stringify(snapshot).includes(EMAIL));
const creditsBefore = (await db.getUser(EMAIL)).credits;
for (const method of ['GET', 'HEAD']) {
  const preview = await fetch(origin + '/j/' + jobToken, { method, redirect: 'manual' });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('x-robots-tag'), /noindex/);
  if (method === 'GET') {
    const html = await preview.text();
    assert.match(html, /head of product at preview &amp; co/);
    assert.ok(html.includes(origin + '/j/' + jobToken + '/card.png'));
    assert.match(html, /method="post"/);
    assert.doesNotMatch(html, /private fit rationale|card@test.local/);
  }
}
const jobImage = await fetch(origin + '/j/' + jobToken + '/card.png');
assert.equal(jobImage.status, 200);
assert.equal(Buffer.from(await jobImage.arrayBuffer()).subarray(1, 4).toString(), 'PNG');
assert.equal((await db.openedJobs(EMAIL)).has(jobUrl), false, 'previews never record an open');
assert.equal((await db.getUser(EMAIL)).credits, creditsBefore, 'previews never spend credits');
const click = await fetch(origin + '/j/' + jobToken + '/open', { method: 'POST', redirect: 'manual' });
assert.equal(click.status, 303);
assert.equal(click.headers.get('location'), jobUrl);
assert.equal((await db.openedJobs(EMAIL)).has(jobUrl), true);
assert.equal((await fetch(origin + '/j/doesnotexist', { redirect: 'manual' })).status, 404);
const legacyUrl = 'https://jobs.lever.co/preview/legacy';
await db.upsertJob({ user_email: EMAIL, url: legacyUrl, company: 'Legacy Co', role: 'Product Lead', location: 'Austin', notes: 'private notes' });
const legacy = await db.jobLinkToken(EMAIL, legacyUrl);
assert.equal((await db.jobLinkPreview(legacy)).role, 'Product Lead', 'old links without snapshots still resolve');
const orphan = await db.jobLinkToken('other-card@test.local', legacyUrl);
assert.equal((await db.jobLinkPreview(orphan)).role, '', 'never read a different owner’s job');
const hostile = require('./job-preview').page({ role: '<script>alert(1)</script>', company: '" onload="bad' }, 'abc', origin);
assert.ok(!hostile.includes('<script>'));
assert.match(hostile, /&lt;script&gt;/);
assert.ok(card.wrap('x'.repeat(300), 68, 900, 2)[0].length < 30, 'unbroken titles cannot overflow');

const { chromium } = require('playwright-core');
const browser = await chromium.launch({ headless: true, executablePath: process.env.AA_CHROME || undefined });
try {
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(origin + '/j/' + jobToken);
  assert.equal(await phone.locator('h1').textContent(), 'head of product');
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await phone.screenshot({ path: '/tmp/aa-job-page-mobile.png', fullPage: true });
  // Exercise the real form POST without following a redirect to a live employer.
  let posted = false;
  await phone.route(origin + '/j/' + jobToken + '/open', async route => {
    assert.equal(route.request().method(), 'POST');
    const response = await route.fetch({ maxRedirects: 0 });
    assert.equal(response.status(), 303);
    assert.equal(response.headers().location, jobUrl);
    posted = true;
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>employer redirect verified</h1>' });
  });
  await phone.getByRole('button', { name: 'view original posting' }).click();
  await phone.waitForURL(origin + '/j/' + jobToken + '/open', { timeout: 10000 });
  assert.ok(posted);
  assert.equal(await phone.locator('h1').textContent(), 'employer redirect verified');
} finally { await browser.close(); }
console.log('PASS: own-site job previews, no private facts, no phantom opens or charges');

// Real sending is replaced by a local fetch stub. No message can leave this test.
const sendblue = require('./sendblue');
const liveOrigin = 'https://applyapply.xyz';
const liveLink = liveOrigin + '/j/' + jobToken;
const meta = { kind: 'match_option', link: liveLink };
const media = card.messageMedia(liveLink, meta, liveOrigin);
assert.equal(media, liveLink + '/card.png');
assert.equal(card.messageMedia(liveLink, { ...meta, kind: 'gap_question' }, liveOrigin), null);
assert.equal(card.messageMedia('not a link', meta, liveOrigin), null);
assert.equal(card.messageMedia('https://evil.example/j/abc', { ...meta, link: 'https://evil.example/j/abc' }, liveOrigin), null);
assert.equal(card.messageMedia(liveLink, meta, 'http://localhost:5000'), null);
const realFetch = globalThis.fetch;
const savedKey = process.env.SENDBLUE_API_KEY, savedSecret = process.env.SENDBLUE_API_SECRET;
try {
  process.env.SENDBLUE_API_KEY = 'fake'; process.env.SENDBLUE_API_SECRET = 'fake';
  globalThis.fetch = async (_url, opts) => {
    const payload = JSON.parse(opts.body);
    assert.equal(payload.media_url, media);
    assert.equal(payload.content, liveLink, 'keep a usable link alongside the image');
    return new Response(JSON.stringify({ message_handle: 'test-card' }), { status: 200 });
  };
  assert.equal(sendblue.handleOf(await sendblue.send('+15125550123', liveLink, { mediaUrl: media })), 'test-card');
} finally {
  globalThis.fetch = realFetch;
  if (savedKey === undefined) delete process.env.SENDBLUE_API_KEY; else process.env.SENDBLUE_API_KEY = savedKey;
  if (savedSecret === undefined) delete process.env.SENDBLUE_API_SECRET; else process.env.SENDBLUE_API_SECRET = savedSecret;
}
console.log('PASS: card attachment and clickable text link share one Sendblue request');
await db.pool.end();
