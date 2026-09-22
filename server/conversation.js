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

module.exports = function conversation({ db, port, signToken, origin, kitLink }) {
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
      const blanks = (t.qa || []).filter(x => !x.a).map(x => x.q);
      // A private link that opens this kit on the phone without signing in.
      const token = kitLink ? await kitLink(email, kit.id).catch(() => null) : null;
      const link = token ? `${origin}/k/${token}` : `${origin}/${kit.url}`;
      await say(email, `${kit.company || 'This role'}, ${kit.role || ''}${kit.fit_score ? `. Match ${kit.fit_score}/10` : ''}. Your kit, with your resume and cover letter as PDFs: ${link}\nEach answer below is its own message so you can copy it.`, { kind: 'kit', url: kit.url, kit_id: kit.id, link });
      if (t.why_role) await say(email, ['Why this role:', t.why_role]);
      if (t.cover_note) await say(email, ['Cover note:', t.cover_note]);
      for (const item of (t.qa || []).filter(x => x.a)) await say(email, [item.q, item.a]);
      if (blanks.length) await say(email, `Only you can answer these, so I left them blank:\n${blanks.map(q => '• ' + q).join('\n')}`);
      await offerResumeQuestions(email, kit, link);
    });
  }

  // After a kit: say how the tailored resume scores and offer to ask about
  // what it can't show yet. "yes" starts the questions, one at a time.
  async function offerResumeQuestions(email, kit, link) {
    const r = kit.tailored_resume, gaps = r?.coverage?.gaps || [];
    const score = r?.jev_match?.score ? ` It's a ${Number(r.jev_match.score).toFixed(1)}/5 match.` : '';
    if (!r) return say(email, 'Open the job on your laptop and the extension fills the form from this kit.');
    if (!gaps.length) return say(email, `Your resume is tailored for this role.${score} It's in the kit as a PDF.`);
    await say(email, `Your resume is tailored for this role.${score} It doesn't show ${gaps.length === 1 ? 'one thing' : gaps.length + ' things'} this role asks for. Want to answer ${gaps.length === 1 ? 'it' : 'them'} for a stronger custom resume? Reply yes.`,
      { kind: 'resume_offer', kit_id: kit.id, url: kit.url, link, gaps });
  }

  async function askGap(email, session) {
    const [question, ...rest] = session.gaps || [];
    session.total = session.total || 1;
    if (!question) {
      return say(email, `That's all of them. Want me to rewrite your resume with your answers? Reply rewrite (${8} credits).`, { kind: 'rewrite_offer', kit_id: session.kit_id, url: session.url, link: session.link });
    }
    await say(email, `${session.total - rest.length} of ${session.total}: ${question}\nReply with what you've done there, or "skip". A voice note works too.`,
      { kind: 'gap_question', question, gaps: rest, total: session.total, kit_id: session.kit_id, url: session.url, link: session.link });
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
    const prompt = await db.lastChatPrompt(email, ['resume_offer', 'gap_question', 'rewrite_offer']);
    const link = findJobLink(message);
    const command = /^(help|\?|matches|jobs|new|search|status|credits|rewrite|stop|skip \d|applied \d|\d$)/.test(lower);
    if (prompt?.meta?.kind === 'resume_offer' && !prompt.meta.done && /^(y|yes|yeah|yep|sure|ok|okay|go|let'?s go)\b/.test(lower)) {
      await db.updateChatMeta(prompt.id, { ...prompt.meta, done: true });
      return askGap(email, { gaps: prompt.meta.gaps, total: prompt.meta.gaps.length, kit_id: prompt.meta.kit_id, url: prompt.meta.url, link: prompt.meta.link });
    }
    if (prompt?.meta?.kind === 'resume_offer' && !prompt.meta.done && /^(n|no|nope|nah|not now|later)\b/.test(lower)) {
      await db.updateChatMeta(prompt.id, { ...prompt.meta, done: true });
      return say(email, 'No problem. Your kit is ready as it is. Text "rewrite" anytime to redo the resume.');
    }
    if (prompt?.meta?.kind === 'gap_question' && !prompt.meta.answered && !link && !command) {
      await db.updateChatMeta(prompt.id, { ...prompt.meta, answered: true });
      if (!/^(skip|next|pass|no)$/.test(lower)) {
        const saved = await api(email, 'POST', '/interview/context', { question: prompt.meta.question, answer: message });
        await say(email, saved.status === 200 ? 'Saved to your profile.' : 'I couldn\'t save that one, but let\'s keep going.');
      }
      return askGap(email, { gaps: prompt.meta.gaps, total: prompt.meta.total, kit_id: prompt.meta.kit_id, url: prompt.meta.url, link: prompt.meta.link });
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
      const last = await db.lastChatMeta(email, 'kit');
      if (prompt?.meta?.kind === 'rewrite_offer' || prompt?.meta?.kind === 'gap_question') await db.updateChatMeta(prompt.id, { ...prompt.meta, answered: true, done: true });
      if (!last?.meta?.kit_id) return say(email, 'Send me a job link first, then text "rewrite".');
      return withTyping(email, async () => {
        const r = await api(email, 'POST', '/resume-tailor', { appId: last.meta.kit_id });
        if (r.status === 402) return say(email, `You're out of credits. Top up here: ${origin}/buy`);
        if (r.status !== 200) return say(email, r.data?.error || 'I couldn\'t rewrite the resume.');
        const score = r.data.jev_match?.score, was = r.data.previous_match_score;
        await say(email, `Resume rewritten for this role${score ? `. Match ${score.toFixed(1)}/5${was ? ` (was ${Number(was).toFixed(1)})` : ''}` : ''}. It's in your kit: ${last.meta.link || `${origin}/${last.meta.url}`}`);
        const gaps = r.data.coverage?.gaps || [];
        if (gaps.length) await say(email, `It still doesn't show ${gaps.length === 1 ? 'one thing' : gaps.length + ' things'} this role asks for. Want to answer ${gaps.length === 1 ? 'it' : 'them'}? Reply yes.`,
          { kind: 'resume_offer', kit_id: last.meta.kit_id, url: last.meta.url, link: last.meta.link, gaps });
      });
    }
    if (/^stop\b/.test(lower)) return say(email, 'Okay. I won\'t text you about searches. Send a job link anytime.');
    return say(email, HELP);
  }

  return {
    handle,
    isTyping: email => typing.has(email),
    notifySearchDone: async (email, added) => {
      if (!await db.hasChatHistory(email)) return;
      await say(email, added ? `Your search found ${added} new role${added === 1 ? '' : 's'}. Text "matches" to see the best ones.` : 'Your search finished. Nothing new this time.');
    },
    findJobLink,
  };
};
