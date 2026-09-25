// The text line as an agent rather than a command parser.
//
// Routing by regex meant every phrasing nobody predicted fell through to a
// menu, and every reply was a string written months earlier. This reads what
// somebody said, decides what to do about it, does it, and writes the reply
// itself. The tools are the same authenticated operations the website and the
// extension use, so credits, ownership and refusals behave identically however
// somebody asks.
//
// What is deliberately not the agent's to decide: STOP and START, which are
// carrier obligations and must be exact, and whether an action costs money.
// Each tool enforces its own cost the way its HTTP route always has.

const TOOLS = [
  { name: 'list_matches', description: 'Roles that fit this person right now, from their pipeline or the shared listings ledger. Free. Use this whenever they ask what is available, what fits them, or whether anything new has come up.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'write_kit', description: 'Offer to write the whole application for one job: a resume tailored to that posting, a cover letter, and answers to the form\'s questions. Costs 10 credits. This sends a priced confirmation and waits for the user. Use only when they want an application, not when they ask for advice about a role.',
    input_schema: { type: 'object', properties: {
      url: { type: 'string', description: 'The job posting URL, when they sent one' },
      choice: { type: 'integer', description: 'Which of the roles you last listed, counting from 1' },
    } } },
  { name: 'rewrite_resume', description: 'Redo the tailored resume for the application you last wrote, using everything they have told you since. Costs 8 credits.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'start_search', description: 'Search the job sources now for new roles. Costs a few credits and runs in the background. Only when they ask for it.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'account', description: 'Their credit balance and pipeline counts. Free.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'remember_fact', description: 'Record a correction or fact about this person, which is then applied to everything written about them from that point on. Use it when they tell you something true about themselves, or correct something.',
    input_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string', description: 'The fact in their own words, as a plain sentence' } } } },
  { name: 'list_corrections', description: 'The corrections already on record for them. Free.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'forget_correction', description: 'Drop one correction by its position in the list.',
    input_schema: { type: 'object', required: ['choice'], properties: { choice: { type: 'integer' } } } },
  { name: 'set_job_status', description: 'Mark one of the roles you listed as applied or skipped.',
    input_schema: { type: 'object', required: ['choice', 'status'], properties: {
      choice: { type: 'integer' }, status: { type: 'string', enum: ['applied', 'skipped'] } } } },
  { name: 'save_answer', description: 'Save their answer to the question you last asked them, and get the next one. Only when a question is open.',
    input_schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string', description: 'What they said, in their own words' } } } },
];

// The context a reply depends on. Kept small: everything here is sent on every
// message, and a text line is supposed to be cheap.
function situation({ credits, listed = [], openQuestion = null, lastKit = null, targeting = '', repliedTo = null, repliedToUrl = null }) {
  const lines = [];
  if (repliedTo) lines.push(`They replied to your message about ${repliedTo}${repliedToUrl ? ` (${repliedToUrl})` : ''}. This identifies the role, not permission to spend credits. Answer their actual question. Only offer writing if they ask for an application.`);
  lines.push(`They have ${credits ?? 'an unknown number of'} credits.`);
  if (targeting) lines.push(`They are looking for: ${targeting}.`);
  if (listed.length) lines.push(`Roles you listed last, in order:\n${listed.map((j, i) => `${i + 1}. ${j.company}: ${j.role}`).join('\n')}`);
  if (lastKit) lines.push(`The last application you wrote for them was ${lastKit}.`);
  if (openQuestion) lines.push(`You asked them this and are waiting for the answer: "${openQuestion}". Read their message as that answer unless it is plainly something else.`);
  else lines.push('No question of yours is open.');
  return lines.join('\n');
}

const MAX_ROUNDS = 4;

// One turn: their message in, your reply out, with whatever work happened in
// between. Returns null when the model cannot be reached, so the caller can
// fall back rather than leave somebody unanswered.
async function run({ voice, message, context, callModel, invoke, log = () => {} }) {
  const system = `${voice}

## Right now

${situation(context)}

## How to work

You have tools. Use them rather than describing what you would do. If they ask
what fits them, call list_matches and tell them what came back. Discussing a
job or liking a role is not permission to write it. If they tell you something true
about themselves, call remember_fact.

Paid tools send a confirmation themselves. Never say the application was written,
the resume updated, or a search started when the tool only offered it.
Recent conversation is context, not fresh authorization. If a reply is ambiguous,
ask which role or action they mean. Acknowledge discouragement before offering work.
Never describe a match percentage as the chance of being hired.

Never claim you have done something you have not done with a tool. Never
promise to do something later: this is the only moment you have.

Anything that spends credits is worth one short sentence saying what it cost,
never an apology for it.

When a tool gives you a link, put that exact link in your reply. Telling
somebody their application is ready without the link is worse than saying
nothing. When you ask them about a role, name the company: they are reading
this on a phone, hours later, with no idea which job you mean.

Reply with the message to send them and nothing else. No greeting, no sign-off.`;

  const messages = [...(context.history || []).slice(-12), { role: 'user', content: message }];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const reply = await callModel({ system, messages, tools: TOOLS });
    if (!reply) return null;
    const calls = (reply.content || []).filter(c => c.type === 'tool_use');
    const text = (reply.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
    if (!calls.length) return text || null;

    messages.push({ role: 'assistant', content: reply.content });
    const results = [];
    for (const call of calls) {
      log(`tool ${call.name}`);
      let output;
      try { output = await invoke(call.name, call.input || {}); }
      catch (e) { output = { error: e.message }; }
      // A confirmation/result already delivered by code ends the turn. More
      // model calls could bury the offer or falsely announce completion.
      if (output?.already_sent === true) return null;
      results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(output ?? null).slice(0, 4000) });
    }
    messages.push({ role: 'user', content: results });
  }
  // Out of rounds: say the last thing it said rather than nothing.
  return null;
}

// The model is told to pass links on, and usually does. This makes sure of it:
// being told your application is ready with no way to open it is the worst
// version of this product, and it is one forgotten sentence away at all times.
function withLinks(text, links = []) {
  let out = String(text || '').trim();
  for (const link of links) if (link && !out.includes(link)) out += `\n\n${link}`;
  return out;
}

module.exports = { run, TOOLS, situation, MAX_ROUNDS, withLinks };
