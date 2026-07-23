const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const app = express();
const PORT = 3747;
const APPS_DIR = path.join(__dirname, '../applications');
fs.mkdirSync(APPS_DIR, { recursive: true });

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});
// Capture raw body for Stripe webhook signature verification
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// ── Credits ───────────────────────────────────────────────────────────────────

const CREDITS_FILE = path.join(__dirname, '../data/credits.json');
fs.mkdirSync(path.join(__dirname, '../data'), { recursive: true });

const CREDIT_COSTS = {
  source_run: 30,
  generate: 10,
  cover_letter: 8,
  analyze: 3,
  voice: 2,
};

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(CREDITS_FILE, 'utf-8')); } catch { return {}; }
}

function saveUsers(u) {
  fs.writeFileSync(CREDITS_FILE, JSON.stringify(u, null, 2));
}

function isLocalRequest(req) {
  const ip = req.ip || req.connection.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function requireCredits(action) {
  return (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      if (isLocalRequest(req)) return next();
      return res.status(401).json({ error: 'x-api-key header required' });
    }
    const users = loadUsers();
    const user = users[apiKey];
    if (!user) return res.status(401).json({ error: 'Invalid API key' });
    const cost = CREDIT_COSTS[action] || 0;
    if (user.balance < cost) return res.status(402).json({ error: 'Insufficient credits', balance: user.balance, required: cost });
    user.balance -= cost;
    user.last_used = new Date().toISOString().slice(0, 10);
    saveUsers(users);
    req.apiKey = apiKey;
    req.creditUser = user;
    next();
  };
}

function loadAdminSecret() {
  try {
    const env = fs.readFileSync(path.join(process.env.HOME, '.openclaw/.env'), 'utf-8');
    const m = env.match(/APPLYAPPLY_ADMIN_SECRET=(.+)/);
    if (m?.[1]) return m[1].trim();
  } catch {}
  return process.env.APPLYAPPLY_ADMIN_SECRET || null;
}

function requireAdmin(req, res, next) {
  const secret = loadAdminSecret();
  if (!secret) return res.status(503).json({ error: 'Admin not configured' });
  if (req.headers['x-admin-secret'] !== secret) return res.status(403).json({ error: 'Forbidden' });
  next();
}

app.get('/credits', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    if (isLocalRequest(req)) return res.json({ mode: 'self_hosted', balance: null });
    return res.status(401).json({ error: 'x-api-key required' });
  }
  const users = loadUsers();
  const user = users[apiKey];
  if (!user) return res.status(401).json({ error: 'Invalid API key' });
  res.json({ balance: user.balance, email: user.email, costs: CREDIT_COSTS });
});

app.post('/admin/keys', requireAdmin, (req, res) => {
  const { email, credits } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const users = loadUsers();
  const apiKey = require('crypto').randomBytes(16).toString('hex');
  users[apiKey] = { email, balance: credits || 0, total_purchased: credits || 0, created: new Date().toISOString().slice(0, 10) };
  saveUsers(users);
  res.json({ ok: true, apiKey, email, balance: users[apiKey].balance });
});

app.post('/admin/credits/add', requireAdmin, (req, res) => {
  const { apiKey, credits } = req.body;
  if (!apiKey || !credits) return res.status(400).json({ error: 'apiKey and credits required' });
  const users = loadUsers();
  if (!users[apiKey]) return res.status(404).json({ error: 'Key not found' });
  users[apiKey].balance += credits;
  users[apiKey].total_purchased = (users[apiKey].total_purchased || 0) + credits;
  saveUsers(users);
  res.json({ ok: true, balance: users[apiKey].balance });
});

app.get('/admin/users', requireAdmin, (req, res) => {
  const users = loadUsers();
  res.json(Object.entries(users).map(([key, u]) => ({ apiKey: key.slice(0, 8) + '…', email: u.email, balance: u.balance, total_purchased: u.total_purchased, created: u.created, last_used: u.last_used })));
});

// ── Stripe ────────────────────────────────────────────────────────────────────

const STRIPE_PRICE_ID = 'price_1TwTPEPGwHxMKnrmamj8B9wY';
const CREDITS_PER_DOLLAR = 100; // $0.01/credit → $10 = 1000 credits

function loadStripeKey() {
  try {
    const env = fs.readFileSync(path.join(process.env.HOME, '.openclaw/.env'), 'utf-8');
    const m = env.match(/STRIPE_SECRET_KEY=(.+)/);
    if (m?.[1]) return m[1].trim();
  } catch {}
  return process.env.STRIPE_SECRET_KEY || null;
}

function loadStripeWebhookSecret() {
  try {
    const env = fs.readFileSync(path.join(process.env.HOME, '.openclaw/.env'), 'utf-8');
    const m = env.match(/STRIPE_WEBHOOK_SECRET=(.+)/);
    if (m?.[1]) return m[1].trim();
  } catch {}
  return process.env.STRIPE_WEBHOOK_SECRET || null;
}

