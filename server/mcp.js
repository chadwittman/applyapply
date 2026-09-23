// MCP server at /mcp (Streamable HTTP, stateless, JSON responses) so a user's
// own agent can use applyapply with a personal API key. Each tool calls the
// existing HTTP routes on this server with the caller's credentials, so
// credits, validation, idempotency and ownership behave exactly as they do in
// the product. search_listings reads the shared public ledger directly.
const http = require('http');
const { roleMatcher } = require('./roles');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });

const TOOLS = [
  { name: 'get_account', description: 'The account: email, credit balance, and whether it is ready to write applications (a resume and target roles are set). Check this first: without a resume the kits are weak.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_profile', description: 'Your saved profile: contact details, target roles, location preference, work authorization, background.', inputSchema: { type: 'object', properties: {} } },
  { name: 'update_profile', description: 'Update profile fields. Only the fields you pass change.', inputSchema: { type: 'object', properties: {
    first_name: str('First name'), last_name: str('Last name'), phone: str('Phone'), linkedin: str('LinkedIn URL'), location: str('City, region'),
    location_pref: str('Where you will work', { enum: ['remote', 'hybrid', 'any'] }), target_roles: str('Comma-separated job titles, e.g. "Head of Product, Director of Product"'),
    salary: str('Minimum annual base salary in USD'), work_authorization: str('Authorized to work in the US', { enum: ['', 'yes', 'no'] }),
    sponsorship: str('Needs visa sponsorship', { enum: ['', 'yes', 'no'] }), bio: str('Background the application writer uses: experience, achievements, numbers'),
    resume: str('The full text of the person\'s resume, as they wrote it. Every tailored resume is built from this, so paste it verbatim rather than summarising.'),
    current_employer: str('Current employer'), school: str('School'), website: str('Personal site'),
  } } },
  { name: 'search_listings', description: 'Search applyapply\'s ledger of current public job listings (a16z and Sequoia portfolio boards, Himalayas, We Work Remotely, Hacker News Who is hiring). Free. Matches titles by words against your target roles unless you pass roles.', inputSchema: { type: 'object', properties: {
    roles: str('Comma-separated titles to match instead of your profile\'s target roles'),
    window: str('last_24_hours or all_current', { enum: ['last_24_hours', 'all_current'] }),
    remote_only: { type: 'boolean', description: 'Only listings marked remote' },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 25' },
  } } },
  { name: 'list_sources', description: 'Sources a sourcing run can use, with their credit cost.', inputSchema: { type: 'object', properties: {} } },
  { name: 'start_sourcing_run', description: 'Start a sourcing run: find new matching roles, check their location against your preference, and add them to your pipeline. Costs credits per source (see list_sources). Runs in the background; poll get_sourcing_status.', inputSchema: { type: 'object', properties: {
    sources: { type: 'array', items: { type: 'string' }, description: 'Source names; default is every default source' },
  } } },
  { name: 'get_sourcing_status', description: 'Whether a sourcing run is active, how the last one ended, and pipeline counts.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_pipeline', description: 'Jobs in your pipeline, newest first.', inputSchema: { type: 'object', properties: {
    status: str('Filter by status', { enum: ['new', 'reviewed', 'applying', 'applied', 'skipped', 'rejected'] }),
  } } },
  { name: 'generate_application_kit', description: 'Write a tailored application kit for a job URL: resume, cover note, why-this-role, and answers to the form\'s questions. Costs 10 credits; returns the saved kit without charge if one exists. applyapply never submits applications; the user reviews and submits.', inputSchema: { type: 'object', required: ['url'], properties: {
    url: str('The job posting or application URL'), force: { type: 'boolean', description: 'Write a fresh kit even if one exists (charges again)' },
  } } },
  { name: 'get_application_kit', description: 'The saved kit for a job URL, if one exists. Free.', inputSchema: { type: 'object', required: ['url'], properties: { url: str('The job URL') } } },
  { name: 'get_kit_link', description: 'A private page for a kit that the person can open on a phone without signing in, plus direct links to their tailored resume and cover letter as PDFs. Free. Hand this to the person you are working for.', inputSchema: { type: 'object', required: ['url'], properties: { url: str('The job URL') } } },
  { name: 'list_resume_questions', description: 'What the tailored resume for a job still cannot evidence: the questions worth asking the person, with any answers they have already given. Free.', inputSchema: { type: 'object', required: ['url'], properties: { url: str('The job URL') } } },
  { name: 'answer_resume_question', description: 'Save the person\'s answer to one of those questions. It is stored on their profile and strengthens every future application, not just this one. Free. Use their own words; do not invent experience.', inputSchema: { type: 'object', required: ['question', 'answer'], properties: {
    question: str('The question, exactly as list_resume_questions gave it'), answer: str('What the person said, in their words') } } },
  { name: 'rewrite_resume', description: 'Rewrite the tailored resume for a job using everything the person has told us, and report the new match. Costs credits (see list_sources pricing in get_account). Ask them first.', inputSchema: { type: 'object', required: ['url'], properties: { url: str('The job URL') } } },
  { name: 'list_saved_answers', description: 'Everything the person has told us about their work, saved from earlier questions. Free. Read this before asking them something they have already answered.', inputSchema: { type: 'object', properties: {} } },
  { name: 'send_feedback', description: 'Report something broken or missing in applyapply (a job link that produced a bad kit, a wrong question). It reaches the people building it.', inputSchema: { type: 'object', required: ['message'], properties: { message: str('What happened, and what was expected') } } },
  { name: 'set_job_status', description: 'Move a pipeline job to a status, e.g. applied after the user submits.', inputSchema: { type: 'object', required: ['url', 'status'], properties: {
    url: str('The job URL as it appears in the pipeline'), status: str('New status', { enum: ['new', 'reviewed', 'applying', 'applied', 'skipped', 'rejected'] }),
  } } },
];

