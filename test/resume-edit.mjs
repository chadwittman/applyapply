// Editing your own resume is the clearest statement of how you want to be
// described. It is kept, and later rewrites are shown it.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const db = require('./db.js');
const jwt = require('jsonwebtoken');
const origin = process.env.APP_ORIGIN;
const EMAIL = 'resumeedit@test.local';
const T = jwt.sign({ email: EMAIL }, 'e2e-test-secret-not-production', { expiresIn: '1d' });
await db.getOrCreateUser(EMAIL);
await db.saveKit({ id: 'editkit', user_email: EMAIL, url: 'https://jobs.lever.co/findem/abc', company: 'Findem', role: 'Head of Product',
  tailored: { cover_note: 'note', qa: [] },
  tailored_resume: { name: 'Chad', summary: 'A product leader.', skills: ['Roadmaps'],
    experience: [{ company: 'Dolly', title: 'CEO', dates: 'Jan 2014 - Jan 2020', bullets: ['Grew the business considerably.'] }] } });

const link = await (await fetch(origin + '/kit-link', { method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + T },
  body: JSON.stringify({ appId: 'editkit' }) })).json();
const base = String(link.kit_url);

// The page offers the resume as text you can edit, and a mic to talk into.
const page = await (await fetch(base)).text();
assert.match(page, /id="resume-text"/, 'the resume is an editable box');
assert.match(page, /id="resume-save"/);
assert.match(page, /<div class="gap-row"><textarea id="resume-text"[\s\S]{0,200}class="mic"/, 'with a mic, like every other box');

const save = text => fetch(base + '/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
assert.equal((await save('')).status, 400);

const original = 'A product leader.\n\nDolly · CEO · Jan 2014 - Jan 2020\n• Grew the business considerably.\n\nSkills: Roadmaps';
assert.equal((await (await save(original)).json()).unchanged, true, 'saving it untouched records nothing');
assert.equal((await db.getResumeEdits(EMAIL)).length, 0);

const edited = original.replace('Grew the business considerably.', 'Took Dolly from 0 to 4M in revenue in 3 years.');
const out = await (await save(edited)).json();
assert.equal(out.changes, 1);
const edits = await db.getResumeEdits(EMAIL);
assert.equal(edits.length, 1);
assert.match(edits[0].before, /Grew the business considerably/);
assert.match(edits[0].after, /0 to 4M in revenue/);
console.log('PASS: the resume is editable, and what changed is what gets kept');

// The edit survives on the page, and the next rewrite is told about it.
assert.match(await (await fetch(base)).text(), /0 to 4M in revenue/, 'the page shows their version');
assert.match(await (await fetch(base)).text(), /you edited this/);
await db.pool.end();
