// The /imessage test line in Chrome, over the real conversation engine.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const jwt = require('jsonwebtoken');
const db = require('./db');
const origin = process.env.APP_ORIGIN;
const email = 'chat@test.local', outsider = 'outsider@test.local';
const job1 = 'https://jobs.lever.co/chatco/head-of-product', job2 = 'https://jobs.lever.co/chatco2/director-of-product';
for (const e of [email, outsider]) await db.getOrCreateUser(e);
await db.pool.query('UPDATE users SET credits=40 WHERE email=$1', [email]);
await db.saveKit({ id: 'chat-kit', user_email: email, url: job1, company: 'ChatCo', role: 'Head of Product', fit_score: 9,
  tailored_resume: { name: 'Chat Tester', summary: 'Product leader.', experience: [{ company: 'Parcelworks', title: 'Director of Product', dates: '2022 - Present', bullets: ['Launched Route Assist.'] }], skills: ['SQL'],
    jev_match: { score: 3.2 }, coverage: { confidence: 'moderate', gaps: ['Built a consumer product', 'Shipped a browser extension'] } },
  tailored: { why_role: 'Why: Route Assist taught me trust.', cover_note: 'Hi ChatCo team.', qa: [
    { q: 'Describe a product you took from zero to one.', a: 'Route Assist, 4,000 weekly users.' },
    { q: 'When can you start?', a: '' }] } });
await db.saveSourceRun({ id: 'chat-run', date: '2026-09-22', sources: 1, found: 2, excluded: 0, duration_ms: 1, user_email: email }, [
  { url: job1, company: 'ChatCo', role: 'Head of Product', found_at: '2026-09-22', tier: 1, fit_score: 9 },
  { url: job2, company: 'ChatCo2', role: 'Director of Product', found_at: '2026-09-22', tier: 2, fit_score: 8 }], { sources: [] });

