// The text-message experience: a person texts applyapply and it answers.
// Channel-agnostic: `deliver` decides where replies go. Today that is the
// /imessage test page; with Sendblue it will also send a real iMessage.
//
// Everything a message can do goes through the existing HTTP routes with the
// person's own session, so credits, idempotency and ownership behave exactly
// as they do on the site and in the extension.
const http = require('http');
const { readIntent, pickFromList, factFrom } = require('./intent');
const agent = require('./agent');
const fs = require('fs');
const pathlib = require('path');

// The voice and the claims, in one file, so what applyapply says about itself
// lives somewhere a person can read and edit rather than scattered through
// string literals. Borrowed from how OpenClaw gives an agent a SOUL.md.
const VOICE = (() => {
  try { return fs.readFileSync(pathlib.join(__dirname, 'voice.md'), 'utf8'); } catch { return ''; }
})();

// applyapply talks in lower case and says the least it can. A text is read in
// two seconds on a lock screen, so anything that is not the answer is noise.
const HELP = [
  'send a job link, i write the application.',
  '',
  'matches: roles that fit you',
  '1 2 3: write that one',
  'skip 2 · applied 1: update it',
  'rewrite: redo the resume with your answers',
  'remember <fact>: a correction i apply everywhere',
  'search · status · credits · corrections',
  '',
  '👍 a question and i take it as yes.',
].join('\n');

