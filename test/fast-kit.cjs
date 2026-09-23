// fast-kit selection logic with a stand-in for Jev: which answers get reused,
// what is never reused, and how bullets are ranked and kept.
const assert = require('node:assert/strict');
const path = require('node:path');
let respond = null;
require.cache[require.resolve(path.join(__dirname, '../server/typesafe'))] = { exports: { evaluate: async (_key, state, questions) => respond(state, questions) } };
const fastKit = require('../server/fast-kit');

(async () => {
  const pool = fastKit.answerPool(
    [{ question: 'Describe a product you took from zero to one.', answer: 'Route Assist: research, beta in six weeks, 4,000 weekly users.' },
     { question: 'Are you authorized to work in the US?', answer: 'Yes, I am a US citizen with no restrictions.' }],
    [{ tailored: { qa: [{ q: 'Describe a product you took from zero to one.', a: 'A duplicate that must not win over the profile answer.' },
                        { q: 'How do you decide what not to build?', a: 'Metric before spec; cut 19 bets to 7.' }] } }]);
  assert.deepEqual(pool.map(p => p.from), ['profile', 'kit'], 'profile answer first, duplicates and eligibility dropped');

  respond = (state, questions) => ({ answers: { pick: /scratch/.test(state.new_question) ? { choice: 'a0', confidence: 0.97 } : /prioritize/.test(state.new_question) ? { choice: 'a0', confidence: 0.6 } : { choice: 'none', confidence: 0.99 } } });
  const reused = await fastKit.reuseAnswers('key', [
    'Tell us about something you built from scratch.', 'How do you prioritize a roadmap?', 'Are you authorized to work in the United States?', 'What excites you about us?'], pool);
  assert.deepEqual([...reused.keys()], ['Tell us about something you built from scratch.'], 'only confident matches reused; eligibility never asked');
  assert.match(reused.get('Tell us about something you built from scratch.').a, /Route Assist/);

  // A correction beats a saved answer, which would otherwise be submitted
  // verbatim without any model ever reading it.
  const exitPool = fastKit.answerPool([
    { question: 'What is your proudest outcome?', answer: 'I sold three companies before founding this one.' },
    { question: 'What do you do best?', answer: 'Zero to one product work with small teams.' }], []);
  respond = (state, questions) => questions.conflict
    ? { answers: { conflict: { probability: /sold three/.test(state.saved_answer) ? 0.93 : 0.04 } } }
    : { answers: { pick: { choice: 'a0', confidence: 0.99 } } };
  const guarded = await fastKit.reuseAnswers('key', ['Tell us what you do best.'], exitPool, { facts: ['I have never sold a company.'] });
  assert.match(guarded.get('Tell us what you do best.').a, /Zero to one/, 'the contradicted answer is not offered for reuse');
  const kept = await fastKit.dropContradicted('key', exitPool, []);
  assert.equal(kept.length, 2, 'no corrections, no extra calls or filtering');

  // Relevance and strength are judged separately, then turned into a decision.
  const scores = { 'Organized the offsite': [0.2, 0.3], 'Shipped an AI planner': [3, 3], 'Grew revenue 4x at 200k users': [0.4, 3], 'Ran the weekly product review': [2, 1] };
  respond = (state) => ({ answers: Object.fromEntries(state.bullets.flatMap((b, i) => [['fit' + i, { score: scores[b][0] }], ['impact' + i, { score: scores[b][1] }]])) });
  const judged = await fastKit.judgeBullets('key', { experience: [
    { company: 'A', title: 'Dir', dates: '2022-', bullets: Object.keys(scores) }] }, { role: 'PM', description: 'AI' });
  assert.deepEqual(judged.map(f => [f.bullet, f.decision]), [
    ['Organized the offsite', 'drop'],
    ['Shipped an AI planner', 'keep'],
    ['Grew revenue 4x at 200k users', 'keep'],
    ['Ran the weekly product review', 'rewrite'],
  ], 'A standout achievement is kept even when the posting does not ask for it');

  const store = {}; let parses = 0;
  const db = { getResumeStructure: async e => store[e], saveResumeStructure: async (e, h, d) => { store[e] = { source_hash: h, data: d }; } };
  const model = async () => { parses++; return '{"summary":"","experience":[{"company":"A","title":"Dir","dates":"2022-","bullets":["x"]}],"skills":[]}'; };
  await fastKit.resumeStructure(db, model, 'u@test', 'resume v1');
  await fastKit.resumeStructure(db, model, 'u@test', 'resume v1');
  await fastKit.resumeStructure(db, model, 'u@test', 'resume v2');
  assert.equal(parses, 2, 'parsed once per resume text');
  console.log('PASS: answer reuse, eligibility guard, bullet relevance and resume structure cache');
})().catch(e => { console.error(e); process.exitCode = 1; });