const browser = await chromium.launch({ headless: true, executablePath: process.env.AA_CHROME || undefined });
const bubbles = page => page.$$eval('.b', els => els.map(e => e.textContent));
async function open(as) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(origin + '/');
  if (as) await page.evaluate(t => localStorage.setItem('aa_session', t), jwt.sign({ email: as }, process.env.APPLYAPPLY_JWT_SECRET));
  await page.goto(origin + '/imessage');
  return page;
}
async function send(page, text, until) {
  const before = (await bubbles(page)).length;
  await page.fill('#text', text);
  await page.click('#send');
  await page.waitForFunction(([n, re]) => { const all = [...document.querySelectorAll('.b')].map(e => e.textContent); return all.length > n + 1 && new RegExp(re).test(all.slice(n).join('\n')); }, [before, until], { timeout: 15000 });
  return (await bubbles(page)).slice(before);
}
try {
  const out = await open(null);
  assert.match(await out.textContent('.gate'), /Sign in/);
  const stranger = await open(outsider);
  await stranger.waitForSelector('.gate');
  assert.match(await stranger.textContent('.gate'), /private testing/);
  console.log('PASS: signed out and non-testers are kept out');

  const page = await open(email);
  await page.waitForSelector('#bar:not([hidden])');
  await page.waitForTimeout(7000); // several polls on an empty conversation
  assert.equal((await bubbles(page)).length, 1, 'The greeting shows once, not on every poll');
  let got = await send(page, 'check this out ' + job1.replace('https://', ''), 'Reply yes');
  assert.ok(got.some(b => /ChatCo, Head of Product\. Match 9\/10\. Your kit, with your resume and cover letter as PDFs/.test(b)));
  assert.ok(got.includes('Route Assist, 4,000 weekly users.'), 'Each answer is its own bubble');
  assert.ok(got.some(b => /left them blank:\n• When can you start\?/.test(b)));
  assert.match(got.at(-1), /3\.2\/5 match\. It doesn't show 2 things this role asks for\. Want to answer them/);
  console.log('PASS: a job link (even without https://) comes back as a kit, one answer per bubble');
  // The kit link opens on a phone that is not signed in, with files to attach.
  const kitLink = got.join('\n').match(/https?:\/\/\S+\/k\/[A-Za-z0-9_-]{16}/)?.[0];
  assert.ok(kitLink, 'Kit reply carries a /k/ link');
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await phoneCtx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const phone = await phoneCtx.newPage();
  await phone.goto(kitLink);
  // The whole block copies on tap, not just its button.
  await phone.click('.blk .ans >> nth=0');
  assert.equal(await phone.evaluate(() => navigator.clipboard.readText()), 'Why: Route Assist taught me trust.');
  assert.match(await phone.textContent('body'), /Match: Solid 3\.2\/5/);
  assert.match(await phone.textContent('body'), /Launched Route Assist\./, 'Tailored resume shown');
  const save = await phone.request.post(kitLink + '/answer', { data: { question: 'Shipped a browser extension', answer: 'Built applyapply, 1.19 in the Chrome Web Store.' } });
  assert.equal(save.status(), 200);
  assert.equal((await phone.request.post(kitLink + '/answer', { data: { question: 'Not on this resume', answer: 'x' } })).status(), 400);
  assert.ok((await db.getEvidence(email, { answeredOnly: true })).some(r => /Chrome Web Store/.test(r.answer)));
  await phone.reload();
  assert.equal(await phone.inputValue('.gap[data-q="Shipped a browser extension"] textarea'), 'Built applyapply, 1.19 in the Chrome Web Store.', 'Answered gap shows its answer');
  assert.match(await phone.textContent('h1'), /ChatCo/);
  assert.match(await phone.textContent('body'), /Route Assist, 4,000 weekly users\./);
  assert.match(await phone.textContent('body'), /Only you can answer[\s\S]*When can you start\?/);
  for (const file of ['resume.pdf', 'cover-letter.pdf']) {
    const r = await phone.request.get(kitLink + '/' + file);
    assert.equal(r.status(), 200, file); assert.equal(r.headers()['content-type'], 'application/pdf');
    assert.equal((await r.body()).subarray(0, 5).toString(), '%PDF-');
  }
  assert.equal((await phone.request.get(origin + '/k/AAAAAAAAAAAAAAAA')).status(), 404);
  await phone.screenshot({ path: '/tmp/applyapply-kitlink.png', fullPage: true });
  console.log('PASS: the kit link opens without sign-in, with PDFs, the tailored resume, tap-to-copy and gap answers');

  got = await send(page, 'yes', '1 of 2');
  assert.match(got.at(-1), /1 of 2: Built a consumer product/);
  got = await send(page, 'Ran the Tallyhouse consumer app, 200k MAU.', '2 of 2');
  assert.ok(got.includes('Saved to your profile.'));
  assert.ok((await db.getEvidence(email, { answeredOnly: true })).some(r => /200k MAU/.test(r.answer)));
  got = await send(page, 'skip', 'rewrite');
  assert.match(got.at(-1), /That's all of them\. Want me to rewrite your resume/);
  console.log('PASS: the resume offer asks each gap in turn, saves answers and ends with a rewrite offer');

  // A voice note (transcribed in the browser on this test line) arrives as text marked as voice.
  await page.evaluate(t => fetch('/imessage/send', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('aa_session') }, body: JSON.stringify({ text: 'status', voice: true }) }), null);
  await page.waitForFunction(() => [...document.querySelectorAll('.b')].some(b => /voice note/.test(b.textContent) && /status/.test(b.textContent)), null, { timeout: 10000 });
  await page.waitForFunction(() => /No search running|A search is running/.test(document.querySelector('.b:last-of-type')?.textContent || [...document.querySelectorAll('.b')].at(-1).textContent), null, { timeout: 10000 });
  console.log('PASS: voice notes are marked and handled like texts');

  got = await send(page, 'matches', 'Reply 1, 2 or 3');
  assert.match(got.at(-1), /1\) ChatCo, Head of Product[\s\S]*2\) ChatCo2, Director of Product/);
  got = await send(page, 'skip 2', 'Skipped');
  assert.equal((await db.getJobByUrl(job2, email))?.status, 'skipped');
  got = await send(page, '1', 'Your kit, with');
  got = await send(page, 'credits', 'credits');
  assert.match(got.at(-1), /You have 40 credits/, 'Saved kits are free');
  console.log('PASS: matches, pick, skip and credits');



  const calls = await db.pool.query("SELECT COUNT(*)::int n FROM chat_messages WHERE user_email=$1", [email]);
  assert.ok(calls.rows[0].n > 10);
  await page.screenshot({ path: '/tmp/applyapply-imessage.png' });
} finally { await browser.close(); await db.pool.end(); }
