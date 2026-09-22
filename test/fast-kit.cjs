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

  respond = (state) => ({ answers: Object.fromEntries(state.bullets.map((b, i) => ['b' + i, { score: /offsite/.test(b) ? 0.2 : /AI/.test(b) ? 3 : 1.5 }])) });
  const scored = await fastKit.rankBullets('key', { experience: [
    { company: 'A', title: 'Dir', dates: '2022-', bullets: ['Organized the offsite', 'Shipped an AI planner'] },
    { company: 'B', title: 'PM', dates: '2019-2022', bullets: ['Wrote docs'] }] }, { role: 'PM', description: 'AI' });
  assert.deepEqual(scored.map(f => [f.r, f.bullet, f.score]), [[0, 'Organized the offsite', 0.2], [0, 'Shipped an AI planner', 3], [1, 'Wrote docs', 1.5]]);

  const store = {}; let parses = 0;
  const db = { getResumeStructure: async e => store[e], saveResumeStructure: async (e, h, d) => { store[e] = { source_hash: h, data: d }; } };
  const model = async () => { parses++; return '{"summary":"","experience":[{"company":"A","title":"Dir","dates":"2022-","bullets":["x"]}],"skills":[]}'; };
  await fastKit.resumeStructure(db, model, 'u@test', 'resume v1');
  await fastKit.resumeStructure(db, model, 'u@test', 'resume v1');
  await fastKit.resumeStructure(db, model, 'u@test', 'resume v2');
  assert.equal(parses, 2, 'parsed once per resume text');
  console.log('PASS: answer reuse, eligibility guard, bullet relevance and resume structure cache');
})().catch(e => { console.error(e); process.exitCode = 1; });
