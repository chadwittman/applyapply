// What a text actually means.
//
// The line understood a short list of commands and answered everything else
// with a menu, which is a bad way to talk to somebody: "anything good today?"
// and "go look for jobs" are obvious requests that fell straight through to
// help. Exact commands and job links are still matched in code, instantly and
// for free. Everything left over comes here, where one Jev choice reads it.
const { evaluate } = require('./typesafe');

const CRITERIA = {
  matches: 'Asking what roles are available for them, or to see their matches, or whether anything good has come up',
  search: 'Asking us to go and look for new roles now',
  pick: 'Choosing one of the roles we just listed, by its position or by the company name',
  rewrite: 'Asking us to redo or improve the resume for the application we last wrote',
  remember: 'Telling us a fact or a correction about themselves, so we use it in what we write',
  corrections: 'Asking what corrections or facts we already have on record about them',
  status: 'Asking how their search or pipeline is going',
  credits: 'Asking about credits, cost, billing or payment',
  about: 'Asking what this is, what it does, or who or what they are talking to',
  help: 'Asking how to use it, what they can say to it, or what to do next',
  stop: 'Asking us to stop texting them',
  smalltalk: 'Thanks, hello, or anything friendly that is not a request',
  none: 'None of these: the message is about something else, or is too unclear to act on',
};

// A gap question is open, so most of what arrives is its answer rather than a
// new instruction. Only an unmistakable instruction should interrupt it.
const WHEN_ASKING = 'A question was just asked of this person and they are expected to answer it. Read this message as an answer unless it is plainly an instruction to do something else.';

async function readIntent(apiKey, message, { awaitingAnswer = false, listed = [] } = {}) {
  const text = String(message || '').trim();
  if (!apiKey || !text || text.length > 2000) return null;
  try {
    const data = await evaluate(apiKey, {
      message: text,
      roles_we_just_listed: listed.slice(0, 3).map((j, i) => `${i + 1}. ${j.company}: ${j.role}`),
      situation: awaitingAnswer ? WHEN_ASKING : 'No question is open. This message is an instruction or a request.',
    }, {
      intent: {
        type: 'choice',
        instructions: 'A person is texting a service that writes job applications for them. What are they asking for in `message`? Choose none unless one of these plainly fits.',
        criteria: CRITERIA,
      },
    });
    const answer = data.answers?.intent;
    if (!answer?.choice || answer.choice === 'none') return null;
    const confidence = Number(answer.confidence);
    // Acting on a guess is worse than asking. Below the bar we say what we can
    // do instead of doing the wrong thing with somebody's credits.
    if (!(confidence >= 0.75)) return null;
    return { intent: answer.choice, confidence };
  } catch (e) {
    console.error('[intent]', e.message);
    return null;
  }
}

// "do the watershed one" names a role rather than a number. The model says
// they are picking; code works out which, because a name match is exact.
function pickFromList(message, listed = []) {
  const text = String(message || '').toLowerCase();
  // "one" is not an ordinal: "the second one" ends with it.
  const ordinals = [/\b(first|1st|#?1)\b/, /\b(second|2nd|#?2)\b/, /\b(third|3rd|#?3)\b/];
  for (let i = 0; i < listed.length && i < 3; i++) {
    const company = String(listed[i]?.company || '').toLowerCase();
    if (company.length > 2 && text.includes(company)) return i;
  }
  for (let i = Math.min(ordinals.length, listed.length) - 1; i >= 0; i--) if (ordinals[i].test(text)) return i;
  return -1;
}

// What they said, without the lead-in, so a correction reads as a fact.
function factFrom(message) {
  return String(message || '').trim()
    .replace(/^(please\s+)?(just\s+)?(so you know|fyi|note that|remember that|remember|keep in mind|for the record|correction)\s*[:,]?\s*/i, '')
    .replace(/^(that|this)\s+/i, '')
    .trim();
}

module.exports = { readIntent, pickFromList, factFrom, CRITERIA };
