// The answers UI: autosave with no Save button, a running tally, and answers
// that survive a reload.
import { createRequire } from 'module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const jwt = require('jsonwebtoken');
const db = require('./db.js');
const B = process.env.APP_ORIGIN || 'http://localhost:5099';
const EMAIL = 'ev@test.local';
const T = jwt.sign({ email: EMAIL }, 'e2e-test-secret-not-production', { expiresIn: '1d' });

await db.getOrCreateUser(EMAIL);
await db.addEvidenceQuestions(EMAIL, [{ question: 'Describe a time you owned a P&L.' }, { question: 'What is the largest team you led?' }]);

const b = await chromium.launch({
  headless: true,
  executablePath: process.env.AA_CHROME || undefined,
});
const ctx = await b.newContext();
await ctx.addInitScript(t => { try { localStorage.setItem('aa_session', t); } catch (e) {} }, T);
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(B + '/setup', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

const areas = await page.locator('#interviewList textarea').count();
ok('both questions rendered', areas === 2, `got ${areas}`);
const saveBtns = await page.locator('#interviewList button', { hasText: 'Save answer' }).count();
ok('no per-answer Save button', saveBtns === 0, `got ${saveBtns}`);
const mics = await page.locator('#interviewList button', { hasText: 'Speak it' }).count();
ok('a mic per question', mics === 2, `got ${mics}`);

// Type, then wait for the debounce to fire on its own.
await page.locator('#interviewList textarea').first().fill('I owned a 12M P&L at Dolly.');
await page.waitForTimeout(2200);
const status = await page.locator('#interviewList .hint').first().textContent();
ok('autosaved without pressing anything', /Saved/.test(status || ''), JSON.stringify(status));

const rows = await db.getEvidence(EMAIL, { answeredOnly: true });
ok('answer reached the database', rows.length === 1, `${rows.length} rows`);

const tally = await page.locator('#evidenceSummary').textContent();
console.log('   tally:', (tally || '').trim());
ok('tally says it is saved to the account', /1 answer saved to your account/.test(tally || ''));

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const persisted = await page.locator('#interviewList textarea').first().inputValue();
ok('survives a reload', persisted.includes('12M P&L'), persisted.slice(0, 40));

console.log('  page errors:', errs.length ? errs : 'none');
console.log(`\n${pass} passed, ${fail} failed`);
await b.close();
process.exit(fail || errs.length ? 1 : 0);
