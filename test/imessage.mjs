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
const POSTING = 'About the role: own the product roadmap end to end, from discovery through launch. Responsibilities: ship weekly, talk to customers every week, define the success metric before the spec, and report outcomes to the leadership team. Qualifications: five years of product experience, strong written communication, comfort with data and experimentation, and a track record of launching products end to end. You will work with engineering and design every day, run planning, and own adoption of what you ship.';
await db.saveKit({ id: 'chat-kit', user_email: email, url: job1, company: 'ChatCo', role: 'Head of Product', fit_score: 9, job_description: POSTING,
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
// Only applyapply's side of the thread (the user's own bubbles render as .out).
const replies = page => page.$$eval('.b.in', els => els.map(e => e.textContent));
async function open(as) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(origin + '/');
  if (as) await page.evaluate(t => localStorage.setItem('aa_session', t), jwt.sign({ email: as }, process.env.APPLYAPPLY_JWT_SECRET));
  await page.goto(origin + '/imessage');
  return page;
}
async function send(page, text, until) {
  const before = (await replies(page)).length;
  await page.fill('#text', text);
  await page.click('#send');
  await page.waitForFunction(([n, re]) => { const all = [...document.querySelectorAll('.b.in')].map(e => e.textContent); return all.length > n && new RegExp(re).test(all.slice(n).join('\n')); }, [before, until], { timeout: 20000 });
  return (await replies(page)).slice(before);
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
  let got = await send(page, 'check this out ' + job1.replace('https://', ''), 'saving answers is free');
  assert.equal(got.length, 1, 'One reply, not a wall of messages: ' + JSON.stringify(got));
  assert.match(got[0], /^your chatco application is ready\./);
  const kitLink = got[0].match(/https?:\/\/\S+\/k\/[A-Za-z0-9_-]{16}/)?.[0];
  assert.match(got[0], /\nhttps?:\S+\/k\/[A-Za-z0-9_-]{16}\n\n/, 'the link stands on its own line so it unfurls');
  assert.match(got[0], /tailored resume, cover letter and answers/);
  assert.ok(!got[0].includes('% match'), 'the message does not imply hiring odds');
  // The offer names the gaps: never "2 things" without saying which.
  assert.match(got[0], /can't yet show:\n• Built a consumer product\n• Shipped a browser extension/);
  assert.match(got[0], /saving answers is free/);
  // The voice: lower case, and no sentence the eye has to work through.
  const caps = got[0].replace(/https?:\/\/\S+/g, '').replace(/[^A-Z]/g, '').length;
  assert.ok(caps <= 2, 'the reply is lower case, apart from anything the posting itself capitalises: ' + caps);
  console.log('PASS: a job link comes back as one reply with the kit link and the resume offer');
  // The kit link opens on a phone that is not signed in, with files to attach.
  assert.ok(kitLink, 'Kit reply carries a /k/ link');
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await phoneCtx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const phone = await phoneCtx.newPage();
  await phone.goto(kitLink);
  // The whole block copies on tap, not just its button.
  await phone.click('.blk .ans >> nth=0');
  assert.equal(await phone.evaluate(() => navigator.clipboard.readText()), 'Why: Route Assist taught me trust.');
  assert.match(await phone.textContent('body'), /Match 64%/);
  assert.match(await phone.textContent('body'), /Launched Route Assist\./, 'Tailored resume shown');
  const save = await phone.request.post(kitLink + '/answer', { data: { question: 'Shipped a browser extension', answer: 'Built applyapply, 1.19 in the Chrome Web Store.' } });
  assert.equal(save.status(), 200);
  assert.equal((await phone.request.post(kitLink + '/answer', { data: { question: 'Not on this resume', answer: 'x' } })).status(), 400);
  assert.ok((await db.getEvidence(email, { answeredOnly: true })).some(r => /Chrome Web Store/.test(r.answer)));
  await phone.reload();
  assert.equal(await phone.inputValue('.gap[data-q="Shipped a browser extension"] textarea'), 'Built applyapply, 1.19 in the Chrome Web Store.', 'Answered gap shows its answer');
  assert.match(await phone.textContent('body'), /What you've told us[\s\S]*Chrome Web Store/, 'Saved answers are visible on the kit page');
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
  console.log('PASS: the kit link opens without sign-in, with PDFs, the tailored resume, copying and gap answers');

  got = await send(page, 'yes', '1 of 2');
  assert.match(got.at(-1), /1 of 2: Built a consumer product/);
  assert.match(got.at(-1), /for chatco, head of product/, 'the first question says which job it is about');
  assert.equal(got.length, 1, 'One question per text');
  got = await send(page, 'Ran the Tallyhouse consumer app, 200k MAU.', '2 of 2');
  assert.match(got.at(-1), /2 of 2: Shipped a browser extension/);
  // The rewrite itself needs a real model key, which this server does not have.
  const balanceBeforeAnswers = (await db.getUser(email)).credits;
  got = await send(page, 'Built applyapply, in the Chrome Web Store.', '8 credits');
  const saved = await db.getEvidence(email, { answeredOnly: true });
  assert.ok(saved.some(r => /200k MAU/.test(r.answer)) && saved.some(r => /Chrome Web Store/.test(r.answer)), 'Both answers saved');
  assert.match(got.at(-1), /saved 2 answers\./);
  assert.equal((await db.getUser(email)).credits, balanceBeforeAnswers, 'saving the last answer never triggers a paid rewrite');
  console.log('PASS: one question per text, answers saved, rewrite waits for consent');

  // A voice note (transcribed in the browser on this test line) arrives as text marked as voice.
  await page.evaluate(() => fetch('/imessage/send', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('aa_session') }, body: JSON.stringify({ text: 'status', voice: true, seconds: 20 }) }));
  await page.waitForFunction(() => [...document.querySelectorAll('.b')].some(b => /voice note/.test(b.textContent) && /status/.test(b.textContent)), null, { timeout: 10000 });
  await page.waitForFunction(() => /not searching|searching now/.test(document.querySelector('.b:last-of-type')?.textContent || [...document.querySelectorAll('.b')].at(-1).textContent), null, { timeout: 10000 });
  console.log('PASS: voice notes are marked and handled like texts');

  // Short notes are free; a long one costs a credit per extra minute.
  const before = (await db.getUser(email)).credits;
  await page.evaluate(() => fetch('/imessage/send', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('aa_session') }, body: JSON.stringify({ text: 'credits', voice: true, seconds: 100 }) }));
  await page.waitForTimeout(1500);
  assert.equal((await db.getUser(email)).credits, before, 'Under two minutes is free');
  await page.evaluate(() => fetch('/imessage/send', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('aa_session') }, body: JSON.stringify({ text: 'credits', voice: true, seconds: 260 }) }));
  await page.waitForFunction(n => [...document.querySelectorAll('.b')].some(b => b.textContent.includes(n + ' credits')), before - 3, { timeout: 10000 });
  const ledger = await db.pool.query("SELECT amount FROM credit_ledger WHERE user_email=$1 AND kind='voice_note'", [email]);
  assert.deepEqual(ledger.rows.map(r => r.amount), [-3], 'Charged per started minute past two');
  console.log('PASS: long voice notes are charged, short ones are free');

  // Each role is its own message with its own tracked link, so a reply can
  // land on one of them rather than describing which you meant.
  got = await send(page, 'matches', "pick its number");
  const roleMessages = got.filter(b => /^\d\) /.test(b));
  // A role you already have an application for is finished business: job1 was
  // written earlier in this test, so the queue does not offer it again.
  assert.equal(roleMessages.length, 1, 'only what is still to do: ' + JSON.stringify(got));
  assert.match(roleMessages[0], /^1\) chatco2, director of product/);
  assert.ok(!got.join('\n').includes('Head of Product'), 'the one already written is not re-offered');
  assert.match(roleMessages[0], /\/j\/[A-Za-z0-9_-]{6,}/, 'it carries a link we can see them open');
  // Unfurling is read-only. Only the explicit posting button records interest.
  const tracked = roleMessages[0].match(/https?:\/\/\S+\/j\/([A-Za-z0-9_-]+)/)[1];
  const hop = await page.request.get(origin + '/j/' + tracked, { maxRedirects: 0 });
  assert.equal(hop.status(), 200);
  const opened = await page.request.post(origin + '/j/' + tracked + '/open', { maxRedirects: 0 });
  assert.equal(opened.status(), 303);
  assert.equal(opened.headers().location, job2);
  assert.ok((await db.getActivity(email, 'opened')).some(a => a.url === job2), 'opening it is recorded');
  // And having opened it, the next listing says so rather than repeating itself.
  got = await send(page, 'matches', 'you opened this');
  assert.match(got.find(b => /^1\) /.test(b)) || '', /you opened this today/);
  got = await send(page, 'skip 1', 'skipped');
  assert.equal((await db.getJobByUrl(job2, email))?.status, 'skipped');
  got = await send(page, 'credits', 'credits');
  assert.match(got.at(-1), new RegExp('^' + (await db.getUser(email)).credits + ' credits'));
  const everythingSent = (await db.getChatMessages(email, 0)).filter(m => m.direction === 'out').map(m => m.body).join('\n');
  assert.ok(!everythingSent.includes('\u2014'), 'no em dashes in anything we send');
  assert.ok(!/tap (anything|any line|to copy)/i.test(everythingSent), 'a text message cannot promise tapping: there is nothing to tap in Messages');
  console.log('PASS: matches, pick, skip and credits');



  // Reset clears the conversation and only the kits the text line wrote.
  assert.ok(await db.findKit(job1, email), 'Kit exists before reset');
  const elsewhere = 'https://jobs.lever.co/elsewhere/pm';
  await db.saveKit({ id: 'extension-made-kit', user_email: email, url: elsewhere, company: 'Elsewhere', role: 'PM', job_description: POSTING, tailored: { why_role: 'w', cover_note: 'c', qa: [] } });
  const reset = await page.evaluate(() => fetch('/imessage/reset', { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('aa_session') } }).then(r => r.json()));
  assert.ok(reset.kits >= 1);
  assert.equal(await db.findKit(job1, email), null, 'Saved kits are cleared');
  assert.equal((await db.getChatMessages(email, 0)).length, 0, 'Conversation is cleared');
  assert.ok((await db.getEvidence(email, { answeredOnly: true })).length > 0, 'Saved answers survive a reset');
  assert.ok((await db.getJobs(null, 10, email)).length > 0, 'The pipeline survives a reset');
  assert.ok(await db.findKit(elsewhere, email), 'A kit made in the extension is untouched');
  console.log('PASS: reset clears the conversation and only the kits the text line wrote');

  // Two replies arriving together must not both act on the same question.
  await db.saveKit({ id: 'race-kit', user_email: email, url: 'https://jobs.lever.co/raceco/pm', company: 'RaceCo', role: 'PM', fit_score: 7,
    job_description: POSTING,
    tailored: { why_role: 'why', cover_note: 'note', qa: [] },
    tailored_resume: { name: 'R', summary: 's', experience: [], skills: [], jev_match: { score: 3 }, coverage: { confidence: 'thin', gaps: ['Gap one', 'Gap two', 'Gap three'] } } });
  const post = text => page.evaluate(t => fetch('/imessage/send', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('aa_session') }, body: JSON.stringify({ text: t }) }), text);
  await post('https://jobs.lever.co/raceco/pm');
  await page.waitForTimeout(2500);
  await Promise.all([post('yes'), post('yes')]);
  await page.waitForTimeout(3000);
  const outbound = (await db.getChatMessages(email, 0)).filter(m => m.direction === 'out').map(m => m.body);
  // The question now leads with the job it is about, so it is matched
  // anywhere in the message rather than at the start.
  assert.deepEqual(outbound.flatMap(b => b.match(/(\d) of 3:/g) || []), ['1 of 3:'], 'One question, not two');
  assert.ok(outbound.some(b => /tell me what you did there/i.test(b)), 'A bare yes is nudged, not saved as an answer');
  console.log('PASS: two replies at once cannot ask the same question twice');

  await page.screenshot({ path: '/tmp/applyapply-imessage.png' });
} finally { await browser.close(); await db.pool.end(); }
