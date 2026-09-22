/* global window, document, location */
// The /demo page runs the real extension sidebar (content.js) on a sample
// application. This file stands in for the extension's background worker:
// every request the sidebar makes is answered here with sample data, so
// nothing reaches the server, nothing is saved, and no credits are used.
// Each answer waits half as long as the real endpoint takes.
(() => {
  // Measured on production, 2026-09-21; the demo runs at half.
  const REAL_MS = { generate: 11600, cover: 9800, rewrite: 7200, analyze: 3800, fast: 160, save: 220, voice: 2600 };
  const wait = key => new Promise(resolve => setTimeout(resolve, Math.round((REAL_MS[key] || 160) * 0.5)));

  const profile = {
    first_name: 'Jordan', last_name: 'Rivera', email: 'jordan@example.com', phone: '(555) 014-2290',
    linkedin: 'linkedin.com/in/jordan-rivera-pm', github: '', twitter: '', website: 'jordanrivera.co',
    location: 'Denver, CO', current_employer: 'Parcelworks', school: 'University of Michigan',
    work_authorization: 'yes', sponsorship: 'no', salary: '210000', target_roles: 'Head of Product, Director of Product', location_pref: 'remote',
  };
  const costs = { generate: 10, cover_letter: 8, resume: 8, analyze: 3, interview: 3, voice: 2 };

  const bullets = {
    parcelworks: [
      'Launched Route Assist, a model-assisted planner now used by 4,000 dispatchers weekly.',
      'Raised suggestion acceptance from 52% to 81% by showing the source behind every recommendation.',
      'Led a 14-person product and design team across planning, dispatch and billing.',
      'Cut the 2025 roadmap from 19 bets to 7 by writing the success metric before each spec.',
    ],
    tallyhouse: [
      'Owned self-serve onboarding; cut time to first report from 3 days to 40 minutes.',
      'Shipped usage-based pricing that lifted net revenue retention to 118%.',
    ],
  };
  const instantResume = {
    name: 'Jordan Rivera', company: 'applyapply', role: 'Head of Product', kind: 'instant', version: 1,
    generated_at: new Date().toISOString(), evidence_used: 0,
    summary: 'Product leader who takes AI features from research to paid, everyday use.',
    experience: [
      { company: 'Parcelworks', title: 'Director of Product', dates: '2022 – Present', bullets: bullets.parcelworks },
      { company: 'Tallyhouse', title: 'Senior Product Manager', dates: '2019 – 2022', bullets: bullets.tallyhouse },
    ],
    skills: ['AI product strategy', 'Discovery research', 'Pricing', 'Onboarding and activation', 'SQL'],
    jev_match: { score: 3.4, confidence: 0.82 },
    coverage: { confidence: 'moderate', evidenced: [], gaps: [],
      improve: 'This is your resume reordered for this job. Rewrite resume has AI tailor the wording and list what the role asks for that your resume does not show.' },
  };
  const rewrittenResume = {
    ...instantResume, kind: 'rewrite', version: 2, generated_at: new Date().toISOString(), previous_match_score: 3.4,
    summary: 'Product leader who has shipped model-assisted tools people trust enough to use daily, and grown them into a third of company revenue.',
    experience: [
      { company: 'Parcelworks', title: 'Director of Product', dates: '2022 – Present', bullets: [
        'Took Route Assist from 30 dispatcher interviews to a model-assisted planner used by 4,000 people every week.',
        'Made recommendations trustworthy by showing their source, lifting acceptance from 52% to 81%.',
        'Grew Route Assist to 38% of company revenue within two years.',
        'Led 14 people across product and design, and cut the roadmap from 19 bets to 7.'] },
      { company: 'Tallyhouse', title: 'Senior Product Manager', dates: '2019 – 2022', bullets: [
        'Rebuilt self-serve onboarding so new teams saw their first report in 40 minutes instead of 3 days.',
        'Moved pricing to usage-based, lifting net revenue retention to 118%.'] },
    ],
    jev_match: { score: 3.9, confidence: 0.86 },
    coverage: { confidence: 'strong', evidenced: ['Zero-to-one AI product', 'Adoption metrics', 'Team leadership'],
      gaps: ['Built for job seekers or another consumer audience', 'Shipped a browser extension or developer API'],
      improve: 'Tell us about any consumer-facing product you owned; it is the biggest gap for this role.' },
  };
  const kit = {
    id: 'demo-kit', url: location.href, company: 'applyapply', role: 'Head of Product', ats: 'greenhouse', fit_score: 9, tier: 1,
    warm_path: 'Cold apply', profile, review_required: true,
    tailored: {
      headline: 'Product leader who takes AI tools from research to daily use',
      why_role: "applyapply is working on the part of job hunting I care about most: the moment a person has to explain themselves to a stranger, over and over. At Parcelworks I spent two years making a model's suggestions trustworthy enough that dispatchers actually used them, and the fix was always showing the work. You're building the same thing for applications, where the candidate has to trust every sentence before they send it.\n\nI'd like to own the question of what gets written by a model and what gets selected from what the person already said. That's the difference between fast and generic.",
      cover_note: "Hi applyapply team,\n\nI lead product at Parcelworks, where I took Route Assist from 30 dispatcher interviews to a planner 4,000 people use every week. It grew to 38% of revenue because we made every suggestion show its source, which moved acceptance from 52% to 81%.\n\nYou're asking candidates to trust generated answers with their careers. I know how to earn that kind of trust, and I'd love to talk about where the product goes next.\n\nJordan",
      qa: [
        { q: 'Describe a product you took from zero to one.', a: 'Route Assist at Parcelworks. I ran 30 dispatcher interviews, shipped a rules-based beta in six weeks, and replaced the rules with a model once we had 200k labeled routes. It reached 4,000 weekly users within a year and 38% of revenue within two.' },
        { q: 'How do you decide what not to build?', a: 'I write the success metric before the spec. If we cannot name the number that moves and who will notice, it goes to the parking lot. That cut our 2025 roadmap from 19 bets to 7, and we hit five of them.' },
        { q: 'When is the earliest you could start?', a: '' },
      ],
    },
    tailored_resume: instantResume,
  };
  const coverLetter = "Dear applyapply team,\n\nI'm applying for Head of Product. For the last four years I've led product at Parcelworks, where the hardest problem was never the model. It was getting people to trust what the model suggested enough to act on it.\n\nRoute Assist started as 30 interviews with dispatchers and a rules-based beta we shipped in six weeks. Once we had 200,000 labeled routes we replaced the rules with a model, and the product reached 4,000 weekly users within a year. The change that mattered most was small: every recommendation showed where it came from. Acceptance went from 52% to 81%, and Route Assist grew to 38% of company revenue.\n\napplyapply asks candidates to put their name on generated answers. That only works if the product is clear about what it wrote and what it pulled from the person's own words, and if it never guesses at the things only the candidate knows. I'd like to help make that the standard.\n\nThank you for reading. I'd be glad to talk.\n\nJordan Rivera";

  // In-memory stand-ins for what the server would store.
  let generated = false;
  let resume = instantResume;
  const evidence = new Map();
  const withAnswers = r => {
    const cov = r.coverage || {};
    const all = [...(cov.answered || []).map(a => a.question), ...(cov.gaps || [])];
    return { ...r, coverage: { ...cov, gaps: all.filter(q => !evidence.has(q)), answered: all.filter(q => evidence.has(q)).map(q => ({ question: q, answer: evidence.get(q) })) } };
  };
  const currentKit = () => ({ ...kit, tailored_resume: withAnswers(resume) });

  async function answer(path, options) {
    const url = new URL(path, location.origin);
    const route = url.pathname;
    const body = options?.body ? JSON.parse(options.body) : {};
    const ok = data => ({ ok: true, status: 200, data });
    if (route === '/profile') { await wait('fast'); return ok(profile); }
    if (route === '/credits') { await wait('fast'); return ok({ balance: 240, email: profile.email, costs }); }
    if (route === '/status') { await wait('fast'); return ok({ status: 'ok' }); }
    if (route === '/application') { await wait('fast'); return generated ? ok(currentKit()) : { ok: false, status: 404, data: { error: 'No application found' } }; }
    if (/^\/application\/[^/]+\/versions$/.test(route)) { await wait('fast'); return ok(resume === rewrittenResume ? [{ data: { tailored_resume: instantResume } }] : []); }
    if (route === '/generate') { await wait('generate'); generated = true; return ok(currentKit()); }
    if (route === '/cover-letter') { await wait('cover'); return ok({ text: coverLetter }); }
    if (route === '/resume-tailor') { await wait('rewrite'); resume = { ...rewrittenResume, generated_at: new Date().toISOString(), evidence_used: evidence.size }; return ok({ ...withAnswers(resume), resume_history: [resume, instantResume] }); }
    if (route === '/analyze') { await wait('analyze'); return ok({ mappings: [] }); }
    if (route === '/interview/context') { await wait('save'); if (body.question && body.answer) evidence.set(body.question, body.answer); return ok({ ok: true }); }
    if (route === '/interview') { await wait('fast'); return ok([...evidence].map(([question, answer]) => ({ question, answer }))); }
    if (route === '/voice' || route === '/quick-answer') { await wait('voice'); return ok({ text: 'Voice answers work in the installed extension.', answer: 'Voice answers work in the installed extension.' }); }
    await wait('fast');
    return ok({ ok: true });
  }

  const storage = { serverUrl: location.origin, apiKey: 'demo', mode: 'cloud', alwaysRegenerate: false };
  window.chrome = {
    storage: {
      sync: {
        get(_keys, callback) { const result = { ...storage }; if (callback) { setTimeout(() => callback(result), 0); return undefined; } return Promise.resolve(result); },
        set(_values, callback) { callback?.(); },
        remove(_keys, callback) { callback?.(); },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      id: 'demo', lastError: undefined,
      onMessage: { addListener(fn) { window.__demoOnMessage = fn; } },
      sendMessage(message, callback) {
        if (message?.type === 'SERVER_FETCH') {
          answer(message.url.replace(location.origin, ''), message.options).then(callback, () => callback?.({ ok: false, status: 0, data: null }));
          return;
        }
        if (message?.type === 'GET_IFRAME_QUESTIONS') return callback?.({ questions: [] });
        callback?.({});
      },
    },
  };

  const button = document.getElementById('demo-ext');
  const hint = document.getElementById('demo-hint');
  let loaded = false;
  const loadScript = src => new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = reject; document.head.appendChild(s); });
  button.addEventListener('click', async () => {
    button.classList.remove('pulse');
    if (hint) hint.hidden = true;
    // A second click reopens a closed sidebar, as the real toolbar button does.
    if (loaded) { window.__demoOnMessage?.({ type: 'FORCE_INIT' }, {}, () => {}); return; }
    loaded = true;
    window.__JAA_ATS = 'greenhouse';
    window.__JAA_FORCE = true;
    await loadScript('/demo/jspdf.js');
    await loadScript('/demo/content.js');
  });

  // The form never goes anywhere. Submitting is always the candidate's step.
  const done = document.getElementById('demo-done');
  document.getElementById('demo-submit').addEventListener('click', event => { event.preventDefault(); done.hidden = false; });
  document.getElementById('demo-close').addEventListener('click', () => { done.hidden = true; });
})();
