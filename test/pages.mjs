// Every page, in a real browser, with a real session — after tightening auth
// the risk is a page that silently renders empty because its fetch now 401s.
import { createRequire } from 'module';
const require = createRequire('/Users/chaztyler/job-search/server/package.json');
const { chromium } = require('playwright-core');
const jwt = require('jsonwebtoken');
const B = 'http://localhost:5099';
const T = jwt.sign({ email: 'alice@test.local' }, 'e2e-test-secret-not-production', { expiresIn: '1d' });

const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
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
await browser.close();
process.exit(fails ? 1 : 0);
