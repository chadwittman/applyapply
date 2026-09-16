// Audit reproductions, not regression gates: OBSERVED means the defect exists.
// Uses a new localhost database, synthetic identities, and mocked providers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const requireServer = Module.createRequire(path.resolve(__dirname, '../server/package.json'));
const { Pool } = requireServer('pg');
const jwt = requireServer('jsonwebtoken');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-audit-'));
const database = `aa_audit_${process.pid}_${Date.now()}`;
const localConnection = `postgresql://${encodeURIComponent(os.userInfo().username)}@127.0.0.1:5432/`;
const admin = new Pool({ connectionString: localConnection + 'postgres', ssl: false });
const originalFetch = global.fetch;
const children = [];
let db, server, origin, internal, modelResult, modelFailure = false;
let lastPrompt = '', internalHits = 0;
const observations = [];
function observed(name, condition, details) {
  assert.ok(condition, `Reproduction changed: ${name}`);
  observations.push({ name, details });
  console.log(`OBSERVED: ${name}: ${JSON.stringify(details)}`);
}
function redirectFile(file) {
  if (typeof file !== 'string') return file;
  if (file === path.join(root, 'logs')) return scratch;
  if (file.startsWith(path.join(root, 'logs') + path.sep)) return path.join(scratch, path.basename(file));
  if (['sourced-jobs.json', 'applied-log.json'].includes(path.basename(file))) return path.join(scratch, path.basename(file));
  return file;
}
const localFs = new Proxy(fs, { get(target, key) {
  const value = target[key];
  if (['readFileSync', 'writeFileSync', 'existsSync', 'createWriteStream', 'statSync', 'openSync'].includes(key)) {
    return (file, ...args) => value.call(target, redirectFile(file), ...args);
  }
  return value;
} });
function fakeSpawn() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 900000 + children.length;
  child.unref = () => {};
  children.push(child);
  return child;
}
function loadInstrumented(relative, transform = s => s) {
  const filename = path.join(root, relative);
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  mod.require = id => id === 'fs' ? localFs : id === 'child_process' ? { spawn: fakeSpawn } : originalRequire(id);
  mod._compile(transform(fs.readFileSync(filename, 'utf8')), filename);
  return mod.exports;
}
const token = email => jwt.sign({ email }, 'audit-secret-local-only');
async function call(method, route, email, body) {
  const response = await originalFetch(origin + route, {
    method,
    headers: { ...(email ? { 'x-api-key': token(email) } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
}
async function balance(email, credits) {
  await db.getOrCreateUser(email);
  await db.pool.query('UPDATE users SET credits=$1 WHERE email=$2', [credits, email]);
}
async function main() {
  await admin.query(`CREATE DATABASE "${database}"`);
  Object.assign(process.env, {
    DATABASE_URL: localConnection + database, DATABASE_SSL: 'off', NODE_ENV: 'test',
    APPLYAPPLY_JWT_SECRET: 'audit-secret-local-only', ALLOW_LOCAL_BYPASS: 'false',
    ANTHROPIC_API_KEY: 'audit-fake-key', OPENROUTER_API_KEY: '', RESEND_API_KEY: '',
    STRIPE_SECRET_KEY: 'sk_test_audit_fake', STRIPE_WEBHOOK_SECRET: 'whsec_audit_fake',
    HYPERBROWSER_API_KEY: '', APP_ORIGIN: 'http://127.0.0.1',
    JAA_USER_EMAIL: '', JAA_PREFETCH_ONLY: '', JAA_TARGET_ROLES: '', JAA_ENABLED_SOURCES: '',
  });
  db = requireServer('./db');
  await db.initSchema();
  global.fetch = async (url, options) => {
    const u = new URL(url);
    if (u.hostname === '127.0.0.1') return originalFetch(url, options);
    if (u.hostname === 'api.anthropic.com') {
      lastPrompt = JSON.parse(options.body).messages[0].content;
      if (modelFailure) return new Response('{}', { status: 503 });
      return Response.json({ content: [{ type: 'text', text: JSON.stringify(modelResult) }] });
    }
    throw new Error(`Audit blocked external fetch: ${u.hostname}`);
  };
  const loaded = loadInstrumented('server/server.js', s => s + '\nmodule.exports.audit = {runScheduledSourcing};');
  server = loaded.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const alice = 'alice@audit.invalid', bob = 'bob@audit.invalid';
  await balance(alice, 200); await balance(bob, 200);
  const jobUrl = 'https://jobs.lever.co/audit/posting-1';
  const base = { id: 'audit-company-pm', company: 'Audit Company', role: 'PM', url: jobUrl, profile: {}, tailored: {} };
  for (const email of [alice, bob]) await db.upsertJob({ ...base, user_email: email, found_at: new Date().toISOString() });
  modelResult = base;
  assert.equal((await call('POST', '/generate', alice, { url: jobUrl, description: 'Synthetic posting' })).status, 200);
  observed('Generation stamps another user job', Boolean((await db.getJobByUrl(jobUrl, bob)).kit_generated_at), { bobKitGenerated: true });
  assert.equal((await call('POST', '/generate', bob, { url: jobUrl, description: 'Synthetic posting' })).status, 200);
  const aliceKit = await call('GET', '/application/audit-company-pm', alice);
  observed('Same-role generation replaces kit owner', aliceKit.status === 403 && (await db.getKit(base.id)).user_email === bob, { aliceStatus: aliceKit.status, owner: bob });

  const unrelated = await call('GET', '/application?url=' + encodeURIComponent('https://unrelated.invalid/audit/posting-1'), bob);
  observed('Kit cache ignores hostname', unrelated.status === 200, { requestedHost: 'unrelated.invalid', returnedUrl: unrelated.data.url });
  await balance(bob, 0);
  const cached = await call('POST', '/generate', bob, { url: jobUrl, description: 'Synthetic' });
  observed('Free cached kit requires credits', cached.status === 402, { status: cached.status });
  await balance(bob, 200);
  modelFailure = true;
  const failed = await call('POST', '/generate', bob, { url: jobUrl, description: 'Synthetic', force: true });
  observed('Failed regeneration deletes paid kit', failed.status === 500 && !(await db.getKit(base.id)), { status: failed.status, kitGone: true });
  modelFailure = false;

  const hostileUrl = 'https://jobs.lever.co/audit/hostile';
  modelResult = { ...base, id: 'model-chosen-id', url: 'https://unrelated.invalid/rewritten', profile: { first_name: 'Invented', work_authorization: 'Yes' } };
  const hostile = await call('POST', '/generate', alice, { url: hostileUrl, description: 'Synthetic untrusted posting' });
  observed('Model controls persisted identity and destination', hostile.status === 200 && hostile.data.url === modelResult.url && hostile.data.profile.first_name === 'Invented', { persistedModelProfile: true, persistedModelUrl: true, modelMocked: true });

  internal = http.createServer((_req, res) => { internalHits++; res.end('INTERNAL_AUDIT_CANARY '.repeat(30)); });
  internal.listen(0, '127.0.0.1');
  await new Promise(resolve => internal.once('listening', resolve));
  const internalUrl = `http://127.0.0.1:${internal.address().port}/private`;
  modelResult = { ...base, id: 'ssrf', url: internalUrl };
  await call('POST', '/generate', alice, { url: internalUrl });
  observed('User URL reaches loopback and model prompt', internalHits === 1 && lastPrompt.includes('INTERNAL_AUDIT_CANARY'), { internalHits, canaryInPrompt: true });

  const marker = '</script><script>globalThis.AA_AUDIT_XSS=1</script>';
  const html = await call('GET', '/auth/success?ext=' + encodeURIComponent(marker));
  observed('Unauthenticated auth page emits injected script', html.data.includes(marker) && !html.headers.has('content-security-policy'), { scriptBreakout: true, csp: false, browserExecutionTested: false });

  await call('POST', '/audit/feedback', alice, { url: jobUrl, feedback: 'private-audit-marker', note: 'ALICE_PRIVATE_NOTE' });
  const feedback = await call('GET', '/audit/feedback', bob);
  observed('Authenticated audit feedback leaks across accounts', JSON.stringify(feedback.data).includes('ALICE_PRIVATE_NOTE'), { bobReadsAliceNote: true });
  localFs.writeFileSync(path.join(root, 'logs/last-run-detail.json'), JSON.stringify({ marker: 'ALICE_PRIVATE_RUN' }));
  observed('Authenticated audit run detail leaks across accounts', (await call('GET', '/audit/data', bob)).data.marker === 'ALICE_PRIVATE_RUN', { bobReadsAliceRun: true });
  localFs.writeFileSync(path.join(root, 'logs/last-run-detail.json'), JSON.stringify({ date: '2026-09-16', sources: [{ name: 'Private source', rawCount: 1, jobs: [{ company: 'ALICE_PRIVATE_COMPANY', role: 'PM', url: jobUrl, outcome: 'added', fit_score: 8 }] }] }));
  const publicSourcing = await call('GET', '/sourcing');
  observed('Public sourcing HTML discloses private run', publicSourcing.status === 200 && publicSourcing.data.includes('ALICE_PRIVATE_COMPANY'), { authentication: 'none', privateRun: true });

  const race = 'race@audit.invalid';
  await balance(race, 10);
  const deductions = await Promise.all(Array.from({ length: 32 }, () => db.deductUserCredits(race, 10)));
  assert.equal(deductions.filter(Boolean).length, 1);
  assert.equal((await db.getUser(race)).credits, 0);
  console.log('PASS: conditional deduction: 32 concurrent attempts, one success, balance zero');
  const generateRace = 'generate-race@audit.invalid';
  await balance(generateRace, 10);
  modelResult = { ...base, id: 'generation-race', url: 'https://jobs.lever.co/audit/generation-race' };
  const generationResponses = await Promise.all(Array.from({ length: 2 }, () => call('POST', '/generate', generateRace, { url: modelResult.url, description: 'Synthetic' })));
  assert.deepEqual(generationResponses.map(r => r.status).sort(), [200, 402]);
  assert.equal((await db.getUser(generateRace)).credits, 0);
  console.log('PASS: concurrent /generate: one 200, one 402, balance zero');

  const sourceName = 'a16z job board';
  const catalog = (await call('GET', '/source/catalog')).data;
  const cost = catalog.find(s => s.name === sourceName).credits;
  await balance(race, cost);
  const oldGetUser = db.getUser;
  let readers = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  db.getUser = async email => {
    const row = await oldGetUser(email);
    if (email === race) { if (++readers === 2) release(); await barrier; }
    return row;
  };
  let manual;
  try { manual = await Promise.all([call('POST', '/source/run', race, { sources: [sourceName] }), call('POST', '/source/run', race, { sources: [sourceName] })]); }
  finally { db.getUser = oldGetUser; }
  observed('Concurrent manual sourcing starts twice for one debit', manual.every(r => r.data.status === 'started') && (await db.getUser(race)).credits === 0, { starts: 2, debits: 1, controlledReadInterleaving: true });
  for (const child of children) child.emit('exit', 1);
  await new Promise(resolve => setTimeout(resolve, 80));
  observed('Failed manual sourcing is not refunded', (await db.getUser(race)).credits === 0, { balance: 0, expectedRefund: cost });

  const scheduled = 'scheduled@audit.invalid';
  await balance(scheduled, cost * 2);
  await db.setSchedule(scheduled, { hour: 0, minute: 0, enabled: true, sources: [sourceName] });
  const row = await db.getSchedule(scheduled);
  await Promise.all([loaded.audit.runScheduledSourcing(row), loaded.audit.runScheduledSourcing(row)]);
  observed('Same due schedule is claimable twice', (await db.getUser(scheduled)).credits === 0, { starts: 2, debits: 2, dispatchInvokedDirectly: true });

  const stripe = requireServer('stripe')('sk_test_audit_fake');
  const payer = 'payer@audit.invalid';
  const event = { id: 'evt_audit_one', type: 'checkout.session.completed', data: { object: { id: 'cs_audit_one', customer_email: payer, amount_total: 1000, payment_status: 'unpaid', currency: 'usd' } } };
  async function webhook(e) {
    const payload = JSON.stringify(e);
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const response = await originalFetch(origin + '/webhook/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body: payload });
    assert.equal(response.status, 200);
    return response.json();
  }
  await webhook(event);
  observed('Signed unpaid checkout grants credits', (await db.getUser(payer)).credits === 1000, { credits: 1000, paymentStatus: 'unpaid', syntheticSignedEvent: true });
  assert.equal((await webhook(event)).duplicate, true);
  assert.equal((await db.getUser(payer)).credits, 1000);
  console.log('PASS: exact Stripe event replay does not double-credit');
  await webhook({ ...event, id: 'evt_audit_two' });
  observed('Distinct events for same checkout double-credit', (await db.getUser(payer)).credits === 2000, { sessionIds: 1, eventIds: 2, credits: 2000 });

  process.env.JAA_ENABLED_SOURCES = JSON.stringify(['Lever jobs (Google)']);
  process.env.JAA_TARGET_ROLES = 'Product Manager';
  process.env.JAA_USER_EMAIL = 'source@audit.invalid';
  const source = loadInstrumented('source.js', s => s.replace(/main\(\)\.catch\([^\n]+\);\s*$/, '') + '\nmodule.exports = {runBrowserSources, main};');
  await db.putCachedSource(db.cacheKeyFor('Lever jobs (Google)', 'Product Manager', false), 'Lever jobs (Google)', db.roleKeyFor('Product Manager'), { rawCount: 1, allScanned: [{ company: '', role: 'Product Manager', url: jobUrl, fit_score: 0 }] });
  const results = await source.runBrowserSources('fake', 'fake');
  const jobs = results.flatMap(r => r.jobs);
  observed('Cached Google role matches all fail fit threshold', jobs.length === 1 && jobs.filter(j => (j.fit_score || 5) >= 6).length === 0, { roleMatches: 1, accepted: 0, cachedFit: 0 });
  const before = (await db.getRuns(100, process.env.JAA_USER_EMAIL)).length;
  await source.main();
  observed('Missing sourcing provider resolves successfully without run record', (await db.getRuns(100, process.env.JAA_USER_EMAIL)).length === before, { mainResolved: true, newRunRows: 0 });
  await db.pool.query('DELETE FROM source_cache');
  process.env.HYPERBROWSER_API_KEY = 'audit-fake';
  await source.main();
  observed('Sourcing provider rejection resolves successfully without run record', (await db.getRuns(100, process.env.JAA_USER_EMAIL)).length === before, { mainResolved: true, newRunRows: 0, providerFailureInjected: true });

  const variantOwner = 'variants@audit.invalid';
  await db.upsertJob({ ...base, id: 'variant-one', user_email: variantOwner, found_at: new Date().toISOString(), status: 'skipped' });
  await db.upsertJob({ ...base, id: 'variant-two', url: jobUrl + '/apply', user_email: variantOwner, found_at: new Date().toISOString() });
  const variants = await db.getJobs(null, 200, variantOwner);
  observed('URL variants bypass per-owner uniqueness', variants.length === 2 && variants.some(j => j.status === 'skipped') && variants.some(j => j.status === 'new'), { rows: variants.length, statuses: variants.map(j => j.status) });
  let collision = false;
  try { await db.upsertJob({ ...base, id: 'variant-one', url: jobUrl + '-different-opening', user_email: variantOwner, found_at: new Date().toISOString() }); }
  catch (e) { collision = e.code === '23505'; }
  observed('Same company-role slug rejects a distinct posting', collision, { postgresCode: '23505' });

  const content = fs.readFileSync(path.join(root, 'extension/content.js'), 'utf8');
  const binarySource = content.slice(content.indexOf('function binaryAnswerForLabel('), content.indexOf('\nfunction chooseGreenhouseCombobox('));
  const binary = new Function(binarySource + '; return binaryAnswerForLabel;')();
  observed('Qualification answers are unconditional', binary('Do you have 10+ years of product marketing?') === 'Yes' && binary('Do you require visa sponsorship?') === 'No', { experience: 'Yes', sponsorship: 'No', profileRead: false });
  console.log(`\n${observations.length} defects reproduced; 3 positive controls passed. No external providers called.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  global.fetch = originalFetch;
  for (const child of children) { child.stdout.destroy(); child.stderr.destroy(); }
  if (server) await new Promise(resolve => server.close(resolve));
  if (internal) await new Promise(resolve => internal.close(resolve));
  if (db) await db.pool.end();
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(error => { console.error(error.message); process.exitCode = 1; });
  await admin.end();
  fs.rmSync(scratch, { recursive: true, force: true });
});
