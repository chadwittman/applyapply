// The text-message experience: a person texts applyapply and it answers.
// Channel-agnostic: `deliver` decides where replies go. Today that is the
// /imessage test page; with Sendblue it will also send a real iMessage.
//
// Everything a message can do goes through the existing HTTP routes with the
// person's own session, so credits, idempotency and ownership behave exactly
// as they do on the site and in the extension.
const http = require('http');

const HELP = [
  'Send me a job link and I\'ll write your application kit.',
  'Or text:',
  '• matches: your best new roles',
  '• 1, 2 or 3: write the kit for that match',
  '• search: look for new roles now',
  '• skip 2 / applied 1: update a match',
  '• rewrite: rewrite the resume for your last kit with your answers',
  '• status · credits · help',
].join('\n');

// A job link anywhere in the message, with or without https://.
function findJobLink(text) {
  const full = String(text).match(/https?:\/\/[^\s<>"']+/i);
  if (full) return full[0].replace(/[).,;!?]+$/, '');
  const bare = String(text).match(/\b((?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"']+)/i);
  return bare ? 'https://' + bare[1].replace(/[).,;!?]+$/, '') : null;
}

module.exports = function conversation({ db, port, signToken, origin, kitLink, resumeCost = 8 }) {
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

  async function say(email, bodies, meta = null) {
    for (const body of [].concat(bodies).filter(Boolean)) await db.addChatMessage(email, 'out', body, meta);
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

  async function writeKit(email, url) {
    return withTyping(email, async () => {
      const r = await api(email, 'POST', '/generate', { url });
      if (r.status === 402) return say(email, `You're out of credits. Top up here: ${origin}/buy`);
      if (r.status !== 200 || !r.data?.tailored) return say(email, 'I couldn\'t write a kit for that link. Check it opens a job posting, then send it again.');
      const kit = r.data, t = kit.tailored;
      // One text: the link to everything, and the offer to tune the resume.
      // The kit page holds the answers, the PDFs and the copy buttons.
      const token = kitLink ? await kitLink(email, kit.id).catch(() => null) : null;
      const link = token ? `${origin}/k/${token}` : `${origin}/${kit.url}`;
      const gaps = kit.tailored_resume?.coverage?.gaps || [];
      const score = kit.tailored_resume?.jev_match?.score;
      const answers = (t.qa || []).filter(x => x.a).length;
      const parts = [
        `${kit.company || 'This role'}, ${kit.role || ''}${kit.fit_score ? ` (${kit.fit_score}/10 match)` : ''}`,
        `Your kit: ${link}`,
        `Inside: your tailored resume${score ? ` (${Number(score).toFixed(1)}/5)` : ''} and cover letter as PDFs, ${answers ? `${answers} answered question${answers === 1 ? '' : 's'}` : 'your details'}, everything one tap to copy.`,
        gaps.length ? `Want the resume dialed in for this role? Reply yes and I'll send ${gaps.length === 1 ? 'a question' : `${gaps.length} quick questions`}, then rewrite it with your answers (${resumeCost} credits).` : null,
      ].filter(Boolean);
      await say(email, parts.join('\n\n'), { kind: gaps.length ? 'resume_offer' : 'kit', url: kit.url, kit_id: kit.id, link, gaps });
    });
  }

  // All the questions in one message. Answer them in one reply (numbered, or
  // one long voice note), or a few at a time.
  async function askGaps(email, meta) {
    const open = meta.gaps.filter(q => !meta.answers?.[q]);
    await say(email, `${open.length === 1 ? 'One question' : `${open.length} quick questions`}, answer in one reply (number them) or a voice note:\n${open.map((q, i) => `${i + 1}) ${q}`).join('\n')}\n\nReply "done" when you want the rewrite.`,
      { ...meta, kind: 'gap_batch', open });
  }

  // "1) ... 2) ..." splits by number; anything else answers the first open one.
  function splitAnswers(message, open) {
    const parts = String(message).split(/(?:^|\n|\s)(\d)[).:-]\s+/).filter(x => x !== '');
    const answers = {};
    if (parts.length > 1 && /^\d$/.test(parts[0])) {
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const q = open[Number(parts[i]) - 1];
        if (q && parts[i + 1].trim()) answers[q] = parts[i + 1].trim();
      }
    }
    if (!Object.keys(answers).length && open[0] && message.trim()) answers[open[0]] = message.trim();
    return answers;
  }

  async function rewriteResume(email, meta, note) {
    return withTyping(email, async () => {
      const r = await api(email, 'POST', '/resume-tailor', { appId: meta.kit_id });
      if (r.status === 402) return say(email, `You're out of credits, so I couldn't rewrite it. Top up here: ${origin}/buy`);
      if (r.status !== 200) return say(email, 'I couldn\'t rewrite the resume. Your answers are saved; try "rewrite" again in a moment.');
      const score = r.data.jev_match?.score, was = Number(r.data.previous_match_score);
      const gaps = r.data.coverage?.gaps || [];
      await say(email, [note, `Your tailored resume is ready${score ? `. Match ${Number(score).toFixed(1)}/5${Number.isFinite(was) ? ` (was ${was.toFixed(1)})` : ''}` : ''}: ${meta.link || `${origin}/${meta.url}`}`,
        gaps.length ? `Still not shown: ${gaps.length === 1 ? 'one thing' : gaps.length + ' things'}. Reply yes to answer ${gaps.length === 1 ? 'it' : 'them'} too.` : null].filter(Boolean).join(' '),
      { kind: gaps.length ? 'resume_offer' : 'kit', kit_id: meta.kit_id, url: meta.url, link: meta.link, gaps });
    });
  }

  async function matches(email) {
    const jobs = (await db.getJobs('new', 50, email))
      .sort((a, b) => (a.tier ?? 9) - (b.tier ?? 9) || (b.fit_score ?? 0) - (a.fit_score ?? 0)).slice(0, 3);
    if (!jobs.length) return say(email, 'No new matches right now. Text "search" to look for new roles.');
    await say(email, `Your best new roles:\n${jobs.map((j, i) => `${i + 1}) ${j.company}, ${j.role}${j.location ? ` (${j.location})` : ''}`).join('\n')}\nReply 1, 2 or 3 to write the kit, or "skip 2".`,
      { kind: 'matches', jobs: jobs.map(j => ({ url: j.url, company: j.company, role: j.role })) });
  }

  // voice: the message was a voice note, already transcribed.
  async function handle(email, text, { voice = false } = {}) {
    const message = String(text || '').trim();
    await db.addChatMessage(email, 'in', message, voice ? { voice: true } : null);
    const lower = message.toLowerCase();

    // What we last asked decides how a reply is read: "yes" to the resume
    // offer starts the questions; anything else after a question is its answer.
    const prompt = await db.lastChatPrompt(email, ['resume_offer', 'gap_batch']);
    const link = findJobLink(message);
    const command = /^(help|\?|matches|jobs|new|search|status|credits|rewrite|stop|skip \d|applied \d|\d$)/.test(lower);
    if (prompt?.meta?.kind === 'resume_offer' && !prompt.meta.done && /^(y|yes|yeah|yep|sure|ok|okay|go|let'?s go)\b/.test(lower)) {
      await db.updateChatMeta(prompt.id, { ...prompt.meta, done: true });
      return askGaps(email, { ...prompt.meta, answers: {} });
    }
    if (prompt?.meta?.kind === 'resume_offer' && !prompt.meta.done && /^(n|no|nope|nah|not now|later)\b/.test(lower)) {
      await db.updateChatMeta(prompt.id, { ...prompt.meta, done: true });
      return say(email, 'No problem. Your kit is ready as it is. Text "rewrite" anytime to redo the resume.');
    }
    if (prompt?.meta?.kind === 'gap_batch' && !prompt.meta.done && !link && !command) {
      const meta = prompt.meta, answers = { ...(meta.answers || {}) };
      const done = /^(done|that'?s it|finished|go|rewrite)\b/.test(lower);
      if (!done) {
        for (const [question, answer] of Object.entries(splitAnswers(message, meta.open || meta.gaps))) {
          const saved = await api(email, 'POST', '/interview/context', { question, answer });
          if (saved.status === 200) answers[question] = answer;
        }
      }
      const open = meta.gaps.filter(q => !answers[q]);
      await db.updateChatMeta(prompt.id, { ...meta, answers, open, done: done || !open.length });
      const saved = Object.keys(answers).length;
      if (!done && open.length) return askGaps(email, { ...meta, answers });
      if (!saved) return say(email, 'No problem, your kit is ready as it is. Reply yes anytime to tune the resume.');
      return rewriteResume(email, meta, `Got ${saved} answer${saved === 1 ? '' : 's'}.`);
    }
    if (link) return writeKit(email, link);
    if (/^(help|\?)$/.test(lower)) return say(email, HELP);
    if (/^(matches|jobs|new)\b/.test(lower)) return matches(email);
    const pick = lower.match(/^(\d)$/);
    if (pick) {
      const job = (await lastList(email))[Number(pick[1]) - 1];
      return job ? writeKit(email, job.url) : say(email, 'Text "matches" first, then pick a number.');
    }
    const update = lower.match(/^(skip|applied)\s+(\d)$/);
    if (update) {
      const job = (await lastList(email))[Number(update[2]) - 1];
      if (!job) return say(email, 'Text "matches" first, then pick a number.');
      const r = await api(email, 'POST', '/sourced/status', { url: job.url, status: update[1] === 'skip' ? 'skipped' : 'applied' });
      return say(email, r.status === 200 ? `${update[1] === 'skip' ? 'Skipped' : 'Marked applied'}: ${job.company}, ${job.role}.` : 'I couldn\'t update that one.');
    }
    if (/^search\b/.test(lower)) {
      const r = await api(email, 'POST', '/source/run', {});
      if (r.status === 402) return say(email, `You need more credits to search. Top up here: ${origin}/buy`);
      if (r.status !== 200) return say(email, r.data?.error || 'I couldn\'t start a search.');
      return say(email, r.data.status === 'already_running' ? 'A search is already running. I\'ll text you when it\'s done.' : `Searching ${r.data.sources.length} sources now. I'll text you when it's done.`);
    }
    if (/^status\b/.test(lower)) {
      const r = await api(email, 'GET', '/source/status');
      const c = r.data?.counts || {};
      return say(email, `${r.data?.active ? 'A search is running now.' : 'No search running.'}\nPipeline: ${c.new || 0} new, ${c.applying || 0} applying, ${c.applied || 0} applied.`);
    }
    if (/^credits\b/.test(lower)) {
      const r = await api(email, 'GET', '/auth/me');
      return say(email, `You have ${r.data?.credits ?? 0} credits. A kit costs 10. Top up: ${origin}/buy`);
    }
    if (/^rewrite\b/.test(lower)) {
      const last = await db.lastChatPrompt(email, ['kit', 'resume_offer', 'gap_batch']);
      if (prompt) await db.updateChatMeta(prompt.id, { ...prompt.meta, done: true });
      if (!last?.meta?.kit_id) return say(email, 'Send me a job link first, then text "rewrite".');
      return rewriteResume(email, last.meta, '');
    }
    if (/^stop\b/.test(lower)) return say(email, 'Okay. I won\'t text you about searches. Send a job link anytime.');
    return say(email, HELP);
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
    voiceCharge,
    isTyping: email => typing.has(email),
    notifySearchDone: async (email, added) => {
      if (!await db.hasChatHistory(email)) return;
      await say(email, added ? `Your search found ${added} new role${added === 1 ? '' : 's'}. Text "matches" to see the best ones.` : 'Your search finished. Nothing new this time.');
    },
    findJobLink,
  };
};