function issueKey(email, credits, stripeSessionId) {
  const apiKey = require('crypto').randomBytes(20).toString('hex');
  const users = loadUsers();
  users[apiKey] = {
    email,
    balance: credits,
    total_purchased: credits,
    created: new Date().toISOString().slice(0, 10),
    stripe_session: stripeSessionId || null,
  };
  saveUsers(users);

  const issuedFile = path.join(__dirname, '../data/issued-keys.json');
  let issued = [];
  try { issued = JSON.parse(fs.readFileSync(issuedFile, 'utf-8')); } catch {}
  issued.push({ email, apiKey, credits, date: new Date().toISOString(), stripe_session: stripeSessionId });
  fs.writeFileSync(issuedFile, JSON.stringify(issued, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log(`[STRIPE] Key issued: ${email}`);
  console.log(`[STRIPE] Credits: ${credits}`);
  console.log(`[STRIPE] API Key: ${apiKey}`);
  console.log('='.repeat(60) + '\n');

  return apiKey;
}

// GET /buy — simple purchase page
app.get('/buy', (req, res) => {
  const stripeKey = loadStripeKey();
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>applyapply — buy credits</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#ccc;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{width:360px;padding:40px;border:1px solid #1a1a1a;border-radius:8px}
h1{font-size:18px;font-weight:600;color:#fff;margin-bottom:6px}
.sub{font-size:13px;color:#444;margin-bottom:32px}
.price{font-size:28px;font-weight:700;color:#fff;margin-bottom:4px}
.price-sub{font-size:12px;color:#444;margin-bottom:28px}
label{display:block;font-size:11px;color:#555;margin-bottom:6px}
input{width:100%;background:#111;border:1px solid #222;border-radius:4px;color:#ccc;font-size:13px;padding:9px 12px;outline:none;margin-bottom:20px}
input:focus{border-color:#333}
button{width:100%;padding:11px;background:#fff;color:#000;border:none;border-radius:4px;font-size:13px;font-weight:600;cursor:pointer}
button:hover{background:#e5e5e5}
button:disabled{opacity:.4;cursor:default}
.error{font-size:11px;color:#ef4444;margin-top:12px;display:none}
</style>
</head>
<body>
<div class="card">
  <h1>applyapply</h1>
  <p class="sub">AI-powered job search agent</p>
  <div class="price">$10</div>
  <div class="price-sub">1,000 credits · no subscription</div>
  <label>Email address</label>
  <input id="email" type="email" placeholder="you@example.com" />
  <button id="btn" onclick="checkout()">Buy credits</button>
  <div class="error" id="err"></div>
</div>
<script>
async function checkout() {
  const email = document.getElementById('email').value.trim();
  const btn = document.getElementById('btn');
  const err = document.getElementById('err');
  if (!email || !email.includes('@')) { err.textContent='Enter a valid email'; err.style.display=''; return; }
  btn.disabled = true; btn.textContent = 'Redirecting…';
  try {
    const d = await fetch('/checkout', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ email }),
    }).then(r => r.json());
    if (d.url) window.location.href = d.url;
    else { err.textContent = d.error || 'Something went wrong'; err.style.display=''; btn.disabled=false; btn.textContent='Buy credits'; }
  } catch { err.textContent='Network error'; err.style.display=''; btn.disabled=false; btn.textContent='Buy credits'; }
}
</script>
</body>
</html>`);
});

// POST /checkout — create Stripe checkout session
app.post('/checkout', async (req, res) => {
  const stripeKey = loadStripeKey();
  if (!stripeKey) return res.status(503).json({ error: 'Stripe not configured' });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const stripe = require('stripe')(stripeKey);
    const host = `${req.protocol}://${req.get('host')}`;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      mode: 'payment',
      customer_email: email,
      success_url: `${host}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${host}/buy`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('[stripe checkout]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /checkout/success
app.get('/checkout/success', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.redirect('/buy');

  const stripeKey = loadStripeKey();
  let apiKey = null, credits = 0, email = '';

  try {
    const stripe = require('stripe')(stripeKey);
    const session = await stripe.checkout.sessions.retrieve(session_id);
    email = session.customer_details?.email || session.customer_email || '';

    const issuedFile = path.join(__dirname, '../data/issued-keys.json');
    const issued = JSON.parse(fs.readFileSync(issuedFile, 'utf-8'));
    const entry = issued.find(k => k.stripe_session === session_id);
    if (entry) { apiKey = entry.apiKey; credits = entry.credits; }
  } catch (e) {
    console.error('[checkout/success]', e.message);
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>applyapply — your key</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#ccc;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{width:480px;padding:40px;border:1px solid #1a1a1a;border-radius:8px}
h2{font-size:18px;font-weight:600;color:#fff;margin-bottom:8px}
.sub{font-size:13px;color:#444;margin-bottom:32px}
.label{font-size:11px;color:#555;margin-bottom:6px}
.key-box{background:#111;border:1px solid #222;border-radius:4px;padding:12px 14px;font-family:"SF Mono",Menlo,monospace;font-size:12px;color:#4ade80;word-break:break-all;margin-bottom:8px;cursor:pointer;user-select:all}
.copy-hint{font-size:11px;color:#333;margin-bottom:28px}
.instructions{font-size:12px;color:#444;line-height:1.8}
.instructions b{color:#666}
</style>
</head>
<body>
<div class="card">
  <h2>You're in</h2>
  <p class="sub">${credits} credits · ${email}</p>
  <div class="label">Your API key — copy this now</div>
  <div class="key-box" onclick="copyKey(this)">${apiKey || '(key not found — contact support)'}</div>
  <div class="copy-hint" id="hint">click to copy</div>
  <div class="instructions">
    <b>Setup:</b><br>
    1. Install the applyapply Chrome extension<br>
    2. Open the extension → Settings<br>
    3. Paste your key and save<br>
    4. Done — credits deduct automatically as you use it
  </div>
</div>
<script>
function copyKey(el) {
  navigator.clipboard.writeText(el.textContent.trim()).then(() => {
    document.getElementById('hint').textContent = 'copied!';
    setTimeout(() => document.getElementById('hint').textContent = 'click to copy', 2000);
  });
}
</script>
</body>
</html>`);
});

// POST /webhook/stripe
app.post('/webhook/stripe', async (req, res) => {
  const stripeKey = loadStripeKey();
  if (!stripeKey) return res.status(503).send('Stripe not configured');

  const stripe = require('stripe')(stripeKey);
  const webhookSecret = loadStripeWebhookSecret();
  let event;

  if (webhookSecret && req.rawBody) {
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], webhookSecret);
    } catch (e) {
      console.error('[stripe webhook] signature failed:', e.message);
      return res.status(400).send(`Webhook error: ${e.message}`);
    }
  } else {
    event = req.body;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email || session.customer_email;
    const amountPaid = session.amount_total || 0;
    const credits = Math.floor((amountPaid / 100) * CREDITS_PER_DOLLAR);

    const apiKey = issueKey(email, credits, session.id);

    // TODO: email apiKey to the user
    // For now it's logged to console and data/issued-keys.json
  }

  res.json({ received: true });
});

// ─────────────────────────────────────────────────────────────────────────────

const PROFILE = {
  first_name: 'Chad', last_name: 'Wittman',
  email: 'wittman.c@gmail.com', phone: '920-378-6761',
  linkedin: 'https://linkedin.com/in/chadwittman',
  github: 'https://github.com/chadwittman',
  twitter: 'https://x.com/ChadWittman',
  website: 'https://youtu.be/lS140EUgOg4',
  location: 'Austin, TX', work_authorization: 'U.S. Citizen, no sponsorship needed',
  current_employer: 'ELDRICK', school: 'University of Wisconsin (UWEC)',
};

function loadKeys() {
  try {
    const env = fs.readFileSync(path.join(process.env.HOME, '.openclaw/.env'), 'utf-8');
    const match = env.match(/ANTHROPIC_API_KEY=(.+)/);
    if (match?.[1]) return { key: match[1].trim(), provider: 'anthropic' };
  } catch {}
  if (process.env.ANTHROPIC_API_KEY) return { key: process.env.ANTHROPIC_API_KEY, provider: 'anthropic' };
  try {
    const secrets = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.cutline/secrets.json'), 'utf-8'));
    if (secrets.openrouter) return { key: secrets.openrouter, provider: 'openrouter' };
  } catch {}
  return null;
}

const keys = loadKeys();
const MODEL_OPENROUTER = 'anthropic/claude-haiku-4-5';
const MODEL_ANTHROPIC = 'claude-haiku-4-5-20251001';

function loadApps() {
  if (!fs.existsSync(APPS_DIR)) return [];
  return fs.readdirSync(APPS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(APPS_DIR, f), 'utf-8')); } catch { return null; } })
    .filter(Boolean);
}

function findApplicationByUrl(url) {
  const normalize = p => p.replace(/\/(apply|application)$/, '');
  try {
    for (const f of fs.readdirSync(APPS_DIR).filter(f => f.endsWith('.json'))) {
      const app = JSON.parse(fs.readFileSync(path.join(APPS_DIR, f), 'utf-8'));
      const urls = [app.url, ...(app.urls || [])].filter(Boolean);
      if (urls.some(u => {
        try {
          const appPath = normalize(new URL(u).pathname);
          const pagePath = normalize(new URL(url).pathname);
          return pagePath === appPath || pagePath.startsWith(appPath + '/');
        } catch { return false; }
      })) return app;
    }
  } catch {}
  return null;
}

async function callClaude(prompt, maxTokens = 4096, model = null) {
  if (!keys) throw new Error('No API key configured');
  if (keys.provider === 'openrouter') {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${keys.key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:3747' },
      body: JSON.stringify({ model: MODEL_OPENROUTER, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) throw new Error(`OpenRouter ${r.status}`);
    return (await r.json()).choices[0].message.content;
  } else {
    const useModel = model || MODEL_ANTHROPIC;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': keys.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: useModel, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}`);
    return (await r.json()).content[0].text;
  }
}

// Strip em dashes and en dashes from all string fields in a JSON object
function cleanEmDashes(obj) {
  if (typeof obj === 'string') {
    return obj
      .replace(/\s*—\s*/g, '. ')
      .replace(/\s*–\s*/g, ', ')
      .replace(/\.\s*\.\s*/g, '. ')
      .replace(/\.,/g, ',')
      .trim();
  }
  if (Array.isArray(obj)) return obj.map(cleanEmDashes);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = cleanEmDashes(v);
    return out;
  }
  return obj;
}

// Vision-capable call — content is a string or array of content blocks (text + image)
async function callClaudeVision(content, maxTokens = 2048) {
  if (!keys) throw new Error('No API key configured');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': keys.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, messages: [{ role: 'user', content }] }),
  });
  if (!r.ok) throw new Error(`Anthropic vision ${r.status}: ${await r.text()}`);
  return (await r.json()).content[0].text;
}

app.get('/health', (req, res) => {
  const count = fs.existsSync(APPS_DIR) ? fs.readdirSync(APPS_DIR).filter(f => f.endsWith('.json')).length : 0;
  res.json({ status: 'ok', applications: count, ai: !!keys, provider: keys?.provider });
});

// Lookup a previously generated application by job URL
app.get('/application', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url param required' });
  const app = findApplicationByUrl(url);
  if (app) return res.json(app);
  res.status(404).json({ error: 'No application found' });
});

app.get('/application/:id', (req, res) => {
  const p = path.join(APPS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
  try { res.json(JSON.parse(fs.readFileSync(p, 'utf-8'))); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/applications', (req, res) => {
  try {
    const apps = loadApps().map(({ id, company, role, url, tier, fit_score, sourced_date }) => ({
      id, company, role, url, tier, fit_score, sourced_date
    }));
    res.json(apps.sort((a, b) => (b.fit_score || 0) - (a.fit_score || 0)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AI field-mapping — accepts optional screenshot for visual form analysis
app.post('/analyze', requireCredits('analyze'), async (req, res) => {
  const { appId, kitId, fields, screenshot } = req.body;
  const id = appId || kitId;
  if (!id || !fields) return res.status(400).json({ error: 'appId and fields required' });
  if (!keys) return res.status(503).json({ error: 'No API key found' });

  let appData;
  const appPath = path.join(APPS_DIR, `${id}.json`);
  const legacyPath = path.join(__dirname, '../apply-kits', `${id}.json`);
  if (fs.existsSync(appPath)) appData = JSON.parse(fs.readFileSync(appPath, 'utf-8'));
  else if (fs.existsSync(legacyPath)) appData = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
  else return res.status(404).json({ error: 'Application not found' });

  const p = { ...PROFILE, ...appData.profile };
  const t = appData.tailored;
  const qaBlock = (t.qa || []).map((item, i) => `Q${i + 1}: ${item.q}\nA${i + 1}: ${item.a}`).join('\n\n');

  const prompt = `You are filling out a job application for ${appData.company} — ${appData.role}.

Candidate:
- Full name: ${p.first_name} ${p.last_name}
- Email: ${p.email}
- Phone: ${p.phone}
- LinkedIn: ${p.linkedin}
- GitHub: ${p.github}
- Twitter/X: ${p.twitter}
- Website / portfolio: ${p.website}
- Location: ${p.location}
- Current employer: ${p.current_employer}
- School: ${p.school}
- Work authorization: ${p.work_authorization}
- Salary: ${p.salary ? '$' + Number(p.salary).toLocaleString() : ''}

Cover note:
${t.cover_note}

Pre-written Q&A answers (fuzzy-match to open-ended questions by topic):
${qaBlock}

Form fields detected on this page:
${JSON.stringify(fields, null, 2)}

${screenshot ? 'A screenshot of the form is attached — use it to understand field context, labels, and layout.' : ''}

Return ONLY valid JSON — no markdown, no explanation:
{"mappings":[{"label":"<exact label>","type":"text|textarea|radio","value":"<value or empty string>"}]}

Rules:
- Any field with both "first" and "last" → full name "${p.first_name} ${p.last_name}"
- "First name" alone → "${p.first_name}" | "Last name" alone → "${p.last_name}"
- Work authorization radio → "Yes"
- Visa sponsorship radio → "No" / "do not require"
- Location/hybrid radio → remote / willing to relocate option
- Portfolio, work samples, website → ${p.website}
- Open-ended textareas → closest Q&A answer; fall back to cover note
- "Tell us about yourself" / bio → cover note
- Skip: file uploads, pronouns, unclear fields
- Every textarea with a question label MUST get an answer`;

  try {
    let raw;
    if (screenshot && keys.provider === 'anthropic') {
      // Vision mode — Claude sees the actual form
      const base64 = screenshot.replace(/^data:image\/\w+;base64,/, '');
      const mediaType = screenshot.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';
      raw = await callClaudeVision([
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: prompt },
      ], 2048);
      console.log('[analyze] used vision');
    } else {
      raw = await callClaude(prompt, 1024);
    }
    const json = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
    res.json(json);
  } catch (e) {
    console.error('AI analyze error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const SOURCED_FILE = path.join(__dirname, '../sourced-jobs.json');

app.get('/sourced', (req, res) => {
  try {
    const sourced = fs.existsSync(SOURCED_FILE) ? JSON.parse(fs.readFileSync(SOURCED_FILE, 'utf-8')) : [];
    let log = [];
    const logPath = path.join(__dirname, '../applied-log.json');
    try { log = JSON.parse(fs.readFileSync(logPath, 'utf-8')); } catch {}
    const appliedUrls = new Set(log.map(e => e.url));
    const merged = sourced.map(j => ({ ...j, status: appliedUrls.has(j.url) ? 'applied' : j.status }));
    res.json(merged);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/sourced/mark-reviewed', (req, res) => {
  const { ids } = req.body;
  if (!ids?.length) return res.status(400).json({ error: 'ids required' });
  try {
    const sourced = fs.existsSync(SOURCED_FILE) ? JSON.parse(fs.readFileSync(SOURCED_FILE, 'utf-8')) : [];
    const idSet = new Set(ids);
    const updated = sourced.map(j => idSet.has(j.id) && j.status === 'new' ? { ...j, status: 'reviewed' } : j);
    fs.writeFileSync(SOURCED_FILE, JSON.stringify(updated, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/sourced/skip', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const sourced = fs.existsSync(SOURCED_FILE) ? JSON.parse(fs.readFileSync(SOURCED_FILE, 'utf-8')) : [];
    fs.writeFileSync(SOURCED_FILE, JSON.stringify(sourced.map(j => j.id === id ? { ...j, status: 'skipped' } : j), null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/sourced/star', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const sourced = fs.existsSync(SOURCED_FILE) ? JSON.parse(fs.readFileSync(SOURCED_FILE, 'utf-8')) : [];
    const updated = sourced.map(j => j.id === id ? { ...j, starred: !j.starred } : j);
    fs.writeFileSync(SOURCED_FILE, JSON.stringify(updated, null, 2));
    const job = updated.find(j => j.id === id);
    res.json({ ok: true, starred: job?.starred ?? false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/sourced/mark-applied', (req, res) => {
  const { id, url } = req.body;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const sourced = fs.existsSync(SOURCED_FILE) ? JSON.parse(fs.readFileSync(SOURCED_FILE, 'utf-8')) : [];
    const updated = sourced.map(j => j.id === id ? { ...j, status: 'applied' } : j);
    fs.writeFileSync(SOURCED_FILE, JSON.stringify(updated, null, 2));
    const logPath = path.join(__dirname, '../applied-log.json');
    let log = [];
    try { log = JSON.parse(fs.readFileSync(logPath, 'utf-8')); } catch {}
    const job = updated.find(j => j.id === id);
    if (job && !log.find(e => e.appId === id)) {
      log.push({ appId: id, company: job.company, role: job.role, applied_at: new Date().toISOString().slice(0, 10), url: url || job.url });
      fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/applied', (req, res) => {
  const { appId, kitId, company, role, url } = req.body;
  const id = appId || kitId;
  if (!id) return res.status(400).json({ error: 'appId required' });

  const appliedAt = new Date().toISOString().slice(0, 10);

  // Update the application JSON
  const appPath = path.join(APPS_DIR, `${id}.json`);
  const legacyPath = path.join(__dirname, '../apply-kits', `${id}.json`);
  for (const p of [appPath, legacyPath]) {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      data.applied_at = appliedAt;
      fs.writeFileSync(p, JSON.stringify(data, null, 2));
      break;
    }
  }

  // Update sourced-jobs.json status
  if (url && fs.existsSync(SOURCED_FILE)) {
    try {
      const sourced = JSON.parse(fs.readFileSync(SOURCED_FILE, 'utf-8'));
      let changed = false;
      for (const j of sourced) {
        if (j.url === url && j.status !== 'applied') { j.status = 'applied'; changed = true; }
      }
      if (changed) fs.writeFileSync(SOURCED_FILE, JSON.stringify(sourced, null, 2));
    } catch {}
  }

  const logPath = path.join(__dirname, '../applied-log.json');
  let log = [];
  try { log = JSON.parse(fs.readFileSync(logPath, 'utf-8')); } catch {}
  if (!log.find(e => e.appId === id)) {
    log.push({ appId: id, company, role, applied_at: appliedAt, url });
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
  }

  console.log(`Applied: ${company} — ${role} (${appliedAt})`);
  res.json({ ok: true, applied_at: appliedAt });
});

app.get('/applied', (req, res) => {
  const logPath = path.join(__dirname, '../applied-log.json');
  try { res.json(JSON.parse(fs.readFileSync(logPath, 'utf-8'))); } catch { res.json([]); }
});

app.get('/status', (req, res) => {
  try {
    const sourced = JSON.parse(fs.readFileSync(SOURCED_FILE, 'utf-8'));
    const counts = { new: 0, reviewed: 0, applied: 0, skipped: 0 };
    for (const j of sourced) counts[j.status || 'new'] = (counts[j.status || 'new'] || 0) + 1;
    res.json({ ...counts, total: sourced.length });
  } catch { res.json({ new: 0, reviewed: 0, applied: 0, skipped: 0, total: 0 }); }
});

// Generate an application on demand from a job page
app.post('/generate', requireCredits('generate'), async (req, res) => {
  const { url, company, role, description, ats, force, form_questions } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!keys) return res.status(503).json({ error: 'No API key configured' });

  // Return cached application if it exists (unless force regenerate)
  if (!force) {
    const cached = findApplicationByUrl(url);
    if (cached) {
      console.log(`Cache hit: ${cached.company} — ${cached.role}`);
      return res.json(cached);
    }
  } else {
    // Delete any existing application for this URL so we regenerate fresh
    const existing = findApplicationByUrl(url);
    if (existing) {
      const p = path.join(APPS_DIR, `${existing.id}.json`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
      console.log(`Force regenerate: deleted ${existing.id}`);
    }
  }

  const qaInstruction = (form_questions && form_questions.length > 0)
    ? `QA INSTRUCTIONS — CRITICAL: The application form has these EXACT questions. Answer ONLY these questions using Chad's real background and numbers. Do not add any other questions.
${form_questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    : `QA INSTRUCTIONS: Generate 2-3 likely screening questions specific to this exact role and company. Do not use generic questions.`;

  const prompt = `Generate a job application for Chad Wittman applying to this role.

CHAD'S BACKGROUND:
- Serial founder with exits: EdgeRank Checker (250K brands, sold to Socialbakers), Dolly (500K users, $10M ARR, sold to IKEA via TaskRabbit), Krause House ($5M crowdfund in 15 min, first DAO sports team bid)
- Current: co-founder of ELDRICK, an AI golf fitting platform he built end-to-end — multi-stage recommendation engine, deterministic + probabilistic + expert-in-the-loop pipeline, fitted 12,000+ golfers
- Also built Relay's founding editorial, social, and collection management pipelines from scratch
- At Filmhub (a16z-backed, current day job): built an AI thumbnail pipeline that reversed declining YouTube performance and grew revenue 161% over 16 months. Meaningful execution at a small company.
- Superpowers: AI systems in production, growth and GTM, 0-to-1 product and company building, experimentation, cross-functional leadership, speed
- Video portfolio: https://youtu.be/lS140EUgOg4 — include this URL when referencing his AI or product work

JOB DETAILS:
Company: ${company || 'Unknown'}
Role: ${role || 'Unknown'}
URL: ${url}
ATS: ${ats}
Description:
${(description || '').slice(0, 3500)}

${qaInstruction}

Return ONLY valid JSON, no markdown, no explanation. Use this exact structure:
{
  "id": "<company-role-slug-lowercase-hyphens>",
  "company": "<company name>",
  "role": "<role title>",
  "url": "${url.replace(/\/(apply|application)$/, '')}",
  "ats": "${ats}",
  "fit_score": <6-9 based on how well it matches Chad>,
  "tier": <1 if fit_score 9, 2 if 7-8, 3 if 6>,
  "warm_path": "<how Chad might get a warm intro, or 'Cold apply' if none obvious>",
  "profile": {
    "first_name": "Chad",
    "last_name": "Wittman",
    "email": "wittman.c@gmail.com",
    "phone": "920-378-6761",
    "linkedin": "https://linkedin.com/in/chadwittman",
    "location": "Austin, TX",
    "work_authorization": "U.S. Citizen, no sponsorship needed",
    "salary": "<appropriate number as string, no $ or commas>",
    "website": "https://youtu.be/lS140EUgOg4",
    "current_employer": "ELDRICK",
    "github": "https://github.com/chadwittman",
    "twitter": "https://x.com/ChadWittman",
    "school": "University of Wisconsin (UWEC)"
  },
  "tailored": {
    "headline": "<one sentence, direct, specific to this role — lead with the most relevant angle from Chad's background, not a generic claim. No em dashes.>",
    "why_role": "<2-3 paragraphs. NEVER open with Filmhub or the thumbnail pipeline story. Pick the opener from his founder/exit history or ELDRICK's AI work, whichever maps most directly to what this role needs. Apply all WRITING RULES below.>",
    "cover_note": "<2 paragraphs. Who Chad is (founder, builder, exits) and what specifically draws him to this role and company. NEVER open with Filmhub. Apply all WRITING RULES below.>",
    "qa": [
      {"q": "<question per QA INSTRUCTIONS above>", "a": "<2-4 sentences. Specific evidence from Chad's actual work. Concrete numbers where they exist. Apply all WRITING RULES below.>"}
    ]
  }
}

WRITING RULES — apply to every word of why_role, cover_note, and qa answers:

Voice: Write like a confident, informal person typing quickly — not a cover letter template. Short sentences mixed with longer ones. Uneven paragraph lengths. "w/" is fine (use it). First-person but not self-congratulatory.

Banned words (never use): delve, foster, leverage, utilize, facilitate, empower, streamline, robust, cutting-edge, paradigm shift, game changer, tapestry, realm, beacon, multifaceted, meticulous, intricate, paramount, transformative, elevate, embark, supercharge, harness, ever-evolving, excited to, passionate about, I am thrilled, innovative, dynamic, synergy.

Banned patterns:
- Em dashes and en dashes — never, not once
- Binary contrasts: "It's not X. It's Y." — just say Y
- Throat-clearing openers: "Here's the thing", "Let me be clear", "I'll be honest" — cut them
- Faux-insight setups: "What most people miss", "Here's what nobody tells you" — cut the setup, make the claim
- Colon reveals: "The best part: it learns." — rewrite as a plain sentence
- Trailing -ing analysis: "highlighting the team's commitment", "underscoring its importance" — state the fact instead
- Importance puffery: "marks a pivotal moment", "plays a vital role", "stands as a testament" — state the fact
- Negative listing: "Not a X. Not a Y. A Z." — just say Z
- Dramatic fragmentation: "That's it. That's the whole thing." — use complete sentences
- Summary-recap endings: no "In conclusion", "Ultimately", "Overall" — end on the last concrete point
- Fake-profound kickers: no metaphor or mic-drop final line — end on the clearest concrete sentence

Concrete over abstract: "grew revenue 161% in 16 months" not "drove significant growth". Names, numbers, mechanisms beat adjectives. Use active voice. Verbs do the work — "decided" not "made a decision".`;

  try {
    const raw = await callClaude(prompt, 4096, 'claude-sonnet-4-6');
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
    if (!parsed.id) throw new Error('Invalid response: missing id');
    // Strip em/en dashes from all generated text — model sometimes ignores the prompt rule
    const generated = cleanEmDashes(parsed);

    // Save to applications/
    fs.writeFileSync(path.join(APPS_DIR, `${generated.id}.json`), JSON.stringify(generated, null, 2));

    // Mark sourced job as reviewed if it exists
    if (fs.existsSync(SOURCED_FILE)) {
      try {
        const sourced = JSON.parse(fs.readFileSync(SOURCED_FILE, 'utf-8'));
        let changed = false;
        const normalize = p => p.replace(/\/(apply|application)$/, '');
        for (const j of sourced) {
          try {
            const jPath = normalize(new URL(j.url).pathname);
            const uPath = normalize(new URL(url).pathname);
            if ((jPath === uPath || uPath.startsWith(jPath + '/')) && j.status === 'new') {
              j.status = 'reviewed';
              changed = true;
            }
          } catch {}
        }
        if (changed) fs.writeFileSync(SOURCED_FILE, JSON.stringify(sourced, null, 2));
      } catch {}
    }

    console.log(`Generated: ${generated.company} — ${generated.role}`);
    res.json(generated);
  } catch (e) {
    console.error('Generate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Generate a full cover letter
app.post('/cover-letter', requireCredits('cover_letter'), async (req, res) => {
  const { appId, kitId } = req.body;
  const id = appId || kitId;
  if (!id) return res.status(400).json({ error: 'appId required' });
  if (!keys) return res.status(503).json({ error: 'No API key' });

  const appPath = path.join(APPS_DIR, `${id}.json`);
  const legacyPath = path.join(__dirname, '../apply-kits', `${id}.json`);
  let appData;
  if (fs.existsSync(appPath)) appData = JSON.parse(fs.readFileSync(appPath, 'utf-8'));
  else if (fs.existsSync(legacyPath)) appData = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
  else return res.status(404).json({ error: 'Application not found' });

  const t = appData.tailored;
  const prompt = `Write a full cover letter for Chad Wittman applying to ${appData.role} at ${appData.company}.

His background context: ${t.why_role}

Seed themes (use as inspiration only, not as copy to paste): ${t.cover_note}

Structure:
- Opening (1-2 sentences): specific and concrete about this company or role. No generic opener.
- Middle (2 paragraphs): Chad's actual work mapped to what this role needs. Name the products, numbers, companies.
- Close (2-3 sentences): confident, direct. No "I look forward to hearing from you."
- Sign off: Chad Wittman

Length: 250-320 words total. No bullet points, lists, or headers. Rewrite from scratch — do not copy seed phrasing verbatim.

WRITING RULES — every violation is a failure:
Voice: Confident, informal person typing quickly. "w/" is fine. Short sentences mixed with longer ones. Uneven paragraph lengths. First-person but not self-congratulatory.
Banned words: delve, foster, leverage, utilize, facilitate, empower, streamline, robust, cutting-edge, paradigm shift, tapestry, realm, transformative, elevate, supercharge, harness, excited to, passionate about, thrilled, eager, I am writing to apply, synergy, impactful.
Banned patterns:
- ZERO em dashes or en dashes (— or –). Replace with a period or comma. Search output before returning.
- No "It's not X. It's Y." — just say Y
- No "Here's the thing", "Let me be clear" — cut and state the point
- No trailing -ing clauses: "highlighting", "underscoring", "showcasing" — state the fact
- No "marks a pivotal moment", "plays a vital role" — state the fact
- No "In conclusion", "Ultimately" — end on the last concrete point
- No metaphor or mic-drop final line — end on the clearest concrete sentence`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': keys.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
    });
    const data = await r.json();
    let text = data.content[0].text;
    // Hard strip em dashes — model sometimes ignores the prompt rule
    text = text.replace(/\s*—\s*/g, '. ').replace(/\.\s*\.\s*/g, '. ').trim();
    res.json({ text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Clean up voice transcript
app.post('/voice', requireCredits('voice'), async (req, res) => {
  const { transcript, question, appId, kitId } = req.body;
  if (!transcript) return res.status(400).json({ error: 'transcript required' });
  if (!keys) return res.status(503).json({ error: 'No API key' });

  const id = appId || kitId;
  const properNouns = [
    'Filmhub', 'ELDRICK', 'Relay', 'OpenClaw', 'Haley', 'Krause House',
    'Claude', 'Anthropic', 'Ashby', 'Greenhouse', 'Lever', 'ChatGPT', 'OpenAI',
    'Cursor', 'GitHub', 'Linear', 'Figma', 'Notion', 'Slack',
    'University of Wisconsin', 'UWEC', 'Chad Wittman',
  ];

  let kitContext = '';
  if (id) {
    const appPath = path.join(APPS_DIR, `${id}.json`);
    const legacyPath = path.join(__dirname, '../apply-kits', `${id}.json`);
    let appData;
    if (fs.existsSync(appPath)) appData = JSON.parse(fs.readFileSync(appPath, 'utf-8'));
    else if (fs.existsSync(legacyPath)) appData = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
    if (appData) {
      properNouns.push(appData.company, appData.role);
      const text = [appData.tailored?.cover_note, appData.tailored?.why_role, ...(appData.tailored?.qa || []).map(q => q.a)].filter(Boolean).join(' ');
      const extracted = [...new Set((text.match(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*/g) || []).filter(w => w.length > 2 && !['The','This','That','These','Those','When','What','Where','How','Why','Which','With','From','Then','Also','And','But','For'].includes(w)))];
      properNouns.push(...extracted);
      kitContext = `Company: ${appData.company}\nRole: ${appData.role}\n`;
      if (appData.tailored?.why_role) kitContext += `Context: ${appData.tailored.why_role.slice(0, 400)}\n`;
    }
  }

  const prompt = `You are editing a raw voice transcript into polished written copy for a job application.

${kitContext}${question ? `Question being answered: ${question}\n` : ''}Raw transcript: ${transcript}

Known proper nouns — if the transcript contains a word that sounds like one of these, correct it:
${[...new Set(properNouns)].join(', ')}

Editing rules:
- Break up ALL run-on sentences. If a sentence has multiple clauses joined by "and" or "so", split it into separate sentences.
- Remove filler words: um, uh, like, you know, sort of, kind of, I mean, basically, literally, right
- Fix grammar throughout
- Correct any proper noun that sounds phonetically similar to the list above
- Keep every idea — do not drop substance, do not add new content
- No em dashes. Use periods and short sentences.
- No AI writing patterns: no "I am passionate", no "I am excited to", no lists of three
- Varied sentence rhythm — short punchy sentences mixed with longer ones
- Write how a direct, confident person writes, not how they talk
- Return only the cleaned text, no preamble`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': keys.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}`);
    const text = (await r.json()).content[0].text.trim();
    res.json({ text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function syncHistoryStatuses() {
  const historyDb = path.join(process.env.HOME, 'Library/Application Support/Google/Chrome/Default/History');
  const tmpDb = '/tmp/jaa-history.db';
  try {
    fs.copyFileSync(historyDb, tmpDb);
    const { execSync } = require('child_process');
    const rows = execSync(`sqlite3 "${tmpDb}" "SELECT url FROM urls"`, { encoding: 'utf-8' }).split('\n').filter(Boolean);
    const historySet = new Set(rows);

    const jobs = JSON.parse(fs.readFileSync(SOURCED_FILE, 'utf-8'));
    let changed = 0;
    for (const job of jobs) {
      if (job.status === 'applied') continue;
      const company = job.company.toLowerCase().replace(/[^a-z0-9]/g, '');
      const wasApplied = rows.some(u => u.includes('confirmation') && (u.includes(company.slice(0, 6)) || u.includes(job.url.split('/').slice(-1)[0])));
      if (wasApplied) { job.status = 'applied'; changed++; continue; }
      if (job.status !== 'reviewed' && historySet.has(job.url)) { job.status = 'reviewed'; changed++; }
    }
    if (changed) fs.writeFileSync(SOURCED_FILE, JSON.stringify(jobs, null, 2));
    if (changed) console.log(`[history sync] ${changed} job statuses updated`);
  } catch {}
}

// Clear all job data
app.post('/clear', (req, res) => {
  try {
    fs.writeFileSync(SOURCED_FILE, '[]');
    fs.writeFileSync(path.join(__dirname, '../applied-log.json'), '[]');
    for (const dir of [APPS_DIR, path.join(__dirname, '../apply-kits')]) {
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
          fs.unlinkSync(path.join(dir, f));
        }
      }
    }
    console.log('[clear] all job data wiped');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Schedule ──────────────────────────────────────────────────────────────────

const SCHEDULE_FILE = path.join(__dirname, '../logs/schedule.json');

function loadSchedule() {
  try { return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf-8')); }
  catch { return { hour: 8, minute: 0, enabled: false }; }
}

function saveScheduleFile(s) {
  if (!fs.existsSync(path.join(__dirname, '../logs'))) fs.mkdirSync(path.join(__dirname, '../logs'), { recursive: true });
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(s, null, 2));
}

let cronTask = null;

function startCron() {
  if (cronTask) { cronTask.stop(); cronTask = null; }
  const s = loadSchedule();
  if (!s.enabled) return;
  cronTask = cron.schedule(`${s.minute} ${s.hour} * * *`, () => {
    console.log('[cron] running scheduled source');
    if (sourcingPid) return;
    const { spawn } = require('child_process');
    if (!fs.existsSync(path.join(__dirname, '../logs'))) fs.mkdirSync(path.join(__dirname, '../logs'), { recursive: true });
    const logStream = fs.createWriteStream(SOURCE_LOG_FILE, { flags: 'w' });
    const sourceScript = path.join(__dirname, '../source.js');
    const child = spawn('node', [sourceScript], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    sourcingPid = child.pid;
    child.unref();
    child.on('exit', () => { sourcingPid = null; logStream.end(); console.log('[cron] source complete'); });
  }, { timezone: 'America/Chicago' });
  console.log(`[cron] scheduled daily at ${String(s.hour).padStart(2,'0')}:${String(s.minute).padStart(2,'0')} CT`);
}

app.get('/schedule', (req, res) => res.json(loadSchedule()));

app.post('/schedule', (req, res) => {
  const { hour, minute, enabled } = req.body;
  const s = { hour: hour ?? 8, minute: minute ?? 0, enabled: enabled ?? true };
  saveScheduleFile(s);
  startCron();
  res.json({ ok: true, schedule: s });
});

// Source new jobs on demand
let sourcingPid = null;

app.get('/source/status', (req, res) => {
  try {
    const jobs = JSON.parse(fs.readFileSync(SOURCED_FILE, 'utf-8'));
    const dates = jobs.map(j => j.sourced_date).filter(Boolean).sort().reverse();
    const counts = { new: 0, reviewed: 0, applied: 0, skipped: 0 };
    for (const j of jobs) counts[j.status || 'new'] = (counts[j.status || 'new'] || 0) + 1;
    res.json({ active: !!sourcingPid, last_sourced: dates[0] || null, counts, total: jobs.length });
  } catch {
    res.json({ active: !!sourcingPid, last_sourced: null, counts: {}, total: 0 });
  }
});

const SOURCE_LOG_FILE = path.join(__dirname, '../logs/last-run.log');

app.post('/source/run', requireCredits('source_run'), (req, res) => {
  if (sourcingPid) return res.json({ status: 'already_running' });
  const { spawn } = require('child_process');
  if (!fs.existsSync(path.join(__dirname, '../logs'))) fs.mkdirSync(path.join(__dirname, '../logs'), { recursive: true });
  const logStream = fs.createWriteStream(SOURCE_LOG_FILE, { flags: 'w' });
  const sourceScript = path.join(__dirname, '../source.js');
  const child = spawn('node', [sourceScript], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  sourcingPid = child.pid;
  child.unref();
  child.on('exit', () => { sourcingPid = null; logStream.end(); console.log('[source] run complete'); });
  console.log(`[source] started pid ${child.pid}`);
  res.json({ status: 'started', pid: child.pid });
});

app.get('/source/log', (req, res) => {
  try {
    const text = fs.existsSync(SOURCE_LOG_FILE) ? fs.readFileSync(SOURCE_LOG_FILE, 'utf-8') : '(no log yet)';
    res.type('text/plain').send(text);
  } catch { res.status(500).send('error reading log'); }
});

// ── Sourcing audit page ───────────────────────────────────────────────────────

app.get('/audit', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const detailFile = path.join(__dirname, '../logs/last-run-detail.json');
  const FEEDBACK_FILE_LOCAL = path.join(__dirname, '../logs/audit-feedback.json');
  const HEALTH_FILE = path.join(__dirname, '../logs/source-health.json');
  let data = null, feedback = [], healthData = [];
  try { data = fs.existsSync(detailFile) ? JSON.parse(fs.readFileSync(detailFile, 'utf-8')) : null; } catch {}
  try { feedback = fs.existsSync(FEEDBACK_FILE_LOCAL) ? JSON.parse(fs.readFileSync(FEEDBACK_FILE_LOCAL, 'utf-8')) : []; } catch {}
  try { healthData = fs.existsSync(HEALTH_FILE) ? JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf-8')) : []; } catch {}

  const fbMap = Object.fromEntries((feedback || []).map(f => [f.url, f]));

  // Group health by source, get last 4 entries per source
  const healthBySrc = {};
  for (const h of healthData) { (healthBySrc[h.source] = healthBySrc[h.source] || []).push(h); }

  const sym = o => ({ added:'+', dupe:'·', low_fit:'·', cross_dupe:'·', role_mismatch:'·', excluded:'–', url_dead:'✕', candidate:'·', unknown:'·' }[o] || '·');
  const symCls = o => ({ added:'s-add', excluded:'s-exc', url_dead:'s-dead' }[o] || 's-mute');

  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  const fbHtmlFor = (j) => {
    const fb = fbMap[j.url];
    if (fb) {
      const label = fb.feedback === 'correct' ? '✓' : fb.feedback === 'should_include' ? '+ miss' : '− wrong';
      const cls = fb.feedback === 'correct' ? 'fb-ok' : fb.feedback === 'should_include' ? 'fb-miss' : 'fb-wrong';
      return `<span class="fb-done ${cls}" title="${esc(fb.note||'')}">${label}</span>`;
    }
    const eu = encodeURIComponent(j.url);
    const ec = encodeURIComponent(j.company || '');
    const er = encodeURIComponent(j.role || '');
    return `<span class="fb-btns">
      <button class="fb-b fb-b-ok" onclick="doFb(this,'correct','${eu}','${ec}','${er}','${j.outcome}')">✓</button>
      <button class="fb-b fb-b-miss" onclick="doFb(this,'should_include','${eu}','${ec}','${er}','${j.outcome}')">+ miss</button>
      <button class="fb-b fb-b-bad" onclick="doFb(this,'should_exclude','${eu}','${ec}','${er}','${j.outcome}')">− wrong</button>
    </span>`;
  };

  const alertBanners = [];
  const sourcesHtml = !data?.sources?.length
    ? '<p class="empty">No run data yet — hit run sourcing.</p>'
    : data.sources.map(src => {
        const nAdded = (src.jobs||[]).filter(j=>j.outcome==='added').length;
        const meta = src.jobs?.length
          ? `${src.rawCount!=null ? src.rawCount+' scanned, ' : ''}${src.jobs.length} extracted, ${nAdded} added`
          : '0 found';

        // Health history: last 4 runs (excluding current run already in detail)
        const hist = (healthBySrc[src.name] || []).slice(-4);
        const histHtml = hist.length >= 2
          ? `<span class="src-hist">${hist.map(h => `<span title="${h.date}: ${h.found} found, ${h.added} added" class="hist-dot ${h.found===0?'hdot-zero':h.added>0?'hdot-ok':'hdot-meh'}">${h.added > 0 ? h.added : h.found > 0 ? '·' : '○'}</span>`).join('')}</span>`
          : '';

        // Loud failure: 3+ prior runs all zero
        if (hist.length >= 3 && hist.slice(-3).every(h => h.found === 0)) {
          alertBanners.push(`<div class="alert-banner">⚠ ${esc(src.name)} has returned 0 results for the last ${hist.slice(-3).length} runs — may be broken</div>`);
        }

        const rows = (src.jobs||[]).map(j => {
          const detail = j.reason || j.location || '';
          return `<div class="job-row">
            <span class="sym ${symCls(j.outcome)}">${sym(j.outcome)}</span>
            <span class="job-main"><a href="${esc(j.url)}" target="_blank" class="job-link">${esc(j.company||'')} — ${esc(j.role||'')}</a>${detail ? `<span class="job-detail">${esc(detail.slice(0,90))}</span>` : ''}</span>
            <span class="job-fb">${fbHtmlFor(j)}</span>
          </div>`;
        }).join('');
        return `<div class="src">
          <div class="src-head"><span class="src-name">${esc(src.name)}</span><span class="src-meta">${meta}</span>${histHtml}</div>
          ${rows || '<div class="job-row"><span class="sym s-mute">·</span><span class="job-main" style="color:#333">nothing extracted</span></div>'}
        </div>`;
      }).join('');

  const allJobs = (data?.sources||[]).flatMap(s=>s.jobs||[]);
  const c = {};
  for (const j of allJobs) c[j.outcome]=(c[j.outcome]||0)+1;
  const nAdded = c.added||0;
  const nFiltered = (c.dupe||0)+(c.cross_dupe||0)+(c.role_mismatch||0)+(c.low_fit||0);
  const nExc = (c.excluded||0)+(c.url_dead||0);
  const runMeta = data ? `${data.date} · ${nAdded} added, ${nFiltered} filtered, ${nExc} excluded` : 'no run yet';

  const sched = loadSchedule();
  const schedText = sched.enabled
    ? `auto ${String(sched.hour).padStart(2,'0')}:${String(sched.minute).padStart(2,'0')} CT`
    : 'no schedule';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>source & audit</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#ccc;font-size:13px;min-height:100vh}
.topbar{display:flex;align-items:center;gap:12px;padding:14px 24px;border-bottom:1px solid #181818}
.topbar-title{font-size:13px;font-weight:600;color:#fff;margin-right:4px}
.topbar-meta{font-size:11px;color:#444;flex:1}
.topbar-sched{font-size:11px;color:#2a2a2a}
.run-btn{padding:5px 12px;background:none;color:#555;border:1px solid #2a2a2a;border-radius:4px;font-size:11px;cursor:pointer}
.run-btn:hover{color:#ccc;border-color:#444}
.run-btn:disabled{opacity:.35;cursor:default}
.sdot{width:6px;height:6px;border-radius:50%;background:#2a2a2a;flex-shrink:0}
.sdot.active{background:#f59e0b;animation:pulse 1.4s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.alert-banner{margin:0 24px;margin-top:12px;padding:8px 12px;background:#1a0a0a;border:1px solid #3a1a1a;border-radius:4px;font-size:11px;color:#b45309}
.body{padding:24px 24px 32px;display:flex;flex-direction:column;gap:28px}
.src-head{display:flex;align-items:baseline;gap:10px;margin-bottom:6px}
.src-name{font-size:12px;font-weight:600;color:#888}
.src-meta{font-size:11px;color:#333}
.src-hist{display:flex;gap:3px;align-items:center;margin-left:4px}
.hist-dot{font-size:10px;width:14px;text-align:center;cursor:default}
.hdot-ok{color:#4ade80}
.hdot-meh{color:#555}
.hdot-zero{color:#2a2a2a}
.job-row{display:flex;align-items:baseline;gap:8px;padding:3px 0;line-height:1.4}
.sym{font-size:11px;width:12px;flex-shrink:0;text-align:center}
.s-add{color:#4ade80}
.s-exc{color:#555}
.s-dead{color:#444}
.s-mute{color:#2a2a2a}
.job-main{flex:1;min-width:0}
.job-link{color:#ccc;text-decoration:none;font-size:12px}
.job-link:hover{color:#fff;text-decoration:underline}
.job-detail{font-size:11px;color:#3a3a3a;margin-left:8px}
.job-fb{flex-shrink:0}
.fb-btns{display:flex;gap:6px}
.fb-b{background:none;border:none;font-size:10px;cursor:pointer;padding:0;opacity:.25}
.fb-b:hover{opacity:1}
.fb-b-ok{color:#4ade80}
.fb-b-miss{color:#f59e0b}
.fb-b-bad{color:#ef4444}
.fb-done{font-size:10px;color:#333}
.fb-ok{color:#4ade80}
.fb-miss{color:#f59e0b}
.fb-wrong{color:#7f1d1d}
.empty{padding:40px 0;color:#333;font-size:12px}
.missed-section{border-top:1px solid #181818;padding-top:24px;margin-top:4px}
.missed-label{font-size:11px;color:#444;margin-bottom:8px}
.missed-row{display:flex;gap:8px}
.missed-input{flex:1;background:#111;border:1px solid #222;border-radius:4px;color:#aaa;font-size:12px;padding:6px 10px;outline:none}
.missed-input:focus{border-color:#333}
.missed-btn{padding:6px 12px;background:none;color:#555;border:1px solid #2a2a2a;border-radius:4px;font-size:11px;cursor:pointer}
.missed-btn:hover{color:#ccc;border-color:#444}
#log-panel{display:none;padding:12px 24px 0}
#log-panel pre{font-family:"SF Mono",Menlo,monospace;font-size:11px;line-height:1.6;background:#080808;border:1px solid #181818;border-radius:6px;padding:14px;white-space:pre-wrap;color:#555;max-height:320px;overflow-y:auto}
</style>
</head>
<body>
<div class="topbar">
  <span class="sdot" id="sdot"></span>
  <span class="topbar-title">source & audit</span>
  <span class="topbar-meta" id="topbar-meta">${runMeta}</span>
  <span class="topbar-sched" id="sched-label">${schedText}</span>
  <button class="run-btn" id="run-btn" onclick="runSourcing()">run sourcing</button>
</div>
${alertBanners.join('\n')}
<div id="log-panel"><pre id="log-pre"></pre></div>
<div class="body">
${sourcesHtml}
<div class="missed-section">
  <div class="missed-label">paste a URL you found manually that was missed:</div>
  <div class="missed-row">
    <input id="missed-url" class="missed-input" type="url" placeholder="https://jobs.ashbyhq.com/…" />
    <button class="missed-btn" onclick="submitMissed()">add</button>
  </div>
  <div id="missed-status" style="font-size:11px;color:#444;margin-top:6px"></div>
</div>
</div>
<script>
const BASE='http://localhost:3747';
let polling=null;

async function runSourcing(){
  const btn=document.getElementById('run-btn');
  btn.disabled=true; btn.textContent='starting…';
  try{
    const d=await fetch(BASE+'/source/run',{method:'POST'}).then(r=>r.json());
    if(d.status==='already_running'){btn.textContent='already running';setTimeout(()=>{btn.disabled=false;btn.textContent='run sourcing';},2000);}
    else startPolling();
  }catch{btn.disabled=false;btn.textContent='run sourcing';}
}

function startPolling(){
  if(polling)return;
  document.getElementById('log-panel').style.display='';
  document.getElementById('sdot').className='sdot active';
  document.getElementById('topbar-meta').textContent='sourcing in progress…';
  const btn=document.getElementById('run-btn');
  btn.disabled=true; btn.textContent='running…';
  polling=setInterval(tick,2000); tick();
}

async function tick(){
  try{
    const[sr,lr]=await Promise.all([fetch(BASE+'/source/status'),fetch(BASE+'/source/log')]);
    const st=await sr.json();
    const log=lr.ok?await lr.text():'';
    const pre=document.getElementById('log-pre');
    if(log){pre.textContent=log;pre.scrollTop=pre.scrollHeight;}
    if(!st.active){
      clearInterval(polling);polling=null;
      document.getElementById('sdot').className='sdot';
      document.getElementById('topbar-meta').textContent='done — reloading…';
      setTimeout(()=>location.reload(),1500);
    }
  }catch{}
}

async function doFb(btn, feedback, url, co, role, outcome){
  const u=decodeURIComponent(url);
  const c=decodeURIComponent(co);
  const r=decodeURIComponent(role);
  await fetch(BASE+'/audit/feedback',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({url:u,company:c,role:r,outcome_was:outcome,feedback,note:''})});
  const container=btn.closest('.job-fb');
  const label=feedback==='correct'?'✓':feedback==='should_include'?'+ miss':'− wrong';
  const cls=feedback==='correct'?'fb-ok':feedback==='should_include'?'fb-miss':'fb-wrong';
  container.innerHTML='<span class="fb-done '+cls+'">'+label+'</span>';
}

async function submitMissed(){
  const input=document.getElementById('missed-url');
  const status=document.getElementById('missed-status');
  const url=input.value.trim();
  if(!url){status.textContent='paste a URL first';return;}
  status.textContent='adding…';
  try{
    const d=await fetch(BASE+'/audit/missed',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})}).then(r=>r.json());
    if(d.status==='already_exists'){status.textContent='already in the pipeline';}
    else{status.textContent='added'+(d.company?' ('+d.company+')':'');input.value='';}
  }catch{status.textContent='error — check server';}
}
</script>
</body>
</html>`);
});

app.get('/audit/data', (req, res) => {
  const detailFile = path.join(__dirname, '../logs/last-run-detail.json');
  try {
    res.json(fs.existsSync(detailFile) ? JSON.parse(fs.readFileSync(detailFile, 'utf-8')) : null);
  } catch { res.status(500).json({ error: 'read error' }); }
});

const FEEDBACK_FILE = path.join(__dirname, '../logs/audit-feedback.json');

app.get('/audit/feedback', (req, res) => {
  try { res.json(fs.existsSync(FEEDBACK_FILE) ? JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf-8')) : []); }
  catch { res.json([]); }
});

app.post('/audit/feedback', (req, res) => {
  const { url, company, role, outcome_was, feedback, note } = req.body;
  if (!url || !feedback) return res.status(400).json({ error: 'url and feedback required' });
  try {
    let log = [];
    try { log = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf-8')); } catch {}
    const idx = log.findIndex(f => f.url === url);
    const entry = { url, company, role, outcome_was, feedback, note: note || '', date: new Date().toISOString().slice(0, 10) };
    if (idx >= 0) log[idx] = entry; else log.push(entry);
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(log, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/audit/missed', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const sourced = fs.existsSync(SOURCED_FILE) ? JSON.parse(fs.readFileSync(SOURCED_FILE, 'utf-8')) : [];
    if (sourced.some(j => j.url === url)) return res.json({ ok: true, status: 'already_exists' });
    let company = '';
    try {
      const u = new URL(url);
      if (u.hostname.includes('ashbyhq.com')) company = url.match(/ashbyhq\.com\/([^/]+)/)?.[1] || '';
      else if (u.hostname.includes('lever.co')) company = url.match(/lever\.co\/([^/]+)/)?.[1] || '';
      else if (u.hostname.includes('greenhouse.io')) company = url.match(/greenhouse\.io\/([^/]+)/)?.[1] || '';
      else company = u.hostname.replace(/^www\./, '').split('.')[0];
    } catch {}
    const today = new Date().toISOString().slice(0, 10);
    const id = `manual-${today}-${Math.random().toString(36).slice(2, 6)}`;
    sourced.push({ id, company, role: 'Unknown', url, ats: 'other', fit_score: 7, tier: 2, location: 'Remote', notes: 'added manually via audit', sourced_date: today, status: 'new', manually_added: true });
    fs.writeFileSync(SOURCED_FILE, JSON.stringify(sourced, null, 2));
    const missedFile = path.join(__dirname, '../logs/missed-jobs.json');
    let missed = [];
    try { missed = JSON.parse(fs.readFileSync(missedFile, 'utf-8')); } catch {}
    missed.push({ url, company, date: today });
    fs.writeFileSync(missedFile, JSON.stringify(missed, null, 2));
    res.json({ ok: true, id, company });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`\nJob Apply Server — http://localhost:${PORT}`);
  const count = fs.existsSync(APPS_DIR) ? fs.readdirSync(APPS_DIR).filter(f => f.endsWith('.json')).length : 0;
  console.log(`${count} applications loaded`);
  console.log(`AI: ${keys ? `enabled via ${keys.provider} (haiku)` : 'disabled — no API key found'}\n`);
  syncHistoryStatuses();
  setInterval(syncHistoryStatuses, 6 * 60 * 60 * 1000);
  startCron();
});
