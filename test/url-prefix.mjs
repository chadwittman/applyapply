// applyapply.xyz/<job link> signed out and signed in: sign-in carries the job
// through the email link and back; a saved kit opens free; no credits says so.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const db = require('./db');
const origin = process.env.APP_ORIGIN;
const email = 'prefix@test.local';
const job = 'https://jobs.lever.co/prefixco/head-of-product';
await db.getOrCreateUser(email);
await db.pool.query('UPDATE users SET credits=0 WHERE email=$1', [email]);
await db.saveKit({ id: 'prefix-kit', user_email: email, url: job, company: 'PrefixCo', role: 'Head of Product',
  tailored: { headline: 'Saved kit headline', why_role: 'Because.', cover_note: 'Hello.', qa: [] } });
const browser = await chromium.launch({ headless: true, executablePath: process.env.AA_CHROME || undefined });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  // Signed out: the page asks to sign in and the button carries the job.
  await page.goto(origin + '/' + job);
  await page.waitForSelector('#loginBox', { state: 'visible' });
  const loginHref = await page.getAttribute('#loginBox a', 'href');
  assert.equal(new URL(loginHref, origin).searchParams.get('return'), '/' + job);
  // The login page sends the return path with the magic-link request.
  await page.goto(new URL(loginHref, origin).href);
  const sent = page.waitForResponse(r => r.url().endsWith('/auth/request'));
  await page.fill('#email', email);
  await page.click('#btn');
  const reply = await sent;
  assert.equal(JSON.parse(reply.request().postData()).return, '/' + job);
  assert.equal(reply.status(), 200);
  // Open the emailed link: it lands back on the job, signed in, kit showing.
  const { rows } = await db.pool.query('SELECT token FROM magic_links WHERE email=$1 ORDER BY expires_at DESC LIMIT 1', [email]);
  assert.ok(rows[0], 'Magic link issued');
  await page.goto(`${origin}/auth/verify?token=${rows[0].token}&return=${encodeURIComponent('/' + job)}`);
  await page.waitForURL(u => u.pathname === '/' + job, { timeout: 10000 });
  await page.waitForFunction(() => document.body.textContent.includes('Saved kit headline'), null, { timeout: 10000 });
  assert.equal(await page.isVisible('#loginBox'), false);
  console.log('PASS: signed out → sign in → back on the job with the kit, not the setup page');
  // Signed in, saved kit: opens free.
  assert.equal((await db.getUser(email)).credits, 0);
  // Signed in, new job, no credits: says so instead of failing silently.
  await page.goto(origin + '/https://jobs.lever.co/prefixco/another-role');
  await page.waitForFunction(() => /out of credits/i.test(document.getElementById('errorBox')?.textContent || ''), null, { timeout: 10000 });
  console.log('PASS: signed in, new job with no credits shows the top-up message');
  // Unsafe return paths never become redirects.
  await page.goto(`${origin}/login?return=${encodeURIComponent('//evil.example/x')}`);
  const unsafe = page.waitForRequest(r => r.url().endsWith('/auth/request'));
  await page.fill('#email', 'other@test.local');
  await page.click('#btn');
  assert.equal(JSON.parse((await unsafe).postData()).return, undefined);
  console.log('PASS: off-site return paths are dropped');
  assert.deepEqual(errors, []);
} finally { await browser.close(); await db.pool.end(); }