// A job link anywhere in the message, with or without https://.
function findJobLink(text) {
  const full = String(text).match(/https?:\/\/[^\s<>"']+/i);
  if (full) return full[0].replace(/[).,;!?]+$/, '');
  const bare = String(text).match(/\b((?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"']+)/i);
  return bare ? 'https://' + bare[1].replace(/[).,;!?]+$/, '') : null;
}

// What this is, for "what are you?" and for a first hello. The three things it
// does, in the order they happen to you.
const WHAT_I_AM = [
  'i\'m applyapply. three things:',
  '',
  'i find job postings that fit you.',
  'i write a resume tailored to each one, plus the cover letter and the form\'s own questions.',
  'you read it and send it, in about a minute.',
].join('\n');

// Never say "3 things" without saying which: the person has to know what they
// are being asked before they answer.
const listGaps = gaps => gaps.map(g => '• ' + String(g).replace(/\s+/g, ' ').trim()).join('\n');

module.exports = function conversation({ db, port, signToken, origin, kitLink, resumeCost = 8, polish = null, deliver = null, ledgerMatches = null, react = null, typeSafeKey = null, askModel = null, callModel = null }) {
  const typing = new Map(); // email -> since (ms); the test page shows dots

  function api(email, method, path, body) {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { authorization: 'Bearer ' + signToken(email), 'content-type': 'application/json', ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) };
    return new Promise(resolve => {
      const req = http.request({ host: '127.0.0.1', port, path, method, headers, timeout: 170000 }, res => {
        let raw = ''; res.setEncoding('utf8');
        res.on('data', c => { raw += c; });
        res.on('end', () => { let data = null; try { data = JSON.parse(raw); } catch {} resolve({ status: res.statusCode, data }); });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', e => resolve({ status: 0, data: { error: e.message } }));
      if (payload) req.write(payload);
      req.end();
    });
  }

  // Saved first, sent second. The thread in the database is the record: the
  // test page reads it, the real line is one more place the same message goes,
  // and a delivery failure must not lose what was said.
  async function say(email, bodies, meta = null) {
    for (const body of [].concat(bodies).filter(Boolean)) {
      await db.addChatMessage(email, 'out', body, meta);
      if (deliver) await deliver(email, body, meta).catch(e => console.error('[deliver]', e.message));
    }
  }

  async function withTyping(email, fn) {
    typing.set(email, Date.now());
    try { return await fn(); } finally { typing.delete(email); }
  }

  // The last numbered list we sent, so "1" or "skip 2" knows which job.
  async function lastList(email) {
    const row = await db.lastChatMeta(email, 'matches');
    return row?.meta?.jobs || [];
  }

  async function writeKit(email, url, { force = false } = {}) {
    return withTyping(email, async () => {
      const r = await api(email, 'POST', '/generate', { url, force });
      if (r.status === 402) return say(email, `out of credits. top up: ${origin}/buy`);
      if (r.status === 422 && r.data?.error) return say(email, r.data.error);
      if (r.status !== 200 || !r.data?.tailored) return say(email, 'couldn\'t read that one. check the link opens a job posting and send it again.');
      const kit = r.data, t = kit.tailored;
      // One text: the link to everything, and the offer to tune the resume.
      // The kit page holds the answers, the PDFs and the copy buttons.
      const token = kitLink ? await kitLink(email, kit.id).catch(() => null) : null;
      const link = token ? `${origin}/k/${token}` : `${origin}/${kit.url}`;
      const gaps = kit.tailored_resume?.coverage?.gaps || [];
      const score = kit.tailored_resume?.jev_match?.score;
      const answers = (t.qa || []).filter(x => x.a).length;
      // The card on the link already shows the company, the role and the
      // match, so the message does not repeat them.
      const parts = [
        `${(kit.company || 'this role').toLowerCase()}: done.`,
        link,
        `resume${score ? ` (${Math.round((Number(score) / 5) * 100)}% match)` : ''}, cover letter, ${answers ? `${answers} answer${answers === 1 ? '' : 's'}` : 'your details'}, ready to paste.`,
        gaps.length ? `can't show ${gaps.length === 1 ? 'one thing' : `${gaps.length} things`} it asks for:\n${listGaps(gaps)}\n\n👍 or "yes" and i'll ask, one at a time, then redo the resume (${resumeCost} credits).` : null,
      ].filter(Boolean);
      await say(email, parts.join('\n\n'), { kind: gaps.length ? 'resume_offer' : 'kit', url: kit.url, kit_id: kit.id, link, gaps, company: kit.company, role: kit.role });
    });
  }

  // One question per text, so each can be answered on its own. The rewrite
  // runs once the last one is answered (or the person says done).
  // Which job this is about. A question arriving on a phone hours later is
  // unanswerable if it does not say what it is for.
  const jobLabel = meta => [meta?.company, meta?.role].filter(Boolean).join(', ').toLowerCase();

  async function askGap(email, meta) {
    const open = meta.open || meta.gaps;
    const [question, ...rest] = open;
    const total = meta.gaps.length, answered = meta.answered || 0;
    const n = total - open.length + 1;
    const about = jobLabel(meta);
    await say(email, `${about && n === 1 ? `for ${about}.\n\n` : ''}${n} of ${total}: ${question}\nyour words, or a voice note. "skip" to pass.`,
      { ...meta, kind: 'gap_question', question, open: rest, answered });
  }

  async function rewriteResume(email, meta, note) {
    return withTyping(email, async () => {
      const r = await api(email, 'POST', '/resume-tailor', { appId: meta.kit_id });
      if (r.status === 402) return say(email, `out of credits, so i couldn't rewrite it. top up: ${origin}/buy`);
      if (r.status !== 200) return say(email, 'couldn\'t rewrite it. your answers are saved: try "rewrite" again in a moment.');
      const pct = x => Math.round((Number(x) / 5) * 100);
      const score = r.data.jev_match?.score, was = Number(r.data.previous_match_score);
      const used = Number(r.data.evidence_used) || 0;
      const gaps = r.data.coverage?.gaps || [];
      const move = score && Number.isFinite(was)
        ? pct(score) > pct(was) ? `match ${pct(score)}%, up from ${pct(was)}%.` : `match ${pct(score)}%, about the same.`
        : score ? `match ${pct(score)}%.` : '';
      await say(email, [note, `${jobLabel(meta) ? jobLabel(meta) + ': ' : ''}resume redone${used ? ` with ${used} of your answers` : ''}. ${move}`.trim(), meta.link || `${origin}/${meta.url}`,
        gaps.length ? `still can't show ${gaps.length === 1 ? 'one thing' : gaps.length + ' things'} the posting asks for:\n${listGaps(gaps)}\n\n👍 or "yes" and i'll ask.` : null].filter(Boolean).join('\n\n'),
      { kind: gaps.length ? 'resume_offer' : 'kit', kit_id: meta.kit_id, url: meta.url, link: meta.link, gaps });
    });
  }

  // Their pipeline first, then the shared ledger. Reading the ledger costs
  // nothing and runs no search, so a new person gets real roles in their first
  // reply instead of being asked to go and find one.
  async function bestThree(email) {
    const mine = (await db.getJobs('new', 50, email).catch(() => []))
      .sort((a, b) => (a.tier ?? 9) - (b.tier ?? 9) || (b.fit_score ?? 0) - (a.fit_score ?? 0));
    if (mine.length) return mine.slice(0, 3);
    return ledgerMatches ? (await ledgerMatches(email).catch(() => [])).slice(0, 3) : [];
  }

  // First contact. Nobody wants to be asked for homework by a product they
  // just connected, so this leads with what it found.
  async function welcome(email) {
    const jobs = await bestThree(email);
    if (!jobs.length) {
      return say(email, `${WHAT_I_AM}\n\nsend me a job link to start, or say "search" and i'll go find roles that fit you.`);
    }
    return say(email, `${WHAT_I_AM}\n\n${jobs.length} that fit you right now:\n${jobs.map((j, i) => `${i + 1}) ${j.company}, ${j.role}`).join('\n')}\n\nreply 1, 2 or 3 and i\'ll write it. or send any job link.`,
      { kind: 'matches', jobs: jobs.map(j => ({ url: j.url, company: j.company, role: j.role })) });
  }

  async function matches(email) {
    const jobs = await bestThree(email);
    if (!jobs.length) return say(email, 'nothing new that fits right now. text "search" and i\'ll go look.');
    await say(email, `${jobs.length} that fit you:\n${jobs.map((j, i) => `${i + 1}) ${j.company}, ${j.role}`).join('\n')}\n\nreply 1, 2 or 3 and i'll write it.`,
      { kind: 'matches', jobs: jobs.map(j => ({ url: j.url, company: j.company, role: j.role })) });
  }

  // Two messages arriving together used to read the same state and both act on
  // it (asking "1 of 4" twice). One message per person at a time, and each
  // question is claimed in the database before it is acted on.
  const queues = new Map();
  function handle(email, text, options) {
    const run = (queues.get(email) || Promise.resolve()).catch(() => {}).then(() => handleOne(email, text, options));
    queues.set(email, run);
    run.finally(() => { if (queues.get(email) === run) queues.delete(email); });
    return run;
  }

  // voice: the message was a voice note, already transcribed.
  async function handleOne(email, text, options = {}) {
    const { voice = false, replay = false, channel = null } = options;
    const message = String(text || '').trim();
    // Recording the message is this function's job, and only this function's:
    // the webhook used to write it too, so every text arrived twice.
    // `replay` re-enters with a command the intent reader worked out, which
    // the person did not type and must not appear in their thread.
    if (!replay) {
      const meta = { ...(voice ? { voice: true } : {}), ...(channel ? { channel } : {}) };
      await db.addChatMessage(email, 'in', message, Object.keys(meta).length ? meta : null);
    }
    const lower = message.toLowerCase();

    // What we last asked decides how a reply is read: "yes" to the resume
    // offer starts the questions; anything else after a question is its answer.
    const prompt = await db.lastChatPrompt(email, ['resume_offer', 'gap_question']);
    // A thumb on the last message is an answer to it: people reply to a text
    // by reacting to it far more often than by typing the word.
    const tap = options.reaction;
    if (tap) {
      const yes = ['like', 'love', 'emphasize', 'laugh'].includes(tap.kind) || /^(👍|❤️|🔥|✅|🙌|💯)/u.test(tap.emoji || '');
      const no = tap.kind === 'dislike' || /^(👎|🙅|❌)/u.test(tap.emoji || '');
      if (prompt?.meta?.kind === 'resume_offer' && !prompt.meta.done && (yes || no)) {
        if (!await db.claimChatPrompt(prompt.id)) return;
        if (no) return say(email, 'all good. text "rewrite" whenever you want the resume redone.');
        return askGap(email, { ...prompt.meta, open: prompt.meta.gaps, answered: 0 });
      }
      if (prompt?.meta?.kind === 'gap_question' && !prompt.meta.done && no) {
        if (!await db.claimChatPrompt(prompt.id)) return;
        const meta = prompt.meta;
        if (meta.open.length) return askGap(email, { ...meta, answered: meta.answered || 0 });
        return say(email, 'no problem, the kit is ready. reply yes anytime to tune the resume.');
      }
      // Anything else is applause, not an instruction.
      if (!tap.text || /^\p{Extended_Pictographic}/u.test(tap.text)) return;
    }
    const link = findJobLink(message);
    const command = /^(help|\?|matches|jobs|new|search|status|credits|rewrite|stop|skip \d|applied \d|remember\b|correction\b|corrections\b|forget \d|\d$)/.test(lower);
    if (prompt?.meta?.kind === 'resume_offer' && !prompt.meta.done && /^(y|yes|yeah|yep|sure|ok|okay|go|let'?s go)\b/.test(lower)) {
      if (!await db.claimChatPrompt(prompt.id)) return;
      return askGap(email, { ...prompt.meta, open: prompt.meta.gaps, answered: 0 });
    }
    if (prompt?.meta?.kind === 'resume_offer' && !prompt.meta.done && /^(n|no|nope|nah|not now|later)\b/.test(lower)) {
      if (!await db.claimChatPrompt(prompt.id)) return;
      return say(email, 'all good. text "rewrite" whenever you want the resume redone.');
    }
    if (prompt?.meta?.kind === 'gap_question' && !prompt.meta.done && !link && !command) {
      const meta = prompt.meta;
      let answered = meta.answered || 0;
      const stop = /^(done|that'?s it|finished|stop)\b/.test(lower);
      const skipped = /^(skip|next|pass|no)\b/.test(lower);
      // A bare "yes" is not an answer; keep the question open and nudge.
      if (/^(y|yes|yeah|yep|sure|ok|okay|k)[.! ]*$/.test(lower)) {
        return say(email, `tell me what you did there, your words. or "skip".`);
      }
      if (!await db.claimChatPrompt(prompt.id)) return;
      if (!stop && !skipped) {
        // Same cleanup as the extension's voice button: filler and grammar
        // tidied, names fixed, every fact kept.
        const answer = polish ? await polish(email, message, meta.question, meta.kit_id) : message;
        const saved = await api(email, 'POST', '/interview/context', { question: meta.question, answer });
        if (saved.status === 200) answered++;
      }
      if (!stop && meta.open.length) return askGap(email, { ...meta, answered });
      if (!answered) return say(email, 'no problem, the kit is ready. reply yes anytime to tune the resume.');
      return rewriteResume(email, meta, `got ${answered} answer${answered === 1 ? '' : 's'}.`);
    }
    if (link) return writeKit(email, link, { force: /^redo\b/.test(lower) });
    if (/^redo\b/.test(lower)) {
      const last = await db.lastChatPrompt(email, ['kit', 'resume_offer', 'gap_question']);
      if (!last?.meta?.url) return say(email, 'send the job link and i\'ll write it fresh.');
      return writeKit(email, last.meta.url, { force: true });
    }
    // Corrections. Said once, applied to everything afterwards: this is how
    // someone kills a claim the writing keeps making about them.
    if (/^corrections?$/.test(lower)) {
      const r = await api(email, 'GET', '/facts');
      const facts = r.data?.facts || [];
      if (!facts.length) return say(email, 'nothing on record. text "remember: i have never sold a company" and i apply it everywhere.');
      return say(email, 'on record:\n' + facts.map((f, i) => `${i + 1}. ${f.text}`).join('\n') + '\n\n"forget 1" drops one.');
    }
    // "corrections" alone is the list, handled above; "correction: ..." records one.
    const remember = message.match(/^(?:remember|correction)\b\s*[:,-]?\s+([\s\S]+)/i);
    if (remember) {
      const r = await api(email, 'POST', '/facts', { text: remember[1].trim() });
      if (r.status !== 200) return say(email, r.data?.error || 'couldn\'t save that one.');
      return say(email, 'got it. everything from here on is written against that.');
    }
    const forget = lower.match(/^forget\s+(\d+)$/);
    if (forget) {
      const r = await api(email, 'GET', '/facts');
      const fact = (r.data?.facts || [])[Number(forget[1]) - 1];
      if (!fact) return say(email, 'text "corrections" for the list, then pick a number.');
      await api(email, 'DELETE', '/facts/' + fact.id, null);
      return say(email, `dropped: ${fact.text}`);
    }
    // A hello is answered with a wave and the work, not with a menu.
    if (/^(hi|hey|hello|yo|sup|hiya|howdy|good morning|good evening)\b[\s!.?]*$/.test(lower)) {
      if (react) await react(email, '👋').catch(() => {});
      return welcome(email);
    }
    if (/^(help|\?)$/.test(lower)) return say(email, HELP);
    if (/^(matches|jobs|new)\b/.test(lower)) return matches(email);
    const pick = lower.match(/^(\d)$/);
    if (pick) {
      const job = (await lastList(email))[Number(pick[1]) - 1];
      return job ? writeKit(email, job.url) : say(email, 'text "matches" first, then pick a number.');
    }
    const update = lower.match(/^(skip|applied)\s+(\d)$/);
    if (update) {
      const job = (await lastList(email))[Number(update[2]) - 1];
      if (!job) return say(email, 'Text "matches" first, then pick a number.');
      const r = await api(email, 'POST', '/sourced/status', { url: job.url, status: update[1] === 'skip' ? 'skipped' : 'applied' });
      return say(email, r.status === 200 ? `${update[1] === 'skip' ? 'skipped' : 'applied'}, ${job.company}, ${job.role}.` : 'couldn\'t update that one.');
    }
    if (/^search\b/.test(lower)) {
      const r = await api(email, 'POST', '/source/run', {});
      if (r.status === 402) return say(email, `out of credits. top up: ${origin}/buy`);
      if (r.status !== 200) return say(email, r.data?.error || 'couldn\'t start a search.');
      return say(email, r.data.status === 'already_running' ? 'already searching. i\'ll text you when it\'s done.' : `searching ${r.data.sources.length} sources. i'll text you when it's done.`);
    }
    if (/^status\b/.test(lower)) {
      const r = await api(email, 'GET', '/source/status');
      const c = r.data?.counts || {};
      return say(email, `${r.data?.active ? 'searching now.' : 'not searching.'}\n${c.new || 0} new · ${c.applying || 0} applying · ${c.applied || 0} applied`);
    }
    if (/^credits\b/.test(lower)) {
      const r = await api(email, 'GET', '/auth/me');
      return say(email, `${r.data?.credits ?? 0} credits. a kit costs 10. top up: ${origin}/buy`);
    }
    if (/^rewrite\b/.test(lower)) {
      const last = await db.lastChatPrompt(email, ['kit', 'resume_offer', 'gap_question']);
      if (prompt) await db.updateChatMeta(prompt.id, { ...prompt.meta, done: true });
      if (!last?.meta?.kit_id) return say(email, 'Send me a job link first, then text "rewrite".');
      return rewriteResume(email, last.meta, '');
    }
    if (/^stop\b/.test(lower)) return say(email, 'okay, i won\'t text you about searches. send a job link anytime.');

    // Nothing matched a command, which does not mean the person said nothing
    // useful. Read it before falling back to a menu.
    const listed = await lastList(email);
    const read = await readIntent(typeSafeKey, message, { awaitingAnswer: false, listed });
    if (read) {
      switch (read.intent) {
        case 'matches': return matches(email);
        case 'search': return handleOne(email, 'search', { replay: true });
        case 'status': return handleOne(email, 'status', { replay: true });
        case 'credits': return handleOne(email, 'credits', { replay: true });
        case 'corrections': return handleOne(email, 'corrections', { replay: true });
        case 'about': return say(email, `${WHAT_I_AM}\n\nsend me a job link, or say "matches" and i'll show you what fits.`);
        case 'help': return say(email, HELP);
        case 'stop': return say(email, 'okay, i won\'t text you about searches. send a job link anytime.');
        case 'rewrite': return handleOne(email, 'rewrite', { replay: true });
        case 'pick': {
          const index = pickFromList(message, listed);
          if (index >= 0 && listed[index]) return writeKit(email, listed[index].url);
          return say(email, 'which one? reply 1, 2 or 3.');
        }
        case 'remember': {
          const fact = factFrom(message);
          if (fact.length < 4) break;
          const r = await api(email, 'POST', '/facts', { text: fact });
          if (r.status !== 200) break;
          return say(email, `got it: ${fact}\n\neverything from here on is written against that.`);
        }
        case 'smalltalk': return say(email, 'anytime. send a job link whenever you have one.');
        default: break;
      }
    }
    // Everything that is not a carrier obligation goes to the agent: it reads
    // what they said, does the work with the same operations the website uses,
    // and writes the reply itself. The command router below is the fallback
    // for when the model cannot be reached.
    if (callModel && VOICE) {
      const [me, prompt2, last] = await Promise.all([
        api(email, 'GET', '/auth/me'),
        db.lastChatPrompt(email, ['gap_question']).catch(() => null),
        db.lastChatPrompt(email, ['kit', 'resume_offer']).catch(() => null),
      ]);
      const profile = await db.getProfileByUserEmail(email).catch(() => null);
      // What the tools actually produced this turn. A link is the whole point
      // of the message, and whether the model chooses to repeat one is not
      // something to leave to chance.
      const produced = { links: [], job: '' };
      const reply = await agent.run({
        voice: VOICE,
        message,
        context: {
          credits: me.data?.credits,
          listed: await lastList(email),
          openQuestion: prompt2?.meta?.done ? null : prompt2?.meta?.question || null,
          lastKit: last?.meta?.url ? `${last.meta.url}` : null,
          targeting: [profile?.target_functions, profile?.target_seniority].filter(Boolean).join(' at '),
        },
        callModel,
        invoke: toolbox(email, produced),
        log: line => console.log(`[agent] ${email}: ${line}`),
      }).catch(e => { console.error('[agent]', e.message); return null; });
      if (reply) {
        const text = agent.withLinks(reply.replace(/\u2014/g, ','), produced.links);
        const meta = await db.lastChatMeta(email, 'matches').catch(() => null);
        return say(email, text, meta?.meta?.hidden ? { ...meta.meta, hidden: false } : null);
      }
    }

    // A question the command list does not cover. Rather than a menu, answer
    // it from the voice file: what applyapply is, does, refuses and costs.
    // Nothing here acts or spends, so a model writes the words and nothing
    // else.
    if (askModel && VOICE && /\?$|^(what|who|how|can|do|does|is|are|will|why|should)\b/i.test(message)) {
      const reply = await askModel(`${VOICE}\n\nSomeone texted applyapply: "${message.slice(0, 500)}"\n\nAnswer them in applyapply's voice, using only what is written above. Reply with the message itself and nothing else.`)
        .catch(e => { console.error('[concierge]', e.message); return null; });
      const text = String(reply || '').trim().replace(/^["']|["']$/g, '').replace(/\u2014/g, ',');
      if (text && text.length < 700) return say(email, text);
    }
    return say(email, HELP);
  }

  // ── The agent ────────────────────────────────────────────────────────────
  // Every tool is the operation the website performs, called with this
  // person's own session, so a kit written from a text is charged, owned and
  // refused exactly as one written from a browser.
  function toolbox(email, produced) {
    const listed = () => lastList(email);
    return async (name, input) => {
      switch (name) {
        case 'list_matches': {
          const jobs = await bestThree(email);
          if (jobs.length) await db.addChatMessage(email, 'out', '', { kind: 'matches', jobs: jobs.map(j => ({ url: j.url, company: j.company, role: j.role })), hidden: true });
          return { roles: jobs.map((j, i) => ({ n: i + 1, company: j.company, role: j.role, location: j.location || '' })) };
        }
        case 'write_kit': {
          let url = String(input.url || '').trim();
          if (!url && Number(input.choice)) url = (await listed())[Number(input.choice) - 1]?.url || '';
          if (!url) return { error: 'No job to write. Ask them which one, or ask for the link.' };
          const r = await api(email, 'POST', '/generate', { url });
          if (r.status === 402) return { error: 'out of credits', top_up: `${origin}/buy` };
          if (r.status !== 200 || !r.data?.tailored) return { error: r.data?.error || 'could not read that posting' };
          const kit = r.data;
          const token = kitLink ? await kitLink(email, kit.id).catch(() => null) : null;
          const link = token ? `${origin}/k/${token}` : `${origin}/${kit.url}`;
          const gaps = kit.tailored_resume?.coverage?.gaps || [];
          const score = kit.tailored_resume?.jev_match?.score;
          await db.addChatMessage(email, 'out', '', { kind: gaps.length ? 'resume_offer' : 'kit', url: kit.url, kit_id: kit.id, link, gaps, company: kit.company, role: kit.role, hidden: true });
          produced.links.push(link);
          produced.job = [kit.company, kit.role].filter(Boolean).join(', ');
          return { company: kit.company, role: kit.role, link, credits_spent: 10,
            match_percent: score ? Math.round((Number(score) / 5) * 100) : null,
            answered_questions: (kit.tailored.qa || []).filter(x => x.a).length,
            things_the_resume_cannot_show: gaps };
        }
        case 'rewrite_resume': {
          const last = await db.lastChatPrompt(email, ['kit', 'resume_offer', 'gap_question']);
          if (!last?.meta?.kit_id) return { error: 'no application written yet' };
          const r = await api(email, 'POST', '/resume-tailor', { appId: last.meta.kit_id });
          if (r.status === 402) return { error: 'out of credits', top_up: `${origin}/buy` };
          if (r.status !== 200) return { error: 'could not rewrite it; their answers are saved' };
          const score = r.data.jev_match?.score;
          const rewriteLink = last.meta.link || `${origin}/${last.meta.url}`;
          produced.links.push(rewriteLink);
          produced.job = [last.meta.company, last.meta.role].filter(Boolean).join(', ');
          return { link: rewriteLink, credits_spent: resumeCost,
            match_percent: score ? Math.round((Number(score) / 5) * 100) : null,
            used_answers: Number(r.data.evidence_used) || 0, still_missing: r.data.coverage?.gaps || [] };
        }
        case 'start_search': {
          const r = await api(email, 'POST', '/source/run', {});
          if (r.status === 402) return { error: 'out of credits', top_up: `${origin}/buy` };
          if (r.status !== 200) return { error: r.data?.error || 'could not start a search' };
          return r.data.status === 'already_running' ? { already_running: true } : { searching_sources: r.data.sources.length };
        }
        case 'account': {
          const [me, status] = await Promise.all([api(email, 'GET', '/auth/me'), api(email, 'GET', '/source/status')]);
          const c = status.data?.counts || {};
          return { credits: me.data?.credits ?? 0, kit_costs: 10, top_up: `${origin}/buy`,
            searching: Boolean(status.data?.active), pipeline: { new: c.new || 0, applying: c.applying || 0, applied: c.applied || 0 } };
        }
        case 'remember_fact': {
          const text = factFrom(input.text || '');
          if (text.length < 4) return { error: 'nothing to record' };
          const r = await api(email, 'POST', '/facts', { text });
          return r.status === 200 ? { recorded: text } : { error: 'could not record that' };
        }
        case 'list_corrections': {
          const r = await api(email, 'GET', '/facts');
          return { corrections: (r.data?.facts || []).map((f, i) => ({ n: i + 1, text: f.text })) };
        }
        case 'forget_correction': {
          const r = await api(email, 'GET', '/facts');
          const fact = (r.data?.facts || [])[Number(input.choice) - 1];
          if (!fact) return { error: 'no correction at that position' };
          await api(email, 'DELETE', '/facts/' + fact.id, null);
          return { dropped: fact.text };
        }
        case 'set_job_status': {
          const job = (await listed())[Number(input.choice) - 1];
          if (!job) return { error: 'no role at that position' };
          const r = await api(email, 'POST', '/sourced/status', { url: job.url, status: input.status === 'applied' ? 'applied' : 'skipped' });
          return r.status === 200 ? { company: job.company, role: job.role, status: input.status } : { error: 'could not update it' };
        }
        case 'save_answer': {
          const prompt = await db.lastChatPrompt(email, ['gap_question']);
          if (!prompt?.meta?.question) return { error: 'no question is open' };
          if (!await db.claimChatPrompt(prompt.id)) return { error: 'already answered' };
          const answer = polish ? await polish(email, input.answer, prompt.meta.question, prompt.meta.kit_id) : input.answer;
          await api(email, 'POST', '/interview/context', { question: prompt.meta.question, answer });
          const open = prompt.meta.open || [];
          if (open.length) {
            const [next, ...rest] = open;
            await say(email, `${jobLabel(prompt.meta) ? jobLabel(prompt.meta) + '. ' : ''}${prompt.meta.gaps.length - rest.length} of ${prompt.meta.gaps.length}: ${next}`,
              { ...prompt.meta, kind: 'gap_question', question: next, open: rest, answered: (prompt.meta.answered || 0) + 1 });
            return { saved: true, asked_them_next: next };
          }
          return { saved: true, no_questions_left: true, suggest: 'offer to redo the resume with their answers' };
        }
        default: return { error: 'no such tool' };
      }
    };
  }

  // Voice notes are free up to a couple of minutes and a normal day's use.
  // Past that they cost a credit per started minute, which roughly doubles
  // what transcription costs, so heavy use pays for itself instead of being
  // cut off. Returns a message to send instead of handling, or null.
  const VOICE_FREE_SECONDS = 120, VOICE_FREE_PER_DAY = 30;
  async function voiceCharge(email, seconds) {
    const length = Math.max(0, Math.round(Number(seconds) || 0));
    const today = await db.countVoiceNotesToday(email).catch(() => 0);
    const overLength = Math.max(0, Math.ceil((length - VOICE_FREE_SECONDS) / 60));
    const overCount = today >= VOICE_FREE_PER_DAY ? 1 : 0;
    const credits = overLength + overCount;
    if (!credits) return null;
    if (await db.chargeCredits(email, credits, 'voice_note')) return null;
    return `That voice note needs ${credits} credit${credits === 1 ? '' : 's'} (over ${VOICE_FREE_SECONDS / 60} minutes or ${VOICE_FREE_PER_DAY} notes today) and you're out. Top up here: ${origin}/buy`;
  }

  return {
    handle,
    welcome,
    voiceCharge,
    isTyping: email => typing.has(email),
    notifySearchDone: async (email, added) => {
      if (!await db.hasChatHistory(email)) return;
      if (!added) return say(email, 'search done. nothing new this time.');
      const jobs = await bestThree(email);
      if (!jobs.length) return say(email, `search done. ${added} new role${added === 1 ? '' : 's'}.`);
      await say(email, `${added} new role${added === 1 ? '' : 's'}. best of them:\n${jobs.map((j, i) => `${i + 1}) ${j.company}, ${j.role}`).join('\n')}\n\nreply 1, 2 or 3.`,
        { kind: 'matches', jobs: jobs.map(j => ({ url: j.url, company: j.company, role: j.role })) });
    },
    findJobLink,
  };
};
