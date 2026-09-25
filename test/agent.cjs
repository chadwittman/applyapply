// The text line as an agent: it reads the message, does the work with real
// operations, and writes the reply. The model is stubbed here; what is under
// test is the loop, the tools it is offered, and what it is told.
const assert = require('node:assert/strict');
const agent = require('../server/agent');

const VOICE = '# applyapply\nlower case, short.';

(async () => {
  // A reply with no tool call comes straight back.
  let reply = await agent.run({ voice: VOICE, message: 'what are you?', context: { credits: 40 },
    callModel: async () => ({ content: [{ type: 'text', text: "i'm applyapply. i write job applications." }] }),
    invoke: async () => ({}) });
  assert.match(reply, /applyapply/);

  // A tool call runs, its result goes back, and the second turn answers.
  const called = [];
  reply = await agent.run({ voice: VOICE, message: 'anything good?', context: { credits: 40 },
    callModel: async ({ messages }) => messages.length === 1
      ? { content: [{ type: 'tool_use', id: 't1', name: 'list_matches', input: {} }] }
      : { content: [{ type: 'text', text: '3 that fit: watershed, orb, ramp.' }] },
    invoke: async (name, input) => { called.push([name, input]); return { roles: [{ n: 1, company: 'Watershed' }] }; } });
  assert.deepEqual(called, [['list_matches', {}]]);
  assert.match(reply, /watershed/);

  // A tool that throws does not break the turn: the model is told and answers.
  reply = await agent.run({ voice: VOICE, message: 'write the first one', context: { credits: 0 },
    callModel: async ({ messages }) => {
      if (messages.length === 1) return { content: [{ type: 'tool_use', id: 't1', name: 'write_kit', input: { choice: 1 } }] };
      const result = JSON.parse(messages.at(-1).content[0].content);
      assert.ok(result.error, 'the failure reached the model');
      return { content: [{ type: 'text', text: "you're out of credits. top up and i'll write it." }] };
    },
    invoke: async () => { throw new Error('out of credits'); } });
  assert.match(reply, /out of credits/);

  // A model that never stops calling tools does not loop forever, and a model
  // that cannot be reached returns nothing so the caller can fall back.
  let rounds = 0;
  reply = await agent.run({ voice: VOICE, message: 'hi', context: {},
    callModel: async () => { rounds++; return { content: [{ type: 'tool_use', id: 'x', name: 'account', input: {} }] }; },
    invoke: async () => ({ credits: 1 }) });
  assert.equal(reply, null);
  assert.equal(rounds, agent.MAX_ROUNDS, 'bounded at ' + agent.MAX_ROUNDS + ' rounds');
  assert.equal(await agent.run({ voice: VOICE, message: 'hi', context: {}, callModel: async () => null, invoke: async () => ({}) }), null);

  // What the model is told about the moment it is in.
  const now = agent.situation({ credits: 12, listed: [{ company: 'Orb', role: 'Head of Product' }], openQuestion: 'Have you run paid acquisition?' });
  assert.match(now, /12 credits/);
  assert.match(now, /1\. Orb: Head of Product/);
  assert.match(now, /waiting for the answer: "Have you run paid acquisition\?"/);
  assert.match(agent.situation({ credits: 3 }), /No question of yours is open/);
  // Replying to one message out of several is unambiguous, so the agent is
  // told what it was about instead of asking which one.
  const onOne = agent.situation({ credits: 5, repliedTo: 'Watershed, Head of Product', repliedToUrl: 'https://x/y' });
  assert.match(onOne, /replied to your message about Watershed, Head of Product/);
  assert.match(onOne, /not permission to spend credits/);

  // Every tool the line can perform is described for the model, and the ones
  // that spend say so.
  const names = agent.TOOLS.map(t => t.name);
  for (const t of ['list_matches', 'write_kit', 'rewrite_resume', 'start_search', 'account', 'remember_fact', 'save_answer', 'set_job_status']) {
    assert.ok(names.includes(t), t);
  }
  assert.match(agent.TOOLS.find(t => t.name === 'write_kit').description, /Costs 10 credits/);
  assert.ok(!names.includes('submit_application'), 'submitting is never the agent\'s to do');
  // Being told your application is ready, with no link, is a dead end.
  assert.match(agent.TOOLS.find(t => t.name === 'write_kit').description, /resume tailored/);
  const system = [];
  await agent.run({ voice: VOICE, message: 'write it', context: { credits: 40 },
    callModel: async (req) => { system.push(req.system); return { content: [{ type: 'text', text: 'done' }] }; },
    invoke: async () => ({}) });
  assert.match(system[0], /put that exact link in your reply/, 'the model is told to pass links on');
  assert.match(system[0], /name the company/, 'and to say which job it is asking about');
  // And if it forgets anyway, the link is added rather than lost.
  const link = 'https://applyapply.xyz/k/abc123';
  assert.equal(agent.withLinks('your resume is ready.', [link]), `your resume is ready.\n\n${link}`);
  assert.equal(agent.withLinks(`ready: ${link}`, [link]), `ready: ${link}`, 'not repeated when it is already there');
  assert.equal(agent.withLinks('nothing to add', []), 'nothing to add');
  console.log('PASS: the agent runs tools, survives their failures, and is bounded');
})();
