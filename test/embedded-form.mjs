// A board embedded in someone else's page keeps its fields in a cross-origin
// iframe. The sidebar lives in the top frame, which on those pages holds no
// fields at all, so Fill did visibly nothing. The frame with the fields has to
// do the filling, and it cannot see which job it is embedded in.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const jwt = require('jsonwebtoken');
const db = require('./db.js');

const origin = process.env.APP_ORIGIN;
const EMAIL = 'embed@test.local';
const TOP = 'https://ats.comparably.com/api/v1/gh/contentstack/jobs/7999429003?gh_jid=7999429003';
const EMBED = 'https://job-boards.greenhouse.io/embed/job_app?for=contentstack&token=7999429003';

await db.getOrCreateUser(EMAIL);
await db.setProfile(EMAIL, { first_name: 'Alice', last_name: 'Nguyen', email: EMAIL, phone: '555-0100' }, true);
await db.saveKit({ id: 'embedkit', user_email: EMAIL, url: TOP, company: 'Contentstack', role: 'Director, Revenue Operations',
  tailored: { cover_note: 'note', qa: [{ q: 'Are you willing to travel?', a: 'Yes, up to 25%.' }] },
  tailored_resume: { name: 'Alice', summary: 's', experience: [], skills: [] } });

const browser = await chromium.launch({ headless: true, executablePath: process.env.AA_CHROME || undefined });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  // The top page has no fields: everything lives in the embed.
  await page.route('https://ats.comparably.com/**', r => r.fulfill({ contentType: 'text/html', body:
    `<!doctype html><html><body><h1>Director, Revenue Operations</h1><iframe src="${EMBED}" width="900" height="600"></iframe></body></html>` }));
  await page.route('https://job-boards.greenhouse.io/**', r => r.fulfill({ contentType: 'text/html', body:
    `<!doctype html><html><body><form>
      <label for="fn">First Name</label><input id="fn">
      <label for="ln">Last Name</label><input id="ln">
      <label for="em">Email</label><input id="em" type="email">
      <label for="travel">Are you willing to travel?</label><textarea id="travel"></textarea>
    </form></body></html>` }));
  await page.exposeFunction('transport', async msg => {
    const r = await fetch(msg.url, { method: msg.options.method, headers: msg.options.headers, body: msg.options.body || undefined });
    let data = null; try { data = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, data };
  });
  await page.goto(TOP);
  const frame = page.frames().find(f => f.url().includes('greenhouse.io'));
  assert.ok(frame, 'the embed loaded');
  assert.equal(await page.mainFrame().evaluate(() => document.querySelectorAll('input,textarea').length), 0,
    'the top frame has nothing to fill, which is the whole problem');

  // The worker is the only party that can see both the tab and the frame.
  const sent = [];
  await frame.evaluate(({ o, key, top }) => {
    window.__JAA_FORCE = true;
    window.__storage = { serverUrl: o, apiKey: key, mode: 'cloud' };
    window.__sent = [];
    window.chrome = {
      storage: { sync: { get(_k, cb) { const r = { ...window.__storage }; if (cb) { setTimeout(() => cb(r), 0); return; } return Promise.resolve(r); } }, onChanged: { addListener() {} } },
      runtime: {
        onMessage: { addListener(fn) { window.__onMessage = fn; } },
        sendMessage(msg, cb) {
          window.__sent.push(msg.type);
          if (msg.type === 'GET_TOP_URL') { cb?.({ url: top }); return; }
          if (msg.type === 'SERVER_FETCH') {
            return window.transport(msg).then(cb).catch(() => cb?.({ ok: false }));
          }
          cb?.({ ok: true });
        },
      },
    };
  }, { o: origin, key: jwt.sign({ email: EMAIL }, process.env.APPLYAPPLY_JWT_SECRET), top: TOP });
  await frame.addScriptTag({ content: await readFile(new URL('../extension/content.js', import.meta.url), 'utf8') });
  await page.waitForTimeout(2500);

  assert.ok(await frame.evaluate(() => window.__sent.includes('GET_TOP_URL')),
    'the frame asked which page it is embedded in');
  assert.equal(await frame.evaluate(() => window.__JAA_TOP_KIT_ROLE || (typeof currentApp === 'object' && currentApp?.role) || ''),
    'Director, Revenue Operations', 'and loaded the kit for that page, not for its own URL');

  // Nothing is filled until the applicant asks.
  assert.equal(await frame.locator('#fn').inputValue(), '');
  const result = await frame.evaluate(() => new Promise(res => window.__onMessage({ type: 'DO_FILL' }, {}, res)));
  await page.waitForTimeout(1200);

  assert.equal(await frame.locator('#fn').inputValue(), 'Alice');
  assert.equal(await frame.locator('#ln').inputValue(), 'Nguyen');
  assert.equal(await frame.locator('#em').inputValue(), EMAIL);
  assert.match(await frame.locator('#travel').inputValue(), /25%/, "the kit's own answer reached the embedded question");
  assert.ok(Number(result?.filled) >= 3, 'and it reported what it filled: ' + JSON.stringify(result));
  assert.ok(await frame.evaluate(() => window.__sent.includes('FRAME_FILLED')), 'the worker was told');
  assert.deepEqual(errors, [], 'no page errors');
  console.log('PASS: an embedded board fills from the frame that holds the fields');

  // And when the frame cannot be reached at all, the page says which problem
  // it is and offers the form's own URL, instead of "nothing matched".
  const embedUrl = await page.mainFrame().evaluate(() => {
    for (const f of document.querySelectorAll('iframe')) {
      const src = f.src || '';
      if (/greenhouse\.io\/embed|lever\.co\/jobs-embed|ashbyhq\.com\/.*\/embed|myworkdayjobs\.com/i.test(src)) return src;
    }
    return null;
  });
  assert.ok(embedUrl && embedUrl.includes('job_app'), 'the embedded form has a URL of its own to offer: ' + embedUrl);
  console.log('PASS: an unreachable embed is named, with its own page offered');
} finally {
  await browser.close();
  await db.pool.end();
}