module.exports = function mountMcp(app, { db, port, limiter, sourceNames }) {
  // Loop back to this same server over plain http (not fetch, which tests and
  // provider shims replace), on the port this request actually arrived on.
  function call(req, method, path, body) {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json', authorization: req.headers.authorization || `Bearer ${req.headers['x-api-key']}`,
      ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) };
    return new Promise((resolve, reject) => {
      const out = http.request({ host: '127.0.0.1', port: req.socket.localPort || port, path, method, headers, timeout: 170000 }, res => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(raw); } catch {}
          if (res.statusCode >= 400) reject(new Error(data?.error || `Request failed (${res.statusCode})`));
          else resolve(data);
        });
      });
      out.on('timeout', () => out.destroy(new Error('Request timed out')));
      out.on('error', reject);
      if (payload) out.write(payload);
      out.end();
    });
  }

  async function searchListings(req, args) {
    const profile = await db.getProfileByUserEmail(req.apiKeyEmail);
    const roles = args.roles || profile?.target_roles || '';
    if (!roles) throw new Error('No roles to match: pass roles or set target_roles with update_profile');
    const matcher = roleMatcher(roles);
    const rows = await db.getListings(sourceNames(), args.window === 'all_current' ? 0 : 24);
    const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
    const hits = rows.filter(r => matcher.test(r.role) && (!args.remote_only || r.remote === true || /remote/i.test(r.location)));
    return { roles, window: args.window === 'all_current' ? 'all_current' : 'last_24_hours', total_matches: hits.length,
      listings: hits.slice(0, limit).map(r => ({ company: r.company, role: r.role, location: r.location, remote: r.remote, url: r.url, source: r.source,
        posted_at: r.posted_at, posted_precision: r.posted_precision, salary: r.salary })) };
  }

  const handlers = {
    get_account: async req => {
      const [account, profile] = await Promise.all([call(req, 'GET', '/auth/me'), call(req, 'GET', '/profile').catch(() => ({}))]);
      const missing = [!profile?.resume_text && 'resume', !profile?.target_roles && 'target_roles', !profile?.location && 'location'].filter(Boolean);
      return { ...account, ready_to_apply: !missing.length, missing, kit_costs_credits: 10 };
    },
    get_profile: req => call(req, 'GET', '/profile'),
    update_profile: (req, args) => call(req, 'POST', '/profile', { ...args, ...(args.resume ? { resume_text: args.resume, resume: undefined } : {}) }),
    search_listings: searchListings,
    list_sources: async req => (await call(req, 'GET', '/source/catalog')).map(s => ({ name: s.name, credits: s.credits, default: s.on, description: s.desc })),
    start_sourcing_run: (req, args) => call(req, 'POST', '/source/run', args.sources ? { sources: args.sources } : {}),
    get_sourcing_status: req => call(req, 'GET', '/source/status'),
    list_pipeline: (req, args) => call(req, 'GET', '/sourced' + (args.status ? '?status=' + encodeURIComponent(args.status) : '')),
    generate_application_kit: (req, args) => call(req, 'POST', '/generate', { url: args.url, force: !!args.force }),
    get_application_kit: (req, args) => call(req, 'GET', '/application?url=' + encodeURIComponent(args.url)),
    set_job_status: (req, args) => call(req, 'POST', '/sourced/status', { url: args.url, status: args.status }),
    get_kit_link: (req, args) => call(req, 'POST', '/kit-link', { url: args.url }),
    list_resume_questions: async (req, args) => {
      const kit = await call(req, 'GET', '/application?url=' + encodeURIComponent(args.url));
      const cov = kit?.tailored_resume?.coverage || {};
      return { match: kit?.tailored_resume?.jev_match?.score ? Math.round((kit.tailored_resume.jev_match.score / 5) * 100) + '%' : null,
        unanswered: cov.gaps || [], answered: cov.answered || [] };
    },
    answer_resume_question: (req, args) => call(req, 'POST', '/interview/context', { question: args.question, answer: args.answer }),
    rewrite_resume: async (req, args) => {
      const kit = await call(req, 'GET', '/application?url=' + encodeURIComponent(args.url));
      if (!kit?.id) throw new Error('No kit for that job yet. Use generate_application_kit first.');
      const resume = await call(req, 'POST', '/resume-tailor', { appId: kit.id });
      const pct = x => Math.round((Number(x) / 5) * 100) + '%';
      return { match: resume.jev_match?.score ? pct(resume.jev_match.score) : null,
        previous_match: resume.previous_match_score ? pct(resume.previous_match_score) : null,
        answers_used: resume.evidence_used || 0, still_unanswered: resume.coverage?.gaps || [], summary: resume.summary };
    },
    list_saved_answers: req => call(req, 'GET', '/interview'),
    send_feedback: (req, args) => call(req, 'POST', '/feedback', { message: args.message, page: 'mcp' }),
  };

  async function handle(req, msg) {
    const reply = result => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
    if (msg?.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request');
    if (msg.id === undefined) return null; // notification: nothing to answer
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return reply({ protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'applyapply', version: '1.0.0' },
          instructions: 'applyapply finds jobs matching the user\'s target roles and writes tailored application kits. It never submits applications: hand the kit and URL back to the user to review and submit. generate_application_kit and start_sourcing_run spend the user\'s credits; check get_account first.' });
      }
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': {
        const handler = handlers[msg.params?.name];
        if (!handler) return fail(-32602, 'Unknown tool: ' + msg.params?.name);
        try {
          const data = await handler(req, msg.params.arguments || {});
          return reply({ content: [{ type: 'text', text: JSON.stringify(data ?? null, null, 2) }] });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: e.message }], isError: true });
        }
      }
      default: return fail(-32601, 'Method not found: ' + msg.method);
    }
  }

  app.post('/mcp', limiter, async (req, res) => {
    if (!req.apiKeyEmail) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="applyapply", error="invalid_token"');
      return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Create an API key at https://applyapply.xyz/setup and send it as Authorization: Bearer <key>' } });
    }
    const batch = Array.isArray(req.body);
    const replies = (await Promise.all((batch ? req.body : [req.body]).map(m => handle(req, m)))).filter(Boolean);
    if (!replies.length) return res.status(202).end();
    res.json(batch ? replies : replies[0]);
  });
  app.get('/mcp', (req, res) => res.status(405).set('Allow', 'POST').json({ error: 'This MCP server answers POST requests only (stateless Streamable HTTP).' }));
  app.delete('/mcp', (req, res) => res.status(405).set('Allow', 'POST').end());
  return { TOOLS };
};
