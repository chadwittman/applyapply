// The /demo page in real Chrome: the real sidebar, answered in the page.
// It must fill the sample form, rewrite the resume, never submit, and never
// call the API or spend credits.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const origin = process.env.APP_ORIGIN;
const browser = await chromium.launch({ headless: true, executablePath: process.env.AA_CHROME || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const requests = []; page.on('request', r => { const u = new URL(r.url()); if (u.origin === origin) requests.push(u.pathname); });
  await page.goto(origin + '/demo');
  await page.click('#demo-ext');
  await page.waitForSelector('#jaa-root #jaa-generate');
  const t0 = Date.now();
  await page.click('#jaa-root #jaa-generate');
  await page.waitForSelector('#jaa-root #jaa-fill', { timeout: 20000 });
  const kitMs = Date.now() - t0;
  assert.ok(kitMs > 4000 && kitMs < 9000, 'Kit takes about half the real time, got ' + kitMs + 'ms');
  console.log(`PASS: demo kit ready in ${kitMs}ms`);
  await page.click('#jaa-root #jaa-fill');
  await page.waitForFunction(() => document.getElementById('why').value.length > 50, null, { timeout: 10000 });
  assert.equal(await page.inputValue('#first_name'), 'Jordan');
  assert.equal(await page.inputValue('#email'), 'jordan@example.com');
  assert.equal(await page.inputValue('#authorized'), 'yes');
  assert.match(await page.inputValue('#zero_to_one'), /Route Assist/);
  assert.equal(await page.inputValue('#start'), '', 'Logistics stay blank for the candidate');
  console.log('PASS: demo fills the sample form and leaves logistics blank');
  await page.evaluate(() => shadow.getElementById('jaa-gen-resume').click());
  await page.waitForFunction(() => /Version 2/.test(shadow.getElementById('jaa-resume-out').textContent), null, { timeout: 10000 });
  console.log('PASS: demo resume rewrite');
  await page.click('#demo-submit');
  assert.equal(await page.isVisible('#demo-done'), true);
  console.log('PASS: demo submit explains, sends nothing');
  const apiCalls = requests.filter(p => !p.startsWith('/demo') && !p.startsWith('/brand'));
  assert.deepEqual(apiCalls, [], 'Demo made no API calls');
  assert.deepEqual(errors, []);
  console.log('PASS: demo made no API calls');
  await page.screenshot({ path: '/tmp/applyapply-demo.png' });
  // The homepage's "any job link" box opens the URL-prefix kit page.
  const home = await browser.newPage();
  await home.goto(origin + '/');
  await home.fill('#job-link', 'not a link');
  await home.click('.url-go button');
  assert.match(await home.textContent('#job-link-err'), /does not look like a link/);
  await home.fill('#job-link', 'jobs.lever.co/acme/head-of-product');
  await Promise.all([home.waitForURL(/\/https:\/\/jobs\.lever\.co\/acme\/head-of-product$/, { waitUntil: 'commit' }), home.click('.url-go button')]);
  assert.equal((await home.request.get(home.url())).status(), 200);
  await home.goto(origin + '/');
  await home.locator('.url-trick').scrollIntoViewIfNeeded();
  await home.screenshot({ path: '/tmp/applyapply-urltrick.png' });
  console.log('PASS: homepage job-link box opens the URL-prefix kit page');

  // "See it work": pick a role, click a result, and the kit has to actually
  // appear. It was stuck on "Generating" because the reveal cleared an inline
  // style over a stylesheet rule that hides the panel.
  await home.goto(origin + '/');
  await home.locator('.demo-outer').scrollIntoViewIfNeeded();
  await home.waitForSelector('.djob.visible', { timeout: 15000 });
  await home.locator('.djob').first().click();
  await home.waitForSelector('.demo-sidebar.open', { timeout: 5000 });
  await home.waitForFunction(() => {
    const kit = document.getElementById('dsb-kit');
    return kit && getComputedStyle(kit).display !== 'none' && kit.getBoundingClientRect().height > 20;
  }, null, { timeout: 8000 });
  assert.ok((await home.textContent('#dsb-cover')).length > 40, 'the kit shows a cover note');
  assert.equal(await home.isVisible('#dsb-gen'), false, 'the generating line is gone once the kit lands');
  console.log('PASS: homepage demo opens a kit when a result is clicked');
} finally { await browser.close(); }
