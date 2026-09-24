// Every page, in a real browser, with a real session — after tightening auth
// the risk is a page that silently renders empty because its fetch now 401s.
import { createRequire } from 'module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const jwt = require('jsonwebtoken');
const B = process.env.APP_ORIGIN || 'http://localhost:5099';
const T = jwt.sign({ email: 'alice@test.local' }, 'e2e-test-secret-not-production', { expiresIn: '1d' });

const browser = await chromium.launch({ headless: true, executablePath: process.env.AA_CHROME || undefined });
const ctx = await browser.newContext();
await ctx.addInitScript(t => { try { localStorage.setItem('aa_session', t); } catch (e) {} }, T);
const page = await ctx.newPage();

let fails = 0;
// Pages only — /interview and friends are JSON APIs, covered by isolation.mjs.
for (const p of ['/', '/login', '/setup', '/sourcing', '/pipeline', '/buy']) {
  const errs = [], bad = [];
  const onErr = e => errs.push(e.message);
  const onResp = r => { if (new URL(r.url()).origin === B && r.status() >= 400) bad.push(`${r.status()} ${new URL(r.url()).pathname}`); };
  page.on('pageerror', onErr); page.on('response', onResp);
  const res = await page.goto(B + p, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => ({ status: () => 'ERR ' + e.message }));
  await page.waitForTimeout(1800);
  page.off('pageerror', onErr); page.off('response', onResp);
  const clean = !errs.length && !bad.length;
  if (!clean) fails++;
  console.log(`${clean ? 'PASS' : 'FAIL'}  ${p.padEnd(11)} http ${res.status()}${errs.length ? '  jsErr: ' + errs.join('; ').slice(0, 90) : ''}${bad.length ? '  failedReq: ' + bad.join(', ') : ''}`);
}
console.log(`\n${fails ? fails + ' page(s) with errors' : 'all pages clean'}`);
// Nothing may scroll sideways on a phone. Eleven footer links in a row that
// could not wrap took the homepage to 615px inside a 390px screen.
const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
const small = await phone.newPage();
let sloppy = 0;
for (const p of ['/', '/text', '/about', '/demo', '/buy', '/extension', '/agents', '/faq', '/privacy', '/terms']) {
  const r = await small.goto(B + p, { waitUntil: 'networkidle' }).catch(() => null);
  if (!r || r.status() >= 400) continue;
  await small.waitForTimeout(400);
  const width = await small.evaluate(() => ({ scroll: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
  const overflows = width.scroll > width.view + 1;
  if (overflows) sloppy++;
  console.log(`${overflows ? 'FAIL' : 'PASS'}  ${p.padEnd(11)} ${width.scroll}px in ${width.view}px`);
}
await phone.close();
if (sloppy) { console.error(`${sloppy} page(s) scroll sideways on a phone`); process.exitCode = 1; }
else console.log('\nno page scrolls sideways at 390px');

await browser.close();
process.exit(fails ? 1 : 0);
