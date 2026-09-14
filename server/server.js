const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { getProfile, getProfileByUserEmail, setProfile, getUser, getOrCreateUser, addUserCredits, deductUserCredits, createMagicLink, getMagicLink, useMagicLink } = require('./db');
const db = require('./db');

process.on('unhandledRejection', (reason, promise) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  // don't exit — log and keep running
});

const app = express();
const PORT = process.env.PORT || 5000;
const VERSION = '0.2.1';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const APP_ORIGIN = process.env.APP_ORIGIN || 'http://localhost:5000';
const ALLOWED_WEB_ORIGINS = new Set(
  (process.env.CORS_ORIGINS || APP_ORIGIN)
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
);
const APPS_DIR = path.join(__dirname, '../applications');
fs.mkdirSync(APPS_DIR, { recursive: true });

if (IS_PRODUCTION && !process.env.APPLYAPPLY_JWT_SECRET) {
  throw new Error('APPLYAPPLY_JWT_SECRET must be set in production');
}
if (IS_PRODUCTION && !process.env.STRIPE_WEBHOOK_SECRET) {
  throw new Error('STRIPE_WEBHOOK_SECRET must be set in production');
}
if (IS_PRODUCTION && !process.env.ANTHROPIC_API_KEY && !process.env.OPENROUTER_API_KEY) {
  throw new Error('ANTHROPIC_API_KEY or OPENROUTER_API_KEY must be set in production');
}
if (IS_PRODUCTION && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set in production');
}
if (IS_PRODUCTION && !process.env.STRIPE_PRICE_ID) {
  throw new Error('STRIPE_PRICE_ID must be set in production');
}

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=()');
  if (IS_PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(cors({
  origin(origin, callback) {
    // Chrome extension requests have chrome-extension:// origins. The extension
    // itself is installed by the user and requires host permission for this API.
    if (!origin || origin.startsWith('chrome-extension://') || ALLOWED_WEB_ORIGINS.has(origin)) return callback(null, true);
    return callback(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-API-Key'],
}));
// Capture raw body for Stripe webhook signature verification
app.use(express.json({ limit: '1mb',
  verify: (req, res, buf) => { req.rawBody = buf; },
}));

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 5,                    // 5 magic link requests per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts — try again in 15 minutes' },
  skip: (req) => isLocalRequest(req),
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,       // 1 min
  max: 60,                   // 60 API calls per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded' },
  skip: (req) => isLocalRequest(req),
});

// ── Credits ───────────────────────────────────────────────────────────────────

const CREDITS_FILE = path.join(__dirname, '../data/credits.json');
fs.mkdirSync(path.join(__dirname, '../data'), { recursive: true });

const PRESET_ROLES = [
  'Head of Product','VP of Product','Director of Product',
  'Head of Growth','VP of Growth','Director of Growth',
  'Founding PM','Founding Product Lead',
  'Senior Product Manager','Product Manager',
  'Growth PM','GTM Lead',
];

const CREDIT_COSTS = {
  generate: 10,
  cover_letter: 8,
  analyze: 3,
  voice: 2,
};

// Credit pricing = (HB share + Claude cost + audit share) × 1.20 / $0.01, rounded up.
// Claude: Haiku $0.80/MTok in $4/MTok out · Sonnet $3/MTok in $15/MTok out.
// HB_CENTS_PER_RUN: conservative high estimate until we verify actual dashboard billing.
// Lower it once we have 10+ real runs of data. Names must match source.js exactly.
const HB_CENTS_PER_RUN = 50; // ← update from HB dashboard after first real runs

function calcSourceCredits(hbShareCents, claudeCents, auditCents = 1) {
  return Math.ceil((hbShareCents + claudeCents + auditCents) * 1.2 / 1 /* 1cr = $0.01 */);
}

// HB time shares (out of HB_CENTS_PER_RUN): a16z~8%, Sequoia~30%, each Google~10%
const _h = HB_CENTS_PER_RUN;
const SOURCE_CATALOG = [
  // a16z: API mode, no Claude. HB ~8% of session.
  { name: 'a16z job board',          credits: calcSourceCredits(_h*0.08, 0),   on: true,  desc: 'a16z portfolio — API scrape, no Claude',                type: 'api' },
  // Sequoia: API mode, same platform as a16z. HB ~8% of session.
  { name: 'Sequoia job board',        credits: calcSourceCredits(_h*0.08, 0),   on: true,  desc: 'Sequoia portfolio — API scrape, no Claude',              type: 'api' },
  // Google+Haiku: ~3k in/500 out = $0.005. HB ~10% each.
  { name: 'YC / Work at a Startup',   credits: calcSourceCredits(_h*0.10, 0.5), on: true,  desc: 'YC companies — Google search + Haiku extract',          type: 'google' },
  { name: 'Wellfound',                credits: calcSourceCredits(_h*0.10, 0.5), on: true,  desc: 'Wellfound startup jobs — Google search + Haiku extract', type: 'google' },
  { name: 'Builtin remote product',   credits: calcSourceCredits(_h*0.10, 0.5), on: true,  desc: 'Builtin.com — Google search + Haiku extract',           type: 'google' },
  { name: 'Ashby jobs (Google)',      credits: calcSourceCredits(_h*0.10, 0.5), on: true,  desc: 'Ashby ATS boards — Google search + Haiku extract',      type: 'google' },
  { name: 'Lever jobs (Google)',      credits: calcSourceCredits(_h*0.10, 0.5), on: true,  desc: 'Lever ATS boards — Google search + Haiku extract',      type: 'google' },
  { name: 'Greenhouse jobs (Google)', credits: calcSourceCredits(_h*0.10, 0.5), on: true,  desc: 'Greenhouse ATS — Google search + Haiku extract',        type: 'google' },
];

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(CREDITS_FILE, 'utf-8')); } catch { return {}; }
}

function saveUsers(u) {
  fs.writeFileSync(CREDITS_FILE, JSON.stringify(u, null, 2));
}

function isLocalRequest(req) {
  if (IS_PRODUCTION || process.env.ALLOW_LOCAL_BYPASS !== 'true') return false;
  const ip = req.ip || req.connection.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// ── JWT ───────────────────────────────────────────────────────────────────────

function loadJwtSecret() {
  return process.env.APPLYAPPLY_JWT_SECRET || 'development-only-secret';
}

function signSession(email) {
  return jwt.sign({ email }, loadJwtSecret(), { expiresIn: '30d' });
}

function verifySession(token) {
  try { return jwt.verify(token, loadJwtSecret()); } catch { return null; }
}

// ── Email (Resend) ────────────────────────────────────────────────────────────

function loadResendKey() {
  return process.env.RESEND_API_KEY || null;
}

async function sendEmail(to, subject, html, text) {
  const resendKey = loadResendKey();
  if (!resendKey) { console.log(`[email] ${to} — ${subject}`); return; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'applyapply <noreply@applyapply.xyz>', to: [to], subject, html, text }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Resend ${r.status}: ${body.slice(0, 300)}`);
  }
}

async function sendMagicLinkEmail(email, link) {
  const resendKey = loadResendKey();
  if (!resendKey) {
    console.log(`\n[magic link] ${email}\n${link}\n`);
    return;
  }
  await sendEmail(email, 'Sign in to applyapply',
    `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:40px auto;padding:32px;background:#fff;border:1px solid #e5e5e5;border-radius:8px">
      <h2 style="font-size:18px;font-weight:700;margin-bottom:8px">Sign in to applyapply</h2>
      <p style="color:#555;font-size:14px;margin-bottom:24px">Click the button below to sign in. This link expires in 15 minutes and can only be used once.</p>
      <a href="${link}" style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:11px 22px;border-radius:6px;font-size:14px;font-weight:600">Sign in</a>
      <p style="color:#aaa;font-size:12px;margin-top:24px">If you didn't request this, you can ignore it.</p>
    </div>`,
    `Sign in to applyapply: ${link}`
  );
}

// ── requireCredits — accepts JWT session OR legacy api key ────────────────────

function requireCredits(action) {
  return async (req, res, next) => {
    const cost = CREDIT_COSTS[action] || 0;

    // JWT session (magic link auth)
    const bearer = req.headers['authorization']?.match(/^Bearer (.+)/)?.[1]
      || (req.headers['x-api-key']?.startsWith('eyJ') ? req.headers['x-api-key'] : null);
    if (bearer) {
      const payload = verifySession(bearer);
      if (!payload) return res.status(401).json({ error: 'Session expired — sign in again' });
      const user = await getUser(payload.email);
      if (!user) return res.status(401).json({ error: 'Account not found' });
      if (user.credits < cost) return res.status(402).json({ error: 'Insufficient credits', balance: user.credits, required: cost });
      if (cost > 0) {
        const updated = await deductUserCredits(payload.email, cost);
        if (!updated) return res.status(402).json({ error: 'Insufficient credits', balance: user.credits, required: cost });
        // Reserve credits before expensive AI work to prevent concurrent requests
        // from overspending. If the handler fails, return the reservation.
        let refunded = false;
        res.on('finish', () => {
          if (res.statusCode < 400 || refunded) return;
          refunded = true;
          addUserCredits(payload.email, cost)
            .catch(error => console.error(`[credits] refund failed for ${payload.email}:`, error.message));
        });
      }
      req.userEmail = payload.email;
      return next();
    }

    // Legacy API key
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const users = loadUsers();
      const user = users[apiKey];
      if (!user) return res.status(401).json({ error: 'Invalid API key' });
      if (user.balance < cost) return res.status(402).json({ error: 'Insufficient credits', balance: user.balance, required: cost });
      user.balance -= cost;
      user.last_used = new Date().toISOString().slice(0, 10);
      saveUsers(users);
      req.apiKey = apiKey;
      req.creditUser = user;
      return next();
    }

    // Local bypass
    if (isLocalRequest(req)) return next();
    res.status(401).json({ error: 'Sign in required' });
  };
}

function loadAdminSecret() {
  return process.env.APPLYAPPLY_ADMIN_SECRET || null;
}

function requireAdmin(req, res, next) {
  const secret = loadAdminSecret();
  if (!secret) return res.status(503).json({ error: 'Admin not configured' });
  if (req.headers['x-admin-secret'] !== secret) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ── Landing page ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>applyapply</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#000;color:#fff;line-height:1.5;-webkit-font-smoothing:antialiased}
a{text-decoration:none;color:inherit}
.nav{display:flex;justify-content:space-between;align-items:center;padding:20px 32px;border-bottom:1px solid #111}
.nav-logo{font-size:13px;font-weight:700;letter-spacing:-.02em}
.nav-right{display:flex;gap:20px;align-items:center}
.nav-link{font-size:13px;color:#aaa}
.nav-link:hover{color:#fff}
.nav-cta{font-size:13px;color:#fff;font-weight:500}
.hero{max-width:600px;margin:0 auto;padding:100px 32px 84px}
.hero h1{font-size:clamp(40px,7vw,64px);font-weight:700;line-height:1.05;letter-spacing:-.05em;margin-bottom:22px}
.hero p{font-size:18px;color:#ccc;line-height:1.7;margin-bottom:16px;max-width:500px}
.hero p+p{margin-bottom:36px}
.ctas{display:flex;gap:10px;flex-wrap:wrap}
.btn-w{display:inline-block;padding:12px 22px;background:#fff;color:#000;font-size:14px;font-weight:600;border:none;cursor:pointer;letter-spacing:-.01em}
.btn-w:hover{background:#e5e5e5}
.btn-g{display:inline-block;padding:12px 22px;background:transparent;color:#aaa;font-size:14px;font-weight:500;border:1px solid #333;cursor:pointer}
.btn-g:hover{border-color:#777;color:#fff}
hr{border:none;border-top:1px solid #111}
.section{max-width:600px;margin:0 auto;padding:72px 32px}
.eyebrow{font-size:11px;color:#888;letter-spacing:.06em;text-transform:uppercase;margin-bottom:32px}
.body-l{font-size:17px;color:#ccc;line-height:1.75;max-width:520px}
.body-l+.body-l{margin-top:16px}
.step{display:grid;grid-template-columns:28px 1fr;gap:18px;padding:22px 0;border-top:1px solid #111}
.step:last-child{border-bottom:1px solid #111}
.step-n{font-size:11px;color:#666;padding-top:3px}
.step h3{font-size:15px;font-weight:600;margin-bottom:6px;letter-spacing:-.01em}
.step p{font-size:15px;color:#bbb;line-height:1.65}
.demo-outer{max-width:680px}
.drole-bar{display:flex;gap:6px;flex-wrap:wrap;margin:20px 0 16px}
.drole{padding:7px 14px;background:transparent;color:#666;border:1px solid #1a1a1a;font-size:12px;cursor:pointer;font-family:inherit;transition:color .1s,border-color .1s}
.drole:hover{color:#ccc;border-color:#444}
.drole.active{color:#fff;border-color:#555;background:#0d0d0d}
.demo-stage{position:relative;overflow:hidden;background:#050505;border:1px solid #1a1a1a}
.demo-log{padding:16px 20px;font-family:'SF Mono',Monaco,monospace;font-size:12px;line-height:2.1;transition:opacity .3s;min-height:150px}
.dlog-line{color:#666;animation:logslide .22s ease}
.dlog-line.done{color:#4a9}
@keyframes logslide{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
.djob{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:14px 20px;border-top:1px solid #111;cursor:pointer;opacity:0;transform:translateY(6px);transition:opacity .22s,transform .22s,background .12s,box-shadow .12s}
.djob:hover{background:#0a0a0a}
.djob.selected{background:#0d0d0d;box-shadow:inset 2px 0 0 #fff}
.djob.visible{opacity:1;transform:none}
.djob-co{font-size:13px;font-weight:600;color:#fff;margin-bottom:2px}
.djob-role{font-size:12px;color:#888;margin-bottom:3px}
.djob-meta{font-size:11px;color:#555}
.djob-right{text-align:right;flex-shrink:0}
.djob-fit{font-size:18px;font-weight:700;color:#fff;line-height:1}
.djob-denom{font-size:11px;color:#555;font-weight:400}
.djob-fit-lbl{font-size:10px;color:#555;letter-spacing:.04em;text-transform:uppercase;margin-top:2px}
.demo-sidebar{position:absolute;top:0;right:0;bottom:0;width:308px;background:#090909;border-left:1px solid #1e1e1e;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .28s cubic-bezier(.4,0,.2,1)}
.demo-sidebar.open{transform:translateX(0)}
.dsb-top{display:flex;justify-content:space-between;align-items:flex-start;padding:14px 16px;border-bottom:1px solid #161616;background:#0d0d0d;flex-shrink:0}
.dsb-co{font-size:12px;font-weight:700;color:#fff;margin-bottom:3px}
.dsb-role-lbl{font-size:11px;color:#666}
.dsb-close{background:none;border:none;color:#555;cursor:pointer;font-size:14px;padding:0;line-height:1;margin-left:8px;flex-shrink:0}
.dsb-close:hover{color:#ccc}
.dsb-body{flex:1;overflow-y:auto}
.dsb-gen{font-size:12px;color:#555;padding:20px 16px;animation:genpulse 1.2s ease-in-out infinite}
@keyframes genpulse{0%,100%{opacity:.4}50%{opacity:1}}
.blink{animation:blink .9s step-end infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
#dsb-kit{display:none}
.dsb-sec{padding:13px 16px;border-bottom:1px solid #111}
.dsb-sec:last-child{border-bottom:none}
.dsb-lbl{font-size:10px;color:#555;letter-spacing:.06em;text-transform:uppercase;margin-bottom:7px}
.dsb-txt{font-size:12px;color:#bbb;line-height:1.75}
.dsb-foot{padding:12px 16px;border-top:1px solid #161616;flex-shrink:0}
.dsb-apply-btn{width:100%;padding:9px;background:#fff;color:#000;border:none;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}
.dsb-apply-btn:hover{background:#e0e0e0}
.time-table{margin-top:28px}
.time-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0;padding:18px 0;border-top:1px solid #111;align-items:baseline}
.time-row:last-child{border-bottom:1px solid #111}
.time-task{font-size:14px;font-weight:500;color:#fff}
.time-before{font-size:13px;color:#666;text-decoration:line-through;text-decoration-color:#444}
.time-after{font-size:14px;color:#ccc;font-weight:500}
.price-n{font-size:56px;font-weight:700;letter-spacing:-.05em;line-height:1;margin-bottom:8px}
.price-s{font-size:15px;color:#bbb;margin-bottom:12px}
.price-d{font-size:13px;color:#888;margin-bottom:24px}
.price-d span{margin-right:18px}
.price-body{font-size:15px;color:#ccc;line-height:1.75;max-width:480px;margin-top:24px}
.price-body+.price-body{margin-top:14px}
.price-cta{margin-top:28px}
footer{padding:24px 32px;border-top:1px solid #111;display:flex;justify-content:space-between;align-items:center}
.fc{font-size:12px;color:#666}
.fl{display:flex;gap:16px}
.fl a{font-size:12px;color:#777}
.fl a:hover{color:#bbb}
</style>
</head>
<body>

<nav class="nav">
  <div class="nav-logo">applyapply</div>
  <div class="nav-right">
    <a href="/login" class="nav-link">Sign in</a>
    <a href="/buy" class="nav-cta">Get started →</a>
  </div>
</nav>

<div class="hero">
  <h1>Stop writing<br>cover letters.</h1>
  <p>Job searching is already a full-time job. Writing the same application forty different ways should not be part of it. applyapply finds the roles and gets a tailored application ready in seconds. You read it, edit anything, send.</p>
  <div class="ctas">
    <a href="/buy" class="btn-w">Get started — $10</a>
    <a href="/pipeline" class="btn-g">See the pipeline</a>
  </div>
</div>

<hr>

<div class="section">
  <div class="eyebrow">Where the time goes</div>
  <p class="body-l">A serious startup application takes 3 to 4 hours when done right. Most of that time is not thinking. It is mechanical.</p>
  <div class="time-table">
    <div class="time-row">
      <div class="time-task">Finding matching roles</div>
      <div class="time-before">2 hrs a week, manually</div>
      <div class="time-after">runs overnight</div>
    </div>
    <div class="time-row">
      <div class="time-task">Cover letter</div>
      <div class="time-before">60 to 90 minutes</div>
      <div class="time-after">30 seconds</div>
    </div>
    <div class="time-row">
      <div class="time-task">Custom questions</div>
      <div class="time-before">30 to 45 minutes each</div>
      <div class="time-after">30 seconds</div>
    </div>
    <div class="time-row">
      <div class="time-task">Tracking your pipeline</div>
      <div class="time-before">a spreadsheet you forget to update</div>
      <div class="time-after">built in</div>
    </div>
  </div>
</div>

<hr>

<div class="section demo-outer">
  <div class="eyebrow">See it work</div>
  <p class="body-l">Pick a role. Watch it source. Click a result.</p>

  <div class="drole-bar">
    <button class="drole active" onclick="startDemo('product',this)">Head of Product</button>
    <button class="drole" onclick="startDemo('growth',this)">Head of Growth</button>
    <button class="drole" onclick="startDemo('engineering',this)">VP Engineering</button>
    <button class="drole" onclick="startDemo('founding',this)">Founding PM</button>
  </div>

  <div class="demo-stage" id="demo-stage">
    <div class="demo-log" id="demo-log"></div>
    <div id="demo-jobs"></div>

    <div class="demo-sidebar" id="demo-sidebar">
      <div class="dsb-top">
        <div>
          <div class="dsb-co" id="dsb-co"></div>
          <div class="dsb-role-lbl" id="dsb-role-lbl"></div>
        </div>
        <button class="dsb-close" onclick="closeSidebar()">&#x2715;</button>
      </div>
      <div class="dsb-body">
        <div class="dsb-gen" id="dsb-gen">Generating apply kit<span class="blink">_</span></div>
        <div id="dsb-kit">
          <div class="dsb-sec">
            <div class="dsb-lbl">Cover letter</div>
            <div class="dsb-txt" id="dsb-cover"></div>
          </div>
          <div class="dsb-sec">
            <div class="dsb-lbl">Why this role</div>
            <div class="dsb-txt" id="dsb-why"></div>
          </div>
          <div class="dsb-sec">
            <div class="dsb-lbl" id="dsb-qlbl"></div>
            <div class="dsb-txt" id="dsb-qa"></div>
          </div>
        </div>
      </div>
      <div class="dsb-foot">
        <button class="dsb-apply-btn">Apply to this role &#8594;</button>
      </div>
    </div>
  </div>
</div>

<script>
const DJobs = {
  product:[
    {id:'p1',co:'Watershed',role:'Head of Product',stage:'Series B',loc:'Remote',src:'a16z portfolio',fit:9,
     cover:'"The best product bets are problems that look like infrastructure but turn out to be everything. At Watershed that problem is carbon accounting, and it is exactly where I want to build next."',
     why:'"I have been on the buyer side of bad carbon tooling. We evaluated six platforms and ended up in Notion. Watershed is what we needed and did not have."',
     q:'What does good climate infrastructure look like?',
     a:'"It disappears into the workflow. The best infrastructure is what your team does not think about."'},
    {id:'p2',co:'Orb',role:'Head of Product',stage:'Series A',loc:'Remote',src:'Sequoia portfolio',fit:8,
     cover:'"I kept running into the same wall: pricing models that made sense on paper fell apart in the billing system. Orb is the company that exists to fix that."',
     why:'"We tried to launch usage-based pricing and it took four months. The gap Orb fills is real and I have lived on the wrong side of it."',
     q:'How do you think about pricing as a product decision?',
     a:'"Pricing is the most honest signal a product sends about what it is worth. Getting it wrong is a product problem."'},
    {id:'p3',co:'Ramp',role:'PM, Spend Intelligence',stage:'Series D',loc:'Remote',src:'Thrive via Greenhouse',fit:7,
     cover:'"Smart finance teams lose hours to reports that should take minutes. Ramp is fixing the right layer and I want to help push it further."',
     why:'"Most spend tools show you what happened. Ramp is building toward telling you what to do. That is the hard problem."',
     q:'What do finance teams get wrong about software?',
     a:'"They optimize for auditability over usability. The result is tools that cover every case but drive the actual users insane."'},
  ],
  growth:[
    {id:'g1',co:'Notion',role:'Head of Growth',stage:'Series C',loc:'Remote',src:'Sequoia portfolio',fit:9,
     cover:'"Notion sits in a unique position: used like a consumer app, bought like enterprise software. The transition between those two motions is the most interesting growth problem in the market right now."',
     why:'"PLG to enterprise is the hardest motion in growth and Notion is right in the middle of it. That is exactly where I want to work."',
     q:'How do you balance viral growth with enterprise sales?',
     a:'"You sequence them, not balance them. Viral gets surface area. Enterprise gets depth."'},
    {id:'g2',co:'Descript',role:'Head of Growth',stage:'Series C',loc:'Remote',src:'a16z portfolio',fit:8,
     cover:'"Descript is in the category of products people recommend, not just use. That changes everything about how you grow it."',
     why:'"Every file you share is a distribution moment. Descript has network effects baked into the core action of using the product."',
     q:'What does a great referral loop look like?',
     a:'"One where sharing is a feature, not a prompt. The best loops are built into the core action of using the product."'},
    {id:'g3',co:'Retool',role:'Growth PM',stage:'Series C',loc:'SF / Remote',src:'Sequoia via Ashby',fit:7,
     cover:'"How do you grow a dev tool through the enterprise? I have been thinking about that question for years and Retool is the best current case study."',
     why:'"The question is not whether Retool can reach every engineering team. It is figuring out how."',
     q:'How do you grow a bottom-up tool top-down?',
     a:'"Find the champion inside and give them everything they need to make the case upward. The tool sells itself."'},
  ],
  engineering:[
    {id:'e1',co:'Linear',role:'VP Engineering',stage:'Growth stage',loc:'Remote',src:'YC company',fit:9,
     cover:'"Linear is the clearest answer I have seen to the engineering productivity problem. The technical decisions made in the next 18 months will define what it can become."',
     why:'"I want to be in the room for those decisions. This is the most interesting moment in the company."',
     q:'How do you think about engineering culture at scale?',
     a:'"Culture at scale is mostly the decisions you made early, calcified. The best time to set it is right now."'},
    {id:'e2',co:'Vercel',role:'Staff Engineer, Runtime',stage:'Series D',loc:'Remote',src:'Accel via Greenhouse',fit:8,
     cover:'"Vercel is doing for deployment what Stripe did for payments: making the hard thing simple and the simple thing automatic. The runtime layer is where the interesting problems live."',
     why:'"I have deployed enough at scale to know that the abstractions Vercel provides are the ones that actually matter."',
     q:'What makes a great developer experience?',
     a:'"Zero config that actually works. The default path should be right for 80 percent of cases."'},
    {id:'e3',co:'PlanetScale',role:'Engineering Lead, Query Optimizer',stage:'Series C',loc:'Remote',src:'a16z via Lever',fit:8,
     cover:'"Schema branching sounds simple and turns out to be very hard. Teams that pull it off cleanly change how the industry thinks about database migrations."',
     why:'"I have seen enough slow queries cause production incidents to have strong opinions about this layer."',
     q:'How do you approach database performance at scale?',
     a:'"You measure first. Most performance problems are invisible until you have the right observability in place."'},
  ],
  founding:[
    {id:'f1',co:'Neon',role:'Founding PM',stage:'Series B',loc:'Remote',src:'a16z portfolio',fit:9,
     cover:'"Serverless Postgres with branching is not a feature. It is a different way of thinking about data infrastructure, and Neon is at the stage where the product decisions made now will determine what it becomes."',
     why:'"Founding PM at an infrastructure company is about discovering the roadmap, not executing one. That is the job I want."',
     q:'What makes a great founding PM?',
     a:'"Comfort with ambiguity and a short feedback loop. You are not executing a roadmap, you are discovering one."'},
    {id:'f2',co:'Warp',role:'Founding PM',stage:'Series B',loc:'Remote',src:'YC company',fit:8,
     cover:'"Terminal is a category neglected for 40 years because the users are also the people building everything else. Warp is what happens when someone finally focuses on it."',
     why:'"I live in the terminal and I have opinions about what it should be. Warp is the first one I have used that felt designed for how I actually work."',
     q:'How do you build a product developers love?',
     a:'"You use it every day and you are honest about what is annoying. Developers can tell when a product is not built by its own users."'},
    {id:'f3',co:'Jam',role:'Founding PM',stage:'Series A',loc:'Remote',src:'YC via Ashby',fit:7,
     cover:'"Bug reports lose context between capture and fix. Jam treats that as the core problem, not a workflow problem, and that changes everything about what the product needs to do."',
     why:'"The question Jam is answering is how do you make the thing that always gets skipped actually happen."',
     q:'What does ideal bug reporting look like?',
     a:'"Context comes with the report automatically. No back and forth, no reproduce steps written from memory."'},
  ],
};

const DLogs = {
  product:['Searching a16z portfolio jobs.a16z.com...','&#8594; 2 Head of Product openings','Searching Sequoia portfolio sequoiacap.com/jobs...','&#8594; 1 match','Pulling Greenhouse board index...','&#8594; 14 results — scoring fit','Running AI fit scoring...','&#10003; 3 roles surfaced for review'],
  growth:['Searching Sequoia portfolio sequoiacap.com/jobs...','&#8594; 3 Head of Growth openings','Searching a16z portfolio...','&#8594; 2 matches','Pulling Ashby board index via Google...','&#8594; 9 results — scoring fit','Running AI fit scoring...','&#10003; 3 roles surfaced for review'],
  engineering:['Searching YC Work at a Startup...','&#8594; 4 VP Engineering openings','Pulling Greenhouse board index...','&#8594; 18 results — filtering seniority','Searching Lever board index...','&#8594; 6 additional results','Running AI fit scoring...','&#10003; 3 roles surfaced for review'],
  founding:['Searching a16z portfolio...','&#8594; 3 Founding PM openings','Searching YC Work at a Startup...','&#8594; 11 results — filtering founding-stage','Pulling Ashby board index via Google...','&#8594; 5 results','Running AI fit scoring...','&#10003; 3 roles surfaced for review'],
};

let dRunning = false;

function startDemo(role, btn) {
  if (dRunning) return;
  dRunning = true;

  document.querySelectorAll('.drole').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  closeSidebar(true);

  const log = document.getElementById('demo-log');
  const jobs = document.getElementById('demo-jobs');
  log.innerHTML = '';
  log.style.opacity = '1';
  log.style.display = '';
  jobs.innerHTML = '';

  const lines = DLogs[role];
  let i = 0;
  function nextLine() {
    if (i >= lines.length) {
      setTimeout(() => {
        log.style.opacity = '0';
        setTimeout(() => {
          log.style.display = 'none';
          log.style.opacity = '1';
          showJobs(DJobs[role]);
          dRunning = false;
        }, 300);
      }, 500);
      return;
    }
    const div = document.createElement('div');
    div.className = 'dlog-line' + (i === lines.length - 1 ? ' done' : '');
    div.innerHTML = lines[i];
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    i++;
    setTimeout(nextLine, i <= 2 ? 340 : i <= 6 ? 320 : 260);
  }
  nextLine();
}

function showJobs(jobList) {
  const jobs = document.getElementById('demo-jobs');
  jobs.innerHTML = '';
  jobList.forEach((j, idx) => {
    const el = document.createElement('div');
    el.className = 'djob';
    el.id = 'djob-' + j.id;
    el.innerHTML =
      '<div><div class="djob-co">' + j.co + '</div>' +
      '<div class="djob-role">' + j.role + ' &middot; ' + j.stage + '</div>' +
      '<div class="djob-meta">' + j.loc + ' &middot; via ' + j.src + '</div></div>' +
      '<div class="djob-right"><div class="djob-fit">' + j.fit + '<span class="djob-denom">/10</span></div>' +
      '<div class="djob-fit-lbl">fit</div></div>';
    el.onclick = function() { openJob(j); };
    jobs.appendChild(el);
    setTimeout(function() { el.classList.add('visible'); }, 80 + idx * 130);
  });
}

function openJob(job) {
  document.querySelectorAll('.djob').forEach(el => el.classList.remove('selected'));
  const el = document.getElementById('djob-' + job.id);
  if (el) el.classList.add('selected');

  document.getElementById('dsb-co').textContent = job.co + ' · ' + job.stage;
  document.getElementById('dsb-role-lbl').textContent = job.role;

  const kit = document.getElementById('dsb-kit');
  const gen = document.getElementById('dsb-gen');
  kit.style.display = 'none';
  gen.style.display = '';

  document.getElementById('demo-sidebar').classList.add('open');

  setTimeout(function() {
    document.getElementById('dsb-cover').textContent = job.cover;
    document.getElementById('dsb-why').textContent = job.why;
    document.getElementById('dsb-qlbl').textContent = job.q;
    document.getElementById('dsb-qa').textContent = job.a;
    gen.style.display = 'none';
    kit.style.display = '';
  }, 950);
}

function closeSidebar(instant) {
  document.getElementById('demo-sidebar').classList.remove('open');
  if (instant) {
    document.getElementById('dsb-kit').style.display = 'none';
    document.getElementById('dsb-gen').style.display = '';
  }
  document.querySelectorAll('.djob').forEach(el => el.classList.remove('selected'));
}

setTimeout(function() { var b = document.querySelector('.drole'); startDemo('product', b); }, 700);
</script>

<hr>

<div class="section">
  <div class="eyebrow">Pricing</div>
  <div class="price-n">$10</div>
  <div class="price-s">1,000 credits · one time · never expires</div>
  <div class="price-d">
    <span>Sourcing run: ~60 cr ($0.60)</span>
    <span>Apply kit: 10 cr ($0.10)</span>
    <span>Cover letter: 8 cr ($0.08)</span>
  </div>
  <p class="price-body">If you are between jobs, software should not be another monthly charge. Ten dollars, one time, covers roughly 16 sourcing runs and 100 applications. Most searches need less.</p>
  <p class="price-body">Credits are browser sessions and Claude API calls at cost plus 20%. You could build this stack yourself. We charge what it costs to run, not what the market will bear.</p>
  <div class="price-cta"><a href="/buy" class="btn-w">Buy credits</a></div>
</div>

<footer>
  <span class="fc">applyapply.xyz</span>
  <div class="fl">
    <a href="/login">Sign in</a>
    <a href="/setup">Setup</a>
    <a href="/pipeline">Pipeline</a>
  </div>
</footer>

</body>
</html>`);
});

app.get('/credits', async (req, res) => {
  // JWT session
  const bearer = req.headers['authorization']?.match(/^Bearer (.+)/)?.[1]
    || (req.headers['x-api-key']?.startsWith('eyJ') ? req.headers['x-api-key'] : null);
  if (bearer) {
    const payload = verifySession(bearer);
    if (!payload) return res.status(401).json({ error: 'Session expired' });
    const user = await getUser(payload.email);
    return res.json({ balance: user?.credits ?? 0, email: payload.email, costs: CREDIT_COSTS });
  }
  // Legacy API key
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const users = loadUsers();
    const user = users[apiKey];
    if (!user) return res.status(401).json({ error: 'Invalid API key' });
    return res.json({ balance: user.balance, email: user.email, costs: CREDIT_COSTS });
  }
  if (isLocalRequest(req)) return res.json({ mode: 'self_hosted', balance: null });
  res.status(401).json({ error: 'Sign in required' });
});

// ── Auth endpoints ────────────────────────────────────────────────────────────

app.get('/login', (req, res) => {
  const extId = req.query.ext || '';
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — applyapply</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#000;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;-webkit-font-smoothing:antialiased}
a{text-decoration:none;color:inherit}
.mark{font-size:13px;font-weight:700;letter-spacing:-.02em;color:#666;margin-bottom:48px}
h1{font-size:24px;font-weight:700;letter-spacing:-.03em;margin-bottom:10px}
.sub{font-size:15px;color:#aaa;margin-bottom:32px}
.form{width:300px}
input{display:block;width:100%;padding:11px 13px;background:#0a0a0a;border:1px solid #222;color:#fff;font-size:15px;outline:none;font-family:inherit;margin-bottom:10px}
input:focus{border-color:#444}
input::placeholder{color:#444}
.btn{display:block;width:100%;padding:11px;background:#fff;color:#000;border:none;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
.btn:hover{background:#e5e5e5}
.btn:disabled{opacity:.3;cursor:default}
#msg{margin-top:12px;font-size:13px;min-height:16px;text-align:center;color:#666}
#msg.ok{color:#4ade80}#msg.err{color:#f87171}
</style>
</head>
<body>
<a href="/" class="mark">applyapply</a>
<h1>Sign in</h1>
<p class="sub">We'll email you a link. No password.</p>
<div class="form">
  <input type="email" id="email" placeholder="you@example.com" autofocus/>
  <button class="btn" id="btn" onclick="send()">Send link</button>
  <div id="msg"></div>
</div>
<script>
const EXT_ID=${JSON.stringify(extId)};
async function send(){
  const email=document.getElementById('email').value.trim();
  const msg=document.getElementById('msg');
  const btn=document.getElementById('btn');
  if(!email){msg.textContent='Enter your email';msg.className='err';return;}
  btn.disabled=true;btn.textContent='Sending…';
  try{
    const r=await fetch('/auth/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,ext:EXT_ID})});
    const j=await r.json();
    if(!r.ok){msg.textContent=j.error||'Error';msg.className='err';btn.disabled=false;btn.textContent='Send link';return;}
    msg.textContent='Check your email.';msg.className='ok';btn.textContent='Link sent';
  }catch(e){msg.textContent='Error: '+e.message;msg.className='err';btn.disabled=false;btn.textContent='Send link';}
}
document.getElementById('email').addEventListener('keydown',e=>{if(e.key==='Enter')send();});
</script>
</body>
</html>`);
});

app.post('/auth/request', authLimiter, async (req, res) => {
  const { email, ext } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  try {
    await createMagicLink(email.toLowerCase(), token, expiresAt);

    const origin = `${req.protocol}://${req.get('host')}`;
    const extParam = ext ? `&ext=${encodeURIComponent(ext)}` : '';
    const link = `${origin}/auth/verify?token=${token}${extParam}`;

    await sendMagicLinkEmail(email.toLowerCase(), link);
    res.json({ ok: true });
  } catch (e) {
    console.error('Magic link error:', e.message);
    res.status(500).json({ error: 'Failed to send sign-in email' });
  }
});

app.get('/auth/verify', async (req, res) => {
  const { token, ext } = req.query;
  if (!token) return res.status(400).send('Missing token');

  const link = await getMagicLink(token);
  if (!link) return res.status(400).send('Invalid or expired link');
  if (link.used) return res.status(400).send('This link has already been used');
  if (new Date(link.expires_at) < new Date()) return res.status(400).send('Link expired — request a new one');

  await useMagicLink(token);
  const existingUser = await getUser(link.email);
  await getOrCreateUser(link.email);
  const isNewUser = !existingUser;

  const session = signSession(link.email);
  if (isNewUser) {
    const origin = `${req.protocol}://${req.get('host')}`;
    sendEmail(link.email, 'Welcome to applyapply',
      `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:40px auto;padding:32px;background:#fff;border:1px solid #e5e5e5;border-radius:8px">
        <h2 style="font-size:18px;font-weight:700;margin-bottom:16px">You're in.</h2>
        <p style="color:#555;font-size:14px;margin-bottom:12px">Here's what to do first:</p>
        <ol style="color:#333;font-size:14px;padding-left:20px;line-height:2">
          <li><a href="${origin}/setup" style="color:#2563eb">Set up your profile</a> — paste your resume, fill in your background. This is what the AI reads to write your applications.</li>
          <li><a href="${origin}/sourcing" style="color:#2563eb">Run sourcing</a> — pick your sources and let the agent find matching roles.</li>
          <li>Install the Chrome extension — open it on any job page and hit Generate. The kit writes itself.</li>
        </ol>
        <p style="color:#aaa;font-size:12px;margin-top:24px">You have 0 credits to start. <a href="${origin}/buy" style="color:#2563eb">Buy credits</a> to run sourcing and generate apply kits.</p>
      </div>`,
      `Welcome to applyapply. Set up your profile: ${origin}/setup`
    ).catch(() => {});
  }
  const extParam = ext ? `&ext=${encodeURIComponent(ext)}` : '';
  res.redirect(`/auth/success?session=${session}${extParam}`);
});

app.get('/auth/success', (req, res) => {
  const { session, ext } = req.query;
  let email = '';
  try { email = verifySession(session)?.email || ''; } catch {}
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signed in — applyapply</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#000;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;-webkit-font-smoothing:antialiased}
a{text-decoration:none;color:inherit}
.mark{font-size:13px;font-weight:700;letter-spacing:-.02em;color:#333;margin-bottom:48px}
h1{font-size:22px;font-weight:700;letter-spacing:-.03em;margin-bottom:8px}
.em{font-size:13px;color:#333;margin-bottom:32px}
.btn{display:inline-block;padding:10px 20px;background:#fff;color:#000;font-size:13px;font-weight:600;cursor:pointer;letter-spacing:-.01em}
.btn:hover{background:#e5e5e5}
#extStatus{margin-top:20px;font-size:12px;color:#2a2a2a;min-height:16px}
#extStatus.ok{color:#4ade80}
</style>
</head>
<body>
<a href="/" class="mark">applyapply</a>
<h1>You're in.</h1>
<p class="em">${email}</p>
<a href="/setup" class="btn">Set up your profile →</a>
<div id="extStatus"></div>
<script>
const SESSION=${JSON.stringify(session||'')};
const EXT_ID=${JSON.stringify(ext||'')};
if(SESSION){
  try{localStorage.setItem('aa_session',SESSION);}catch(e){}
}
if(EXT_ID&&SESSION){
  const st=document.getElementById('extStatus');
  st.textContent='Connecting extension…';
  try{
    chrome.runtime.sendMessage(EXT_ID,{type:'SET_SESSION',token:SESSION},res=>{
      if(chrome.runtime.lastError||!res?.ok){st.textContent='Could not connect — reload the extension popup.';}
      else{st.textContent='Extension connected.';st.className='ok';}
    });
  }catch(e){st.textContent='Open the extension popup to finish connecting.';}
}
</script>
</body>
</html>`);
});

app.get('/auth/me', async (req, res) => {
  const bearer = req.headers['authorization']?.match(/^Bearer (.+)/)?.[1]
    || (req.headers['x-api-key']?.startsWith('eyJ') ? req.headers['x-api-key'] : null);
  if (!bearer) return res.status(401).json({ error: 'Not signed in' });
  const payload = verifySession(bearer);
  if (!payload) return res.status(401).json({ error: 'Session expired' });
  const user = await getUser(payload.email);
  res.json({ email: payload.email, credits: user?.credits ?? 0 });
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

const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || 'price_1TwTPEPGwHxMKnrmamj8B9wY';
const CREDITS_PER_DOLLAR = 100; // $0.01/credit → $10 = 1000 credits

function loadStripeKey() {
  return process.env.STRIPE_SECRET_KEY || null;
}

function loadStripeWebhookSecret() {
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
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>applyapply — buy credits</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#000;color:#fff;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;-webkit-font-smoothing:antialiased}
a{text-decoration:none;color:inherit}
.mark{font-size:13px;font-weight:700;letter-spacing:-.02em;color:#333;margin-bottom:48px}
.price{font-size:52px;font-weight:700;letter-spacing:-.05em;line-height:1;margin-bottom:6px}
.price-s{font-size:14px;color:#888;margin-bottom:20px}
.form{width:300px}
label{display:block;font-size:11px;color:#333;letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px}
input{display:block;width:100%;padding:10px 12px;background:#0a0a0a;border:1px solid #1a1a1a;color:#fff;font-size:14px;outline:none;font-family:inherit;margin-bottom:10px}
input:focus{border-color:#2a2a2a}
input::placeholder{color:#222}
button{width:100%;padding:10px;background:#fff;color:#000;border:none;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
button:hover{background:#e5e5e5}
button:disabled{opacity:.3;cursor:default}
.error{font-size:12px;color:#f87171;margin-top:10px;display:none}
</style>
</head>
<body>
<a href="/" class="mark">applyapply</a>
<div class="price">$10</div>
<div class="price-s">1,000 credits · no subscription · never expires</div>
<p style="font-size:14px;color:#aaa;max-width:280px;text-align:center;line-height:1.7;margin-bottom:28px">Credits are Hyperbrowser sessions and Claude API calls at cost plus 20%. You could build this. We charge what it costs to run, not what the market will bear.</p>
<div class="form">
  <label>Email</label>
  <input id="email" type="email" placeholder="you@example.com" autofocus/>
  <button id="btn" onclick="checkout()">Pay with card →</button>
  <div class="error" id="err"></div>
</div>
<script>
async function checkout(){
  const email=document.getElementById('email').value.trim();
  const btn=document.getElementById('btn');
  const err=document.getElementById('err');
  if(!email||!email.includes('@')){err.textContent='Enter a valid email';err.style.display='';return;}
  btn.disabled=true;btn.textContent='Redirecting…';
  try{
    const d=await fetch('/checkout',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})}).then(r=>r.json());
    if(d.url)window.location.href=d.url;
    else{err.textContent=d.error||'Something went wrong';err.style.display='';btn.disabled=false;btn.textContent='Pay with card →';}
  }catch{err.textContent='Network error';err.style.display='';btn.disabled=false;btn.textContent='Pay with card →';}
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
    const host = APP_ORIGIN;
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

    const user = await getUser(email);
    if (user) credits = user.credits;
  } catch (e) {
    console.error('[checkout/success]', e.message);
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>applyapply — you're in</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#ccc;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{width:440px;padding:40px;border:1px solid #1a1a1a;border-radius:8px;text-align:center}
.check{font-size:42px;margin-bottom:16px}
h2{font-size:20px;font-weight:700;color:#fff;margin-bottom:8px}
.sub{font-size:13px;color:#555;line-height:1.6;margin-bottom:28px}
.email-box{background:#111;border:1px solid #222;border-radius:6px;padding:10px 14px;font-size:13px;color:#4ade80;margin-bottom:24px}
.steps{text-align:left;font-size:13px;color:#555;line-height:2}
.steps b{color:#888}
</style>
</head>
<body>
<div class="card">
  <div class="check">✓</div>
  <h2>You're in</h2>
  <p class="sub">We've sent a sign-in link to:</p>
  <div class="email-box">${email}</div>
  <div class="steps">
    <b>1.</b> Click the link in your email to sign in<br>
    <b>2.</b> <a href="/setup" style="color:#4ade80">Set up your profile</a> — upload your resume and fill in your background<br>
    <b>3.</b> <a href="/sourcing" style="color:#4ade80">Run sourcing</a> — the agent finds matching roles<br>
    <b>4.</b> Install the Chrome extension — open it on any job page to generate your kit
  </div>
</div>
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
    const email = (session.customer_details?.email || session.customer_email || '').toLowerCase();
    const amountPaid = session.amount_total || 0;
    const credits = Math.floor((amountPaid / 100) * CREDITS_PER_DOLLAR);

    if (email && event.id) {
      const credited = await db.applyStripePayment(event.id, email, credits);
      if (!credited) return res.json({ received: true, duplicate: true });
      console.log(`[stripe] ${email} +${credits} credits`);

      // Send magic link so they can sign in immediately
      const origin = process.env.APP_ORIGIN || 'https://applyapply.xyz';
      const token = require('crypto').randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24hr after purchase
      await createMagicLink(email, token, expiresAt);
      const link = `${origin}/auth/verify?token=${token}`;
      sendMagicLinkEmail(email, link).catch(e => console.error('[stripe magic link email]', e.message));
    }
  }

  res.json({ received: true });
});

// ─────────────────────────────────────────────────────────────────────────────

// Default profile used for local/self-hosted mode (no API key)
const PROFILE = {
  first_name: 'Chad', last_name: 'Wittman',
  email: 'wittman.c@gmail.com', phone: '920-378-6761',
  linkedin: 'https://linkedin.com/in/chadwittman',
  github: 'https://github.com/chadwittman',
  twitter: 'https://x.com/ChadWittman',
  website: 'https://chadwittman.com',
  location: 'Austin, TX', work_authorization: 'U.S. Citizen, no sponsorship needed',
  current_employer: 'ELDRICK', school: 'University of Wisconsin (UWEC)',
  bio: `Two exits: EdgeRank Checker (250K brands, sold to Socialbakers), Dolly (500K users, $10M+ ARR, sold to IKEA via TaskRabbit). Co-founded Krause House — raised $5M in 15 min, executed the first DAO acquisition bid on an NBA team.

Current: co-founder and CEO of ELDRICK, an AI golf fitting platform. Built it end-to-end: deterministic constraints, probabilistic recommendations, model reasoning, and expert-in-the-loop review. Fit 12,000+ golfers across ELDRICK Scout, ELDRICK Marshal, and the ELDRICK API. Built Haley, an AI employee that runs ELDRICK's marketing, sales, and analytics on a fully automated loop.

At Filmhub (a16z-backed): built the AI creative engine for Stash, Filmhub's short-film streaming brand. The system covered thumbnails, titles, artwork, testing, designer workflows, and quality control end-to-end. Drove Stash revenue up 161% and gross revenue per published title 4.5x despite YouTube CPMs falling ~40%. Added $600k+ in annualized revenue while cutting publishing costs 50%. Also built the founding AI-powered go-to-market system for Relay across editorial, copy, social, merchandising, and collection strategy.

Superpowers: AI systems in production, growth/GTM, 0-to-1 product and company building, experimentation, cross-functional leadership, speed.

Portfolio: https://chadwittman.com`,
};

// Resolve profile for a request: DB lookup by email (JWT) or API key (legacy), fallback to local PROFILE const
async function resolveProfile(req) {
  const merge = (dbProfile) => {
    const merged = { ...PROFILE };
    for (const [k, v] of Object.entries(dbProfile)) { if (v != null && v !== '') merged[k] = v; }
    return merged;
  };
  if (req.userEmail) {
    const p = await getProfileByUserEmail(req.userEmail);
    if (p) return merge(p);
  }
  const apiKey = req.apiKey || req.headers['x-api-key'];
  if (apiKey && !apiKey.startsWith('eyJ')) {
    const p = await getProfile(apiKey);
    if (p) return merge(p);
  }
  return PROFILE;
}

// ── Profile endpoints ─────────────────────────────────────────────────────────

function authFromRequest(req) {
  const bearer = req.headers['authorization']?.match(/^Bearer (.+)/)?.[1]
    || (req.headers['x-api-key']?.startsWith('eyJ') ? req.headers['x-api-key'] : null);
  if (bearer) {
    const payload = verifySession(bearer);
    return payload ? { type: 'jwt', email: payload.email } : null;
  }
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    const users = loadUsers();
    if (users[apiKey]) return { type: 'apikey', apiKey };
  }
  if (isLocalRequest(req)) return { type: 'local' };
  return null;
}

app.get('/profile', async (req, res) => {
  const auth = authFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'Sign in required' });
  if (auth.type === 'local') return res.json(PROFILE);
  if (auth.type === 'jwt') return res.json(await getProfileByUserEmail(auth.email) || {});
  res.json(await getProfile(auth.apiKey) || {});
});

app.post('/profile', async (req, res) => {
  const auth = authFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'Sign in required' });
  if (auth.type === 'local') return res.json({ ok: true, note: 'local mode' });
  const allowed = ['first_name','last_name','email','phone','linkedin','github','twitter','website','location','work_authorization','salary','current_employer','school','bio'];
  const data = {};
  for (const f of allowed) data[f] = req.body[f] || null;
  if (auth.type === 'jwt') await setProfile(auth.email, data, true);
  else await setProfile(auth.apiKey, data);
  res.json({ ok: true });
});

// ── Resume parse ─────────────────────────────────────────────────────────────

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.post('/resume/parse', apiLimiter, async (req, res) => {
  const auth = authFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'Sign in required' });
  if (auth.type === 'jwt') req.userEmail = auth.email;
  if (auth.type === 'apikey') req.apiKey = auth.apiKey;
  upload.single('resume')(req, res, async (uploadError) => {
    if (uploadError) return res.status(400).json({ error: uploadError.message });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!req.file.mimetype.includes('pdf') && !req.file.originalname.toLowerCase().endsWith('.pdf')) {
    return res.status(400).json({ error: 'PDF only' });
  }
  try {
    const data = await pdfParse(req.file.buffer);
    const text = data.text.replace(/\s{3,}/g, '\n\n').trim();
    if (!text) return res.status(422).json({ error: 'Could not extract text from PDF' });

    if (!keys) return res.json({ text });
    const prompt = `Extract structured profile information from this resume. Return ONLY a valid JSON object — no preamble, no markdown fences — with these fields (omit any you cannot confidently determine from the resume):

{
  "first_name": "",
  "last_name": "",
  "email": "",
  "phone": "",
  "location": "City, ST",
  "linkedin": "https://linkedin.com/in/...",
  "github": "https://github.com/...",
  "twitter": "",
  "website": "",
  "current_employer": "Current company name",
  "school": "University Name — Degree",
  "bio": "2-4 paragraphs first-person bio",
  "career_type": "one of: product, growth, engineering, design, marketing, operations, sales, data",
  "target_roles": "4-6 comma-separated job titles this person is qualified for and would plausibly target next, ranged from their exact current-level title down a notch, e.g. 'Head of Product, VP of Product, Director of Product, Founding PM'"
}

For the bio field: write in first person. Keep every number, company name, and concrete outcome. No em dashes. No filler words. Short sentences mixed with longer ones.

For target_roles: infer from career trajectory and seniority shown in the resume, not just the most recent title verbatim. Favor titles a recruiter would actually post, not invented ones.

RESUME:
${text.slice(0, 6000)}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': keys.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 2500, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) return res.json({ text });
    const raw = (await r.json()).content[0].text.trim();
    const jsonMatch = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const braceMatch = jsonMatch.match(/\{[\s\S]*\}/);
    let parsed = {};
    try { parsed = JSON.parse(braceMatch ? braceMatch[0] : jsonMatch); } catch (e) {
      console.error('Resume JSON parse failed:', e.message, '| raw:', raw.slice(0, 500));
      parsed = {};
    }
    res.json({ text, ...parsed });
  } catch (e) {
    console.error('Resume parse error:', e.message);
    res.status(500).json({ error: e.message });
  }
  });
});

// ── Setup page ────────────────────────────────────────────────────────────────

app.get('/setup', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Profile — applyapply</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#000;color:#fff;padding:0;-webkit-font-smoothing:antialiased}
a{text-decoration:none;color:inherit}
.nav{display:flex;justify-content:space-between;align-items:center;padding:18px 32px;border-bottom:1px solid #111}
.nav-logo{font-size:13px;font-weight:700;letter-spacing:-.02em}
.nav-right{display:flex;gap:16px;align-items:center}
.nav-link{font-size:13px;color:#fff}
.nav-link:hover{opacity:.7}
.wrap{max-width:600px;margin:0 auto;padding:48px 32px 80px}
h1{font-size:20px;font-weight:700;letter-spacing:-.03em;margin-bottom:6px}
.auth-status{font-size:13px;margin-bottom:40px}
.auth-status a{color:#fff;text-decoration:underline}
.sec{margin-bottom:36px;padding-bottom:36px;border-bottom:1px solid #111}
.sec:last-of-type{border-bottom:none}
.sec-label{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:16px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.field{margin-bottom:14px}
label{display:block;font-size:13px;margin-bottom:5px}
input,textarea,select{width:100%;padding:9px 12px;background:#0a0a0a;border:1px solid #222;color:#fff;font-size:14px;outline:none;font-family:inherit}
input:focus,textarea:focus,select:focus{border-color:#555}
input::placeholder,textarea::placeholder{color:#444}
select option{background:#111}
textarea{min-height:200px;resize:vertical;line-height:1.65}
.resume-drop{border:1px solid #222;padding:24px;text-align:center;cursor:pointer;transition:border-color .15s;margin-bottom:0}
.resume-drop:hover,.resume-drop.drag{border-color:#fff}
.resume-drop-label{font-size:15px;font-weight:600;margin-bottom:4px}
.resume-drop-browse{cursor:pointer;text-decoration:underline}
#resumeStatus{margin-top:10px;font-size:13px;min-height:16px}
.save-row{display:flex;align-items:center;gap:16px;margin-top:4px}
.btn{padding:10px 20px;background:#fff;color:#000;border:none;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
.btn:hover{background:#e5e5e5}
.btn:disabled{opacity:.3;cursor:not-allowed}
#status{font-size:13px;min-height:16px}
#status.ok{color:#4ade80}#status.err{color:#f87171}
.nav-links-footer{margin-top:32px;font-size:13px}
.nav-links-footer a:hover{opacity:.7}
</style>
</head>
<body>
<nav class="nav">
  <a href="/" class="nav-logo">applyapply</a>
  <div class="nav-right">
    <a href="/pipeline" class="nav-link">Pipeline</a>
    <a href="/sourcing" class="nav-link">Sourcing</a>
  </div>
</nav>
<div class="wrap">
<h1>Your profile</h1>
<p class="auth-status" id="authStatus"></p>

<div class="sec">
  <div class="sec-label">Resume</div>
  <div class="resume-drop" id="resumeDrop">
    <input type="file" id="resumeFile" accept=".pdf" style="display:none"/>
    <div class="resume-drop-label">Drop your resume PDF here, or <span class="resume-drop-browse" onclick="document.getElementById('resumeFile').click()">browse</span></div>
    <div id="resumeStatus"></div>
  </div>
</div>

<div class="sec">
  <div class="sec-label">Contact</div>
  <div class="row">
    <div class="field"><label>First name</label><input id="first_name"/></div>
    <div class="field"><label>Last name</label><input id="last_name"/></div>
  </div>
  <div class="row">
    <div class="field"><label>Email</label><input id="email" type="email"/></div>
    <div class="field"><label>Phone</label><input id="phone" placeholder="555-555-5555"/></div>
  </div>
  <div class="row">
    <div class="field"><label>Location</label><input id="location" placeholder="Austin, TX"/></div>
    <div class="field"><label>Work authorization</label><input id="work_authorization" placeholder="U.S. Citizen, no sponsorship needed"/></div>
  </div>
</div>

<div class="sec">
  <div class="sec-label">Links</div>
  <div class="row">
    <div class="field"><label>LinkedIn</label><input id="linkedin" placeholder="https://linkedin.com/in/..."/></div>
    <div class="field"><label>GitHub</label><input id="github" placeholder="https://github.com/..."/></div>
  </div>
  <div class="row">
    <div class="field"><label>Twitter / X</label><input id="twitter" placeholder="https://x.com/..."/></div>
    <div class="field"><label>Portfolio</label><input id="website" placeholder="https://..."/></div>
  </div>
</div>

<div class="sec">
  <div class="sec-label">Professional</div>
  <div class="row">
    <div class="field"><label>Current employer</label><input id="current_employer"/></div>
    <div class="field"><label>School / degree</label><input id="school" placeholder="University of Wisconsin"/></div>
  </div>
  <div class="field">
    <label>Salary expectation</label>
    <input id="salary" placeholder="250000"/>
    <div class="hint">Numbers only.</div>
  </div>
</div>

<div class="sec">
  <div class="sec-label">Job search</div>
  <div class="field">
    <label>Career type</label>
    <select id="career_type">
      <option value="">— select —</option>
      <option value="product">Product (Head of Product, PM, CPO)</option>
      <option value="growth">Growth (Head of Growth, Growth PM, GTM)</option>
      <option value="engineering">Engineering (Head of Eng, Staff Eng, CTO)</option>
      <option value="design">Design (Head of Design, Product Design)</option>
      <option value="marketing">Marketing (Head of Marketing, CMO)</option>
      <option value="operations">Operations (COO, Head of Ops)</option>
      <option value="sales">Sales (VP Sales, Head of Sales)</option>
      <option value="data">Data / Analytics (Head of Data, Staff DS)</option>
    </select>
  </div>
  <div class="field">
    <label>Target role titles</label>
    <input id="target_roles" placeholder="Head of Product, VP of Product, Founding PM"/>
    <div class="hint">Comma-separated. The sourcing agent searches for these exact titles.</div>
  </div>
  <div class="field">
    <label>Location preference</label>
    <select id="location_pref">
      <option value="remote">Remote only</option>
      <option value="hybrid">Open to hybrid (in my city)</option>
      <option value="any">Any (remote, hybrid, or on-site)</option>
    </select>
    <div class="hint">Hybrid uses your Location field above.</div>
  </div>
</div>

<div class="sec">
  <div class="sec-label">Background</div>
  <div class="field">
    <label>Bio</label>
    <textarea id="bio" placeholder="Tell your story. What have you built, who for, what did it drive?

Your current role — company name, what you built, concrete outcomes.
Prior companies or exits — names, scale, what happened.
Your edge — 2-3 things you're uniquely good at.

Numbers beat adjectives. Name the companies."></textarea>
    <div class="hint">The better this is, the better every application will be.</div>
  </div>
</div>

<div class="save-row">
  <button class="btn" id="saveBtn" onclick="save()">Save profile</button>
  <div id="status"></div>
</div>
<div class="nav-links-footer">
  <a href="/pipeline">View pipeline →</a> &nbsp;·&nbsp; <a href="/sourcing">Run sourcing →</a>
</div>
</div>

<script>
const FIELDS=['first_name','last_name','email','phone','location','work_authorization','linkedin','github','twitter','website','current_employer','school','salary','bio','career_type','target_roles','location_pref'];

function getKey(){
  const params=new URLSearchParams(location.search);
  return params.get('token')||localStorage.getItem('aa_session')||'';
}

function setField(f,v){const el=document.getElementById(f);if(!el||!v)return;el.tagName==='SELECT'?el.value=v:el.value=v;}

async function load(){
  const key=getKey();
  const authEl=document.getElementById('authStatus');
  if(!key){authEl.innerHTML='Not signed in. <a href="/login">Sign in →</a>';return;}
  try{
    const r=await fetch('/profile',{headers:{'x-api-key':key}});
    if(!r.ok){authEl.innerHTML='Session expired. <a href="/login">Sign in again →</a>';return;}
    const p=await r.json();
    authEl.textContent=p.email?'Signed in as '+p.email:'Signed in';
    for(const f of FIELDS)setField(f,p[f]);
  }catch(e){authEl.textContent='Could not load profile.';}
}
load();

async function uploadResume(file){
  const rs=document.getElementById('resumeStatus');
  rs.textContent='Reading resume…';rs.style.color='';
  const fd=new FormData();fd.append('resume',file);
  const h={};const key=getKey();if(key)h['x-api-key']=key;
  try{
    const r=await fetch('/resume/parse',{method:'POST',headers:h,body:fd});
    const j=await r.json();
    if(!r.ok){rs.textContent=j.error||'Parse failed';rs.style.color='#f87171';return;}
    const fillable=['first_name','last_name','email','phone','location','linkedin','github','twitter','website','current_employer','school','bio','career_type','target_roles'];
    let filled=0;
    for(const f of fillable){if(j[f]){setField(f,j[f]);filled++;}}
    rs.textContent=filled?filled+' fields filled — career type and target roles are AI guesses, worth a look before you save.':'Could not extract structured fields — check the values above, or try again.';
    rs.style.color=filled?'#4ade80':'#f87171';
  }catch(e){rs.textContent='Error: '+e.message;rs.style.color='#f87171';}
}

const drop=document.getElementById('resumeDrop');
drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('drag');});
drop.addEventListener('dragleave',()=>drop.classList.remove('drag'));
drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('drag');const f=e.dataTransfer.files[0];if(f)uploadResume(f);});
document.getElementById('resumeFile').addEventListener('change',e=>{const f=e.target.files[0];if(f)uploadResume(f);});

async function save(){
  const key=getKey();
  const st=document.getElementById('status');
  if(!key){st.textContent='Sign in first';st.className='err';return;}
  const btn=document.getElementById('saveBtn');
  btn.disabled=true;btn.textContent='Saving…';
  const data={};
  for(const f of FIELDS){const el=document.getElementById(f);if(!el)continue;const v=el.value.trim();if(v)data[f]=v;}
  try{
    const r=await fetch('/profile',{method:'POST',headers:{'x-api-key':key,'content-type':'application/json'},body:JSON.stringify(data)});
    const j=await r.json();
    if(!r.ok){st.textContent=j.error||'Error';st.className='err';return;}
    st.textContent='Saved.';st.className='ok';setTimeout(()=>{st.textContent='';},2000);
  }catch(e){st.textContent='Error: '+e.message;st.className='err';}
  finally{btn.disabled=false;btn.textContent='Save profile';}
}
</script>
</body>
</html>`);
});

function loadKeys() {
  if (process.env.ANTHROPIC_API_KEY) return { key: process.env.ANTHROPIC_API_KEY, provider: 'anthropic' };
  if (process.env.OPENROUTER_API_KEY) return { key: process.env.OPENROUTER_API_KEY, provider: 'openrouter' };
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

function findApplicationByUrl(url, userEmail = null) {
  const normalize = p => p.replace(/\/(apply|application)$/, '');
  try {
    for (const f of fs.readdirSync(APPS_DIR).filter(f => f.endsWith('.json'))) {
      const app = JSON.parse(fs.readFileSync(path.join(APPS_DIR, f), 'utf-8'));
      if (userEmail && app.user_email && app.user_email !== userEmail) continue;
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

function loadKit(id, userEmail) {
  const p = path.join(APPS_DIR, `${id}.json`);
  const legacyPath = path.join(__dirname, '../apply-kits', `${id}.json`);
  let kit = null;
  for (const fp of [p, legacyPath]) {
    if (fs.existsSync(fp)) {
      try { kit = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { return null; }
      break;
    }
  }
  if (!kit) return null;
  if (userEmail && kit.user_email && kit.user_email !== userEmail) return 'forbidden';
  return kit;
}

async function fetchATSFormQuestions(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const parts = u.pathname.split('/').filter(Boolean);
    // Best-effort board-token guess for ATS widgets embedded on a company's own
    // careers domain (e.g. databricks.com/...?gh_jid=123) — usually matches.
    const guessSlug = () => host.replace(/^www\./, '').split('.')[0].toLowerCase();

    // Greenhouse: job-boards.greenhouse.io/<company>/jobs/<id>, or an embed
    // widget on the company's own domain carrying ?gh_jid=<id>
    if (host.includes('greenhouse.io')) {
      const jobIdx = parts.indexOf('jobs');
      if (jobIdx !== -1 && parts[0] && parts[jobIdx + 1]) {
        const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${parts[0]}/jobs/${parts[jobIdx + 1]}`, { signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          const data = await r.json();
          const skip = new Set(['first_name','last_name','email','phone','resume','cover_letter','location','linkedin_profile','website']);
          return (data.questions || [])
            .filter(q => q.label && !skip.has(q.fields?.[0]?.name))
            .map(q => q.label);
        }
      }
    } else if (u.searchParams.has('gh_jid')) {
      const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${guessSlug()}/jobs/${u.searchParams.get('gh_jid')}`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const data = await r.json();
        const skip = new Set(['first_name','last_name','email','phone','resume','cover_letter','location','linkedin_profile','website']);
        return (data.questions || [])
          .filter(q => q.label && !skip.has(q.fields?.[0]?.name))
          .map(q => q.label);
      }
    }

    // Lever: jobs.lever.co/<company>/<id>, or an embed carrying ?lever_job_id=<id>
    if (host.includes('lever.co') && parts.length >= 2) {
      const r = await fetch(`https://api.lever.co/v0/postings/${parts[0]}/${parts[1]}?mode=json`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const data = await r.json();
        const questions = [];
        if (data.additionalPlain) {
          data.additionalPlain.split('\n').forEach(function(l) { l = l.trim(); if (l.endsWith('?') && l.length > 10) questions.push(l); });
        }
        return questions;
      }
    } else if (u.searchParams.has('lever_job_id')) {
      const r = await fetch(`https://api.lever.co/v0/postings/${guessSlug()}/${u.searchParams.get('lever_job_id')}?mode=json`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const data = await r.json();
        const questions = [];
        if (data.additionalPlain) {
          data.additionalPlain.split('\n').forEach(function(l) { l = l.trim(); if (l.endsWith('?') && l.length > 10) questions.push(l); });
        }
        return questions;
      }
    }

    // Ashby: try scraping the /application page for form labels, or an embed
    // carrying ?ashby_jid=<id> on the company's own domain
    if (host.includes('ashbyhq.com') && parts.length >= 2) {
      const base = url.split('?')[0].replace(/\/application$/, '');
      const r = await fetch(base + '/application', {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      });
      if (r.ok) {
        const html = await r.text();
        const skip = new Set(['First Name','Last Name','Email','Phone','Resume','LinkedIn Profile','Website','Cover Letter','Location','City','Country']);
        const found = [];
        let m, re = /<label[^>]*>([^<]{8,300})<\/label>/gi;
        while ((m = re.exec(html)) !== null) {
          const label = m[1].replace(/\s+/g, ' ').replace(/<[^>]+>/g, '').trim().replace(/\s*\*\s*$/, '');
          if (label && !skip.has(label) && found.length < 12) found.push(label);
        }
        return found;
      }
    } else if (u.searchParams.has('ashby_jid')) {
      const r = await fetch(`https://jobs.ashbyhq.com/${guessSlug()}/${u.searchParams.get('ashby_jid')}/application`, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      });
      if (r.ok) {
        const html = await r.text();
        const skip = new Set(['First Name','Last Name','Email','Phone','Resume','LinkedIn Profile','Website','Cover Letter','Location','City','Country']);
        const found = [];
        let m, re = /<label[^>]*>([^<]{8,300})<\/label>/gi;
        while ((m = re.exec(html)) !== null) {
          const label = m[1].replace(/\s+/g, ' ').replace(/<[^>]+>/g, '').trim().replace(/\s*\*\s*$/, '');
          if (label && !skip.has(label) && found.length < 12) found.push(label);
        }
        return found;
      }
    }
  } catch {}
  return null; // null = unknown (let generate decide); [] = confirmed no extra questions
}

async function fetchJobPageText(url) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });
    if (!r.ok) return null;
    const html = await r.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 6000);
    return text.length > 200 ? text : null;
  } catch { return null; }
}

async function callClaude(prompt, maxTokens = 4096, model = null) {
  if (!keys) throw new Error('No API key configured');
  if (keys.provider === 'openrouter') {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${keys.key}`, 'Content-Type': 'application/json', 'HTTP-Referer': APP_ORIGIN },
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
  res.json({ status: 'ok', version: VERSION, applications: count, ai: !!keys, provider: keys?.provider });
});

// Lookup a previously generated application by job URL
app.get('/application', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url param required' });
  const app = findApplicationByUrl(url, reqUserEmail(req));
  if (app) return res.json(app);
  res.status(404).json({ error: 'No application found' });
});

app.get('/application/:id', (req, res) => {
  const kit = loadKit(req.params.id, reqUserEmail(req));
  if (!kit) return res.status(404).json({ error: 'Not found' });
  if (kit === 'forbidden') return res.status(403).json({ error: 'Forbidden' });
  res.json(kit);
});

app.get('/applications', (req, res) => {
  try {
    const userEmail = reqUserEmail(req);
    let apps = loadApps();
    if (userEmail) apps = apps.filter(a => !a.user_email || a.user_email === userEmail);
    res.json(apps.map(({ id, company, role, url, tier, fit_score, sourced_date, applied_at }) => ({
      id, company, role, url, tier, fit_score, sourced_date, applied_at
    })).sort((a, b) => (b.fit_score || 0) - (a.fit_score || 0)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AI field-mapping — accepts optional screenshot for visual form analysis
app.post('/analyze', apiLimiter, requireCredits('analyze'), async (req, res) => {
  const { appId, kitId, fields, screenshot } = req.body;
  const id = appId || kitId;
  if (!id || !fields) return res.status(400).json({ error: 'appId and fields required' });
  if (!keys) return res.status(503).json({ error: 'No API key found' });

  const kitResult = loadKit(id, reqUserEmail(req));
  if (!kitResult) return res.status(404).json({ error: 'Application not found' });
  if (kitResult === 'forbidden') return res.status(403).json({ error: 'Forbidden' });
  const appData = kitResult;

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

// ── Jobs API (DB-backed) ──────────────────────────────────────────────────────

function reqUserEmail(req) {
  if (req.userEmail) return req.userEmail;
  // try to resolve from auth header without requireCredits middleware
  const bearer = req.headers['authorization']?.match(/^Bearer (.+)/)?.[1]
    || (req.headers['x-api-key']?.startsWith('eyJ') ? req.headers['x-api-key'] : null);
  if (bearer) { const p = verifySession(bearer); if (p) return p.email; }
  if (isLocalRequest(req)) return 'wittman.c@gmail.com'; // local mode = Chad
  return null;
}

app.get('/sourced', async (req, res) => {
  try {
    const status = req.query.status || null;
    res.json(await db.getJobs(status, 200, reqUserEmail(req)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/sourced/counts', async (req, res) => {
  try { res.json(await db.getStatusCounts(reqUserEmail(req))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/runs', async (req, res) => {
  try { res.json(await db.getRuns(50, reqUserEmail(req))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/runs/:id/jobs', async (req, res) => {
  try { res.json(await db.getJobsForRun(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/sourced/status', async (req, res) => {
  const { url, status } = req.body;
  if (!url || !status) return res.status(400).json({ error: 'url and status required' });
  const valid = ['new', 'reviewed', 'applying', 'applied', 'skipped', 'rejected'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'invalid status' });
  try {
    await db.setJobStatus(url, status, { applied_at: status === 'applied' ? new Date().toISOString().slice(0, 10) : undefined });
    await db.recordDecision(url, reqUserEmail(req), status);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/sourced/mark-reviewed', async (req, res) => {
  const { ids } = req.body;
  if (!ids?.length) return res.status(400).json({ error: 'ids required' });
  try {
    const jobs = await db.getJobs('new', 500, reqUserEmail(req));
    const idSet = new Set(ids);
    for (const j of jobs) { if (idSet.has(j.id)) await db.setJobStatus(j.url, 'reviewed'); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/sourced/skip', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try { await db.setJobStatus(url, 'skipped'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/sourced/mark-applied', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    await db.setJobStatus(url, 'applied', { applied_at: new Date().toISOString().slice(0, 10) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Per-user pending-generate map — key is user email, clears on read
const pendingGenerateMap = new Map();

app.post('/sourced/pending-generate', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const email = reqUserEmail(req) || '__anon__';
  pendingGenerateMap.set(email, url);
  res.json({ ok: true });
});

app.get('/sourced/pending-generate', (req, res) => {
  const email = reqUserEmail(req) || '__anon__';
  const url = pendingGenerateMap.get(email) || null;
  pendingGenerateMap.delete(email);
  res.json({ url });
});

app.post('/applied', async (req, res) => {
  const { appId, kitId, company, role, url } = req.body;
  const id = appId || kitId;
  if (!id) return res.status(400).json({ error: 'appId required' });

  const appliedAt = new Date().toISOString().slice(0, 10);

  // Update the application JSON kit file
  const userEmail = reqUserEmail(req);
  const kitData = loadKit(id, userEmail);
  if (kitData && kitData !== 'forbidden') {
    kitData.applied_at = appliedAt;
    const kitPath = path.join(APPS_DIR, `${id}.json`);
    if (fs.existsSync(kitPath)) fs.writeFileSync(kitPath, JSON.stringify(kitData, null, 2));
  }

  // Update DB status (authoritative)
  if (url) try { await db.setJobStatus(url, 'applied', { applied_at: appliedAt }); } catch {}

  console.log(`Applied: ${company} — ${role} (${appliedAt})`);
  res.json({ ok: true, applied_at: appliedAt });
});

app.get('/applied', async (req, res) => {
  try {
    const jobs = await db.getJobs('applied', 500, reqUserEmail(req));
    res.json(jobs.map(({ id, company, role, url, applied_at }) => ({ appId: id, company, role, url, applied_at })));
  } catch (e) { res.json([]); }
});

app.get('/status', async (req, res) => {
  try {
    const counts = await db.getStatusCounts(reqUserEmail(req));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    res.json({ ...counts, total });
  } catch { res.json({ new: 0, reviewed: 0, applied: 0, skipped: 0, total: 0 }); }
});

// Generate an application on demand from a job page
app.post('/generate', apiLimiter, requireCredits('generate'), async (req, res) => {
  let { url, company, role, description, ats, force, form_questions, note } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!keys) return res.status(503).json({ error: 'No API key configured' });

  const userEmail = reqUserEmail(req);

  // If no description provided (URL-prepend flow), scrape page + fetch real ATS questions
  if (!description) {
    [description, form_questions] = await Promise.all([
      fetchJobPageText(url),
      form_questions !== undefined ? Promise.resolve(form_questions) : fetchATSFormQuestions(url),
    ]);
    console.log(`[scrape] ${url} — ${description ? description.length + ' chars' : 'no content'} | questions: ${JSON.stringify(form_questions)}`);
  }

  // Return cached application if it exists (unless force regenerate)
  if (!force) {
    const cached = findApplicationByUrl(url, userEmail);
    if (cached) {
      console.log(`Cache hit: ${cached.company} — ${cached.role}`);
      return res.json(cached);
    }
  } else {
    // Delete any existing application for this URL so we regenerate fresh
    const existing = findApplicationByUrl(url, userEmail);
    if (existing) {
      const p = path.join(APPS_DIR, `${existing.id}.json`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
      console.log(`Force regenerate: deleted ${existing.id}`);
    }
  }

  const profile = await resolveProfile(req);
  const candidateName = `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'the candidate';
  const bio = profile.bio || `${candidateName} has not set up their background bio yet. Generate placeholder apply kit and note they should complete their profile at /setup.`;

  const qaInstruction = Array.isArray(form_questions) && form_questions.length > 0
    ? `QA INSTRUCTIONS — CRITICAL: The application form has these EXACT questions. Answer ONLY these questions using the candidate's real background and numbers. Do not invent others.
${form_questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    : Array.isArray(form_questions) && form_questions.length === 0
    ? `QA INSTRUCTIONS: We could not detect the actual form questions. Set "qa" to an empty array []. Do not invent questions.`
    : `QA INSTRUCTIONS: Generate 2-3 likely screening questions specific to this exact role and company. Do not use generic questions.`;

  const noteInstruction = note ? `\n\nSPECIAL DIRECTION FOR THIS GENERATION: ${note}` : '';

  const prompt = `Generate a job application for ${candidateName} applying to this role.${noteInstruction}

CANDIDATE BACKGROUND:
${bio}

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
  "fit_score": <6-9 based on how well it matches the candidate's background>,
  "tier": <1 if fit_score 9, 2 if 7-8, 3 if 6>,
  "warm_path": "<how the candidate might get a warm intro, or 'Cold apply' if none obvious>",
  "profile": {
    "first_name": ${JSON.stringify(profile.first_name || '')},
    "last_name": ${JSON.stringify(profile.last_name || '')},
    "email": ${JSON.stringify(profile.email || '')},
    "phone": ${JSON.stringify(profile.phone || '')},
    "linkedin": ${JSON.stringify(profile.linkedin || '')},
    "location": ${JSON.stringify(profile.location || '')},
    "work_authorization": ${JSON.stringify(profile.work_authorization || '')},
    "salary": "<appropriate number as string, no $ or commas>",
    "website": ${JSON.stringify(profile.website || '')},
    "current_employer": ${JSON.stringify(profile.current_employer || '')},
    "github": ${JSON.stringify(profile.github || '')},
    "twitter": ${JSON.stringify(profile.twitter || '')},
    "school": ${JSON.stringify(profile.school || '')}
  },
  "tailored": {
    "headline": "<one sentence, direct, specific to this role — lead with the most relevant angle from the candidate's background, not a generic claim. No em dashes.>",
    "why_role": "<2-3 paragraphs. Pick the opener from the candidate's most relevant experience for this specific role. Apply all WRITING RULES below.>",
    "cover_note": "<2 paragraphs. Who the candidate is (their background, companies, wins) and what specifically draws them to this role and company. Apply all WRITING RULES below.>",
    "qa": [
      {"q": "<question per QA INSTRUCTIONS above>", "a": "<2-4 sentences. Specific evidence from the candidate's actual work. Concrete numbers where they exist. Apply all WRITING RULES below.>"}
    ]
  }
}

WRITING RULES — apply to every word of why_role, cover_note, and qa answers:

Voice: Write like a confident, informal person typing quickly — not a cover letter template. Short sentences mixed with longer ones. Uneven paragraph lengths. First-person but not self-congratulatory.

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

Concrete over abstract: "built a pipeline that drove 4.5x revenue per title as CPMs fell 40%" not "drove significant growth". Names, numbers, mechanisms beat adjectives. Use active voice. Verbs do the work — "decided" not "made a decision".`;

  try {
    const raw = await callClaude(prompt, 4096, 'claude-sonnet-4-6');
    const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
    if (!parsed.id) throw new Error('Invalid response: missing id');
    // Strip em/en dashes from all generated text — model sometimes ignores the prompt rule
    const generated = cleanEmDashes(parsed);

    // Save to applications/
    if (userEmail) generated.user_email = userEmail;
    fs.writeFileSync(path.join(APPS_DIR, `${generated.id}.json`), JSON.stringify(generated, null, 2));
    await db.setKitGenerated(url);

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

  const coverKit = loadKit(id, reqUserEmail(req));
  if (!coverKit) return res.status(404).json({ error: 'Application not found' });
  if (coverKit === 'forbidden') return res.status(403).json({ error: 'Forbidden' });
  const appData = coverKit;

  const t = appData.tailored;
  const appProfile = appData.profile || {};
  const coverName = `${appProfile.first_name || 'the candidate'} ${appProfile.last_name || ''}`.trim();
  const prompt = `Write a full cover letter for ${coverName} applying to ${appData.role} at ${appData.company}.

Background context: ${t.why_role}

Seed themes (use as inspiration only, not as copy to paste): ${t.cover_note}

Structure:
- Opening (1-2 sentences): specific and concrete about this company or role. No generic opener.
- Middle (2 paragraphs): the candidate's actual work mapped to what this role needs. Name the products, numbers, companies.
- Close (2-3 sentences): confident, direct. No "I look forward to hearing from you."
- Sign off: ${coverName}

Length: 250-320 words total. No bullet points, lists, or headers. Rewrite from scratch — do not copy seed phrasing verbatim.

WRITING RULES — every violation is a failure:
Voice: Confident, informal person typing quickly. Short sentences mixed with longer ones. Uneven paragraph lengths. First-person but not self-congratulatory.
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
    const voiceKit = loadKit(id, reqUserEmail(req));
    const appData = (voiceKit && voiceKit !== 'forbidden') ? voiceKit : null;
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

// Quick answer — generate a response to a spoken question using the user's background
app.post('/quick-answer', requireCredits('voice'), async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });
  if (!keys) return res.status(503).json({ error: 'No API key' });

  const profile = await resolveProfile(req);
  const candidateName = `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'the candidate';
  const bio = profile.bio || `${candidateName} — background not set up.`;

  const prompt = `Generate a concise, authentic answer for ${candidateName} to the following question from a job application or interview.

CANDIDATE BACKGROUND:
${bio}

QUESTION: ${question}

WRITING RULES:
- 3-5 sentences. Direct and specific.
- Pull from real companies, products, and numbers in the candidate's background
- Voice: confident, informal, first-person, not self-congratulatory
- No em dashes. No "excited/passionate/thrilled". No trailing -ing clauses.
- End on a concrete point, not a summary
- Return only the answer text, no preamble`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': keys.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 512, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}`);
    const text = (await r.json()).content[0].text.trim();
    res.json({ text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Clear all job data
app.post('/clear', (req, res) => {
  try {
    const clearEmail = reqUserEmail(req);
    // Delete only this user's kit files
    if (fs.existsSync(APPS_DIR)) {
      for (const f of fs.readdirSync(APPS_DIR).filter(f => f.endsWith('.json'))) {
        try {
          const kit = JSON.parse(fs.readFileSync(path.join(APPS_DIR, f), 'utf-8'));
          if (!clearEmail || !kit.user_email || kit.user_email === clearEmail) {
            fs.unlinkSync(path.join(APPS_DIR, f));
          }
        } catch {}
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
    const { spawn } = require('child_process');
    if (!fs.existsSync(path.join(__dirname, '../logs'))) fs.mkdirSync(path.join(__dirname, '../logs'), { recursive: true });
    const sourceScript = path.join(__dirname, '../source.js');

    // Run for each user with sourcing configured; fall back to anonymous (Chad's local run)
    db.getProfiledUsers().then(profiledUsers => {
    const toRun = profiledUsers.length ? profiledUsers : [null];
    toRun.forEach((email, i) => {
      const logFile = SOURCE_LOG_FILE + (email ? `.${email.split('@')[0]}` : '');
      const ls = fs.createWriteStream(logFile, { flags: 'w' });
      const child = spawn('node', [sourceScript], {
        cwd: path.join(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        env: { ...process.env, ...(email ? { JAA_USER_EMAIL: email } : {}) },
      });
      child.stdout.pipe(ls);
      child.stderr.pipe(ls);
      const cronKey = email || '__local__';
      sourcingPids.set(cronKey, child.pid);
      child.unref();
      child.on('exit', (code) => {
        sourcingPids.delete(cronKey);
        ls.end();
        console.log(`[cron] source complete for ${email || 'anonymous'}, exit ${code}`);
        if (email) {
          const pipelineUrl = 'https://applyapplyapply.replit.app/pipeline';
          sendEmail(email, 'applyapply — daily sourcing complete',
            `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:40px auto;padding:32px;background:#fff;border:1px solid #e5e5e5;border-radius:8px">
              <h2 style="font-size:16px;font-weight:700;margin-bottom:10px">Daily sourcing finished</h2>
              <p style="color:#555;font-size:14px;margin-bottom:20px">Your daily job sourcing run completed. Check your pipeline for new leads.</p>
              <a href="${pipelineUrl}" style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600">View pipeline →</a>
            </div>`,
            `Daily sourcing complete. View pipeline: ${pipelineUrl}`
          ).catch(() => {});
        }
      });
    }); // end toRun.forEach
    }).catch(e => console.error('[cron] getProfiledUsers:', e.message));
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
// Per-user sourcing pid map — key is userEmail or '__local__' for anonymous
const sourcingPids = new Map();
// Legacy single-pid accessor for cron status endpoint
function getSourcingPid() { return sourcingPids.size > 0 ? [...sourcingPids.values()][0] : null; }

app.get('/source/status', async (req, res) => {
  const userEmail = reqUserEmail(req);
  const key = userEmail || '__local__';
  const active = sourcingPids.has(key);
  try {
    const counts = await db.getStatusCounts(userEmail);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const runs = await db.getRuns(1, userEmail);
    const last_sourced = runs[0]?.date || null;
    res.json({ active, last_sourced, counts, total });
  } catch {
    res.json({ active, last_sourced: null, counts: {}, total: 0 });
  }
});

const SOURCE_LOG_FILE = path.join(__dirname, '../logs/last-run.log');

app.get('/source/catalog', (req, res) => {
  res.json(SOURCE_CATALOG);
});

app.post('/source/run', apiLimiter, async (req, res) => {
  const userEmail = reqUserEmail(req);
  const pidKey = userEmail || '__local__';
  if (sourcingPids.has(pidKey)) return res.json({ status: 'already_running' });

  // Resolve which sources to run
  const requestedNames = Array.isArray(req.body?.sources) && req.body.sources.length
    ? req.body.sources
    : SOURCE_CATALOG.filter(s => s.on).map(s => s.name);

  const selectedSources = SOURCE_CATALOG.filter(s => requestedNames.includes(s.name));
  if (!selectedSources.length) return res.status(400).json({ error: 'no valid sources selected' });

  const totalCredits = selectedSources.reduce((n, s) => n + s.credits, 0);

  // Manual credit check (replaces requireCredits since cost is dynamic)
  const auth = authFromRequest(req);
  if (auth.type === 'jwt') {
    const user = await db.getUser(auth.email);
    if (!user) return res.status(401).json({ error: 'user not found' });
    if (user.credits < totalCredits) return res.status(402).json({ error: 'Insufficient credits', balance: user.credits, required: totalCredits });
    await db.deductUserCredits(auth.email, totalCredits);
  } else if (auth.type === 'apikey') {
    const users = loadUsers();
    const user = users[auth.apiKey];
    if (!user) return res.status(401).json({ error: 'invalid key' });
    if (user.balance < totalCredits) return res.status(402).json({ error: 'Insufficient credits', balance: user.balance, required: totalCredits });
    user.balance -= totalCredits;
    saveUsers(users);
  }
  // local mode: no credit check

  const { spawn } = require('child_process');
  if (!fs.existsSync(path.join(__dirname, '../logs'))) fs.mkdirSync(path.join(__dirname, '../logs'), { recursive: true });
  const logFile = SOURCE_LOG_FILE + (userEmail ? `.${userEmail.split('@')[0]}` : '');
  const logStream = fs.createWriteStream(logFile, { flags: 'w' });
  // Keep last-run.log pointing to most recent run for the stream endpoint
  const mainLogStream = fs.createWriteStream(SOURCE_LOG_FILE, { flags: 'w' });
  const sourceScript = path.join(__dirname, '../source.js');
  const child = spawn('node', [sourceScript], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      ...(userEmail ? { JAA_USER_EMAIL: userEmail } : {}),
      JAA_ENABLED_SOURCES: JSON.stringify(selectedSources.map(s => s.name)),
      ...(Array.isArray(req.body?.roles) && req.body.roles.length ? { JAA_TARGET_ROLES: req.body.roles.join(', ') } : {}),
    },
  });
  child.stdout.pipe(logStream);
  child.stdout.pipe(mainLogStream);
  child.stderr.pipe(logStream);
  child.stderr.pipe(mainLogStream);
  sourcingPids.set(pidKey, child.pid);
  child.unref();
  const runEmail = userEmail;
  child.on('exit', async (code) => {
    sourcingPids.delete(pidKey);
    logStream.end();
    mainLogStream.end();
    console.log('[source] run complete, exit', code);
    if (runEmail) {
      const pipelineUrl = `${req.protocol}://${req.get('host')}/pipeline`;
      sendEmail(runEmail, 'applyapply — sourcing run complete',
        `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:40px auto;padding:32px;background:#fff;border:1px solid #e5e5e5;border-radius:8px">
          <h2 style="font-size:16px;font-weight:700;margin-bottom:10px">Sourcing run finished</h2>
          <p style="color:#555;font-size:14px;margin-bottom:20px">Your sourcing run completed. Check your pipeline for new leads.</p>
          <a href="${pipelineUrl}" style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600">View pipeline →</a>
        </div>`,
        `Sourcing run complete. View pipeline: ${pipelineUrl}`
      ).catch(() => {});
    }
  });
  console.log(`[source] started pid ${child.pid}, ${totalCredits} credits charged for [${selectedSources.map(s=>s.name).join(', ')}]`);
  res.json({ status: 'started', pid: child.pid, credits_charged: totalCredits, sources: selectedSources.map(s => s.name) });
});

app.get('/source/log', (req, res) => {
  try {
    const text = fs.existsSync(SOURCE_LOG_FILE) ? fs.readFileSync(SOURCE_LOG_FILE, 'utf-8') : '(no log yet)';
    res.type('text/plain').send(text);
  } catch { res.status(500).send('error reading log'); }
});

app.get('/source/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  let pos = 0;
  const send = () => {
    try {
      if (!fs.existsSync(SOURCE_LOG_FILE)) return;
      const stat = fs.statSync(SOURCE_LOG_FILE);
      if (stat.size <= pos) return;
      const buf = Buffer.alloc(stat.size - pos);
      const fd = fs.openSync(SOURCE_LOG_FILE, 'r');
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      pos = stat.size;
      const lines = buf.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) res.write(`data: ${JSON.stringify(line)}\n\n`);
      }
    } catch {}
  };

  const iv = setInterval(send, 400);
  req.on('close', () => clearInterval(iv));
});

// ── Sourcing audit page ───────────────────────────────────────────────────────

app.get('/sourcing', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const detailFile = path.join(__dirname, '../logs/last-run-detail.json');
  const FEEDBACK_FILE_LOCAL = path.join(__dirname, '../logs/audit-feedback.json');
  const HEALTH_FILE = path.join(__dirname, '../logs/source-health.json');
  let data = null, feedback = [], healthData = [];
  try { data = fs.existsSync(detailFile) ? JSON.parse(fs.readFileSync(detailFile, 'utf-8')) : null; } catch {}
  try { feedback = fs.existsSync(FEEDBACK_FILE_LOCAL) ? JSON.parse(fs.readFileSync(FEEDBACK_FILE_LOCAL, 'utf-8')) : []; } catch {}
  try { healthData = fs.existsSync(HEALTH_FILE) ? JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf-8')) : []; } catch {}
  const profile = await resolveProfile(req).catch(() => PROFILE);
  const savedRoles = (profile.target_roles || '').split(',').map(r => r.trim().toLowerCase()).filter(Boolean);

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

  // Kit detection: build set of normalized URLs that have generated kits
  const normUrl = u => { try { const p = new URL(u); return p.hostname + p.pathname.replace(/\/(apply|application)$/, '').replace(/\/$/, ''); } catch { return u; } };
  const kitUrlSet = new Set(loadApps().flatMap(a => [a.url, ...(a.urls||[])].filter(Boolean).map(normUrl)));

  // Opened tracking: load click history
  const OPENED_FILE = path.join(__dirname, '../logs/opened.json');
  let openedSet = new Set();
  try { JSON.parse(fs.readFileSync(OPENED_FILE, 'utf-8')).forEach(o => openedSet.add(o.url)); } catch {}

  const alertBanners = [];
  const sourcesHtml = !data?.sources?.length
    ? `<div class="onboard">
        <div class="onboard-title">This page finds jobs for you automatically.</div>
        <p class="onboard-body">Sourcing searches the job boards below for titles matching your profile
          (right now: ${savedRoles.length ? savedRoles.map(esc).join(', ') : 'set your target roles in <a href="/setup">profile</a> first'}),
          scores each result against your background, and drops the good ones here — ranked, deduped, ready to open.
          Each source costs a few credits per run; you'll see the total before confirming.</p>
        <button class="btn onboard-cta" onclick="toggleSourcePanel()">Choose roles &amp; sources → run sourcing</button>
        <p class="onboard-alt">Already have a specific posting? Skip sourcing — use the Chrome extension on the job page,
          or put this site's domain in front of the job URL in your address bar to generate a kit directly.</p>
      </div>`
    : data.sources.map(src => {
        const jobs = src.jobs || [];
        const fitJobs = jobs.filter(j => j.outcome === 'added');
        const otherJobs = jobs.filter(j => j.outcome !== 'added');
        const nTotal = src.rawCount ?? jobs.length;

        // Loud failure alert
        const hist = (healthBySrc[src.name] || []).slice(-5);
        if (hist.length >= 3 && hist.slice(-3).every(h => h.found === 0)) {
          alertBanners.push(`<div class="alert-banner">⚠ ${esc(src.name)} has returned 0 results for ${hist.slice(-3).length} runs in a row</div>`);
        }
        const histHtml = hist.length >= 2
          ? `<span class="src-hist">${hist.map(h => `<span class="hist-dot ${h.added>0?'hdot-ok':h.found>0?'hdot-meh':'hdot-zero'}" title="${h.date}: ${h.found} found, ${h.added} fit">${h.added>0?h.added:h.found>0?'·':'○'}</span>`).join('')}</span>`
          : '';

        const kitCount = fitJobs.filter(j => kitUrlSet.has(normUrl(j.url))).length;
        const openedCount = fitJobs.filter(j => openedSet.has(j.url)).length;

        const statParts = [
          `${nTotal} checked`,
          fitJobs.length ? `<strong>${fitJobs.length} fit</strong>` : '0 fit',
          kitCount ? `${kitCount} kit${kitCount>1?'s':''}` : '',
          openedCount ? `${openedCount} opened` : '',
        ].filter(Boolean).join(' · ');

        const makeFitRow = j => {
          const hasKit = kitUrlSet.has(normUrl(j.url));
          const wasOpened = openedSet.has(j.url);
          return `<div class="fit-row">
            <a href="${esc(j.url)}" target="_blank" class="fit-link" onclick="trackOpen('${esc(j.url)}')">${esc(j.company||'')} — ${esc(j.role||'')}</a>
            <span class="fit-badges">${hasKit?'<span class="badge b-kit">kit</span>':''}${wasOpened?'<span class="badge b-opened">opened</span>':''}</span>
          </div>`;
        };

        const makeOtherRow = j => {
          const label = {dupe:'dupe',cross_dupe:'dupe',role_mismatch:'mismatch',low_fit:'low fit',excluded:'excluded',url_dead:'dead'}[j.outcome]||j.outcome;
          return `<div class="other-row"><span class="other-lbl">${label}</span><a href="${esc(j.url)}" target="_blank" class="other-link" onclick="trackOpen('${esc(j.url)}')">${esc(j.company||'')} — ${esc(j.role||'')}</a></div>`;
        };

        const fitHtml = fitJobs.length
          ? fitJobs.map(makeFitRow).join('')
          : '<div class="no-fit">nothing new this run</div>';

        const otherId = 'oth-' + src.name.replace(/[^a-z0-9]/gi,'_');
        const otherHtml = otherJobs.length
          ? `<button class="other-toggle" onclick="var d=document.getElementById('${otherId}');var open=d.style.display!=='none';d.style.display=open?'none':'block';this.textContent=open?'+ ${otherJobs.length} others (dupes, filtered)':'− hide others'">+ ${otherJobs.length} others (dupes, filtered)</button>
             <div class="other-list" id="${otherId}" style="display:none">${otherJobs.map(makeOtherRow).join('')}</div>`
          : '';

        return `<div class="src-card">
          <div class="src-card-hd">
            <span class="src-card-name">${esc(src.name)}</span>
            <span class="src-card-stats">${statParts}</span>
            ${histHtml}
          </div>
          <div class="src-fit-list">${fitHtml}</div>
          ${otherHtml}
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
<title>sourcing</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#ccc;font-size:13px;min-height:100vh}
.topbar{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid #181818;flex-wrap:wrap}
.topbar-title{font-size:13px;font-weight:600;color:#fff}
.topbar-meta{font-size:11px;color:#444;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar-sched{font-size:11px;color:#2a2a2a}
.run-btn{padding:8px 16px;background:#fff;color:#000;border:none;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap}
.run-btn:hover{background:#e5e5e5}
.run-btn:disabled{opacity:.35;cursor:default}
.sdot{width:6px;height:6px;border-radius:50%;background:#2a2a2a;flex-shrink:0}
.sdot.active{background:#f59e0b;animation:pulse 1.4s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.alert-banner{margin:0 24px;margin-top:12px;padding:8px 12px;background:#1a0a0a;border:1px solid #3a1a1a;font-size:11px;color:#b45309}
.body{padding:28px 24px 48px;display:flex;flex-direction:column;gap:0}
/* source cards */
.src-card{padding:20px 0;border-bottom:1px solid #111}
.src-card-hd{display:flex;align-items:baseline;gap:12px;margin-bottom:12px}
.src-card-name{font-size:13px;font-weight:700;color:#fff}
.src-card-stats{font-size:11px;color:#555;flex:1}
.src-card-stats strong{color:#fff}
.src-hist{display:flex;gap:3px;align-items:center}
.hist-dot{font-size:10px;width:14px;text-align:center;cursor:default}
.hdot-ok{color:#4ade80}.hdot-meh{color:#444}.hdot-zero{color:#1e1e1e}
/* fit rows */
.fit-row{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #0a0a0a}
.fit-link{color:#fff;font-size:13px;text-decoration:none;flex:1}
.fit-link:hover{text-decoration:underline}
.fit-badges{display:flex;gap:4px;flex-shrink:0}
.badge{font-size:9px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:2px 5px}
.b-kit{background:#0a1e0d;color:#4ade80}
.b-opened{background:#0a1020;color:#60a5fa}
.no-fit{font-size:12px;color:#333;padding:8px 0}
/* others */
.other-toggle{background:none;border:none;font-size:11px;color:#333;cursor:pointer;padding:10px 0 0;font-family:inherit;text-align:left}
.other-toggle:hover{color:#888}
.other-list{padding:6px 0}
.other-row{display:flex;gap:10px;padding:3px 0;align-items:baseline}
.other-lbl{font-size:10px;color:#2a2a2a;width:58px;flex-shrink:0;text-align:right}
.other-link{color:#333;font-size:11px;text-decoration:none}
.other-link:hover{color:#888}
.empty{padding:48px 0;color:#333;font-size:13px}
.onboard{padding:40px 0 48px;max-width:480px}
.onboard-title{font-size:16px;font-weight:700;letter-spacing:-.02em;color:#fff;margin-bottom:10px}
.onboard-body{font-size:13px;line-height:1.7;color:#888;margin-bottom:20px}
.onboard-body a{color:#fff;text-decoration:underline}
.onboard-cta{padding:9px 18px;background:#fff;color:#000;font-size:12px;font-weight:700;border:none;cursor:pointer;font-family:inherit;letter-spacing:-.01em;margin-bottom:18px}
.onboard-cta:hover{background:#e0e0e0}
.onboard-alt{font-size:11px;color:#444;line-height:1.6}
.onboard-alt a{color:#666;text-decoration:underline}
.missed-section{border-top:1px solid #111;padding:24px 0 0;margin-top:8px}
.missed-label{font-size:11px;color:#555;margin-bottom:8px}
.missed-row{display:flex;gap:8px}
.missed-input{flex:1;background:#111;border:1px solid #1e1e1e;color:#fff;font-size:12px;padding:6px 10px;outline:none;font-family:inherit}
.missed-input:focus{border-color:#333}
.missed-btn{padding:6px 12px;background:none;color:#555;border:1px solid #1e1e1e;font-size:11px;cursor:pointer;font-family:inherit}
.missed-btn:hover{color:#fff;border-color:#555}
@media(max-width:600px){
  .topbar{padding:12px 16px;gap:8px}
  .topbar-sched{display:none}
  .body{padding:20px 16px 60px}
  .src-card-hd{flex-wrap:wrap;gap:6px}
  .src-hist{display:none}
  .fit-row{gap:8px}
  .fit-link{font-size:14px}
  .other-lbl{display:none}
  .missed-row{flex-direction:column}
  .missed-input,.missed-btn{width:100%}
  .missed-btn{padding:10px;text-align:center}
  #source-panel{padding:14px 16px}
  .src-footer{flex-direction:column;gap:10px;align-items:stretch}
  .run-confirm-btn{text-align:center;padding:12px}
}
#source-panel{display:none;border-bottom:1px solid #181818;padding:14px 24px;background:#060606}
.panel-section-label{font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#333;margin-bottom:8px;margin-top:14px}
.panel-section-label:first-child{margin-top:0}
.role-grid{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px}
.role-chip{display:flex;align-items:center;gap:5px;padding:4px 8px;border:1px solid #1e1e1e;background:#0a0a0a;cursor:pointer;font-size:11px;color:#666;user-select:none}
.role-chip input[type=checkbox]{accent-color:#3b82f6;width:11px;height:11px;flex-shrink:0;cursor:pointer;margin:0}
.role-chip.checked{border-color:#2a3a2a;background:#080d08;color:#aaa}
.role-chip-custom{margin-top:6px;display:flex;align-items:center;gap:6px}
.role-chip-custom input[type=text]{flex:1;background:#111;border:1px solid #1e1e1e;color:#ccc;font-size:11px;padding:4px 8px;outline:none;font-family:inherit}
.role-chip-custom input[type=text]::placeholder{color:#333}
.src-sel-grid{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
.src-sel-row{display:flex;align-items:center;gap:8px;font-size:11px}
.src-sel-row input[type=checkbox]{accent-color:#3b82f6;width:13px;height:13px;flex-shrink:0;cursor:pointer}
.src-sel-name{color:#aaa;flex:1;cursor:pointer}
.src-sel-cost{color:#444;font-size:10px;width:60px;text-align:right;flex-shrink:0}
.src-sel-type{font-size:9px;color:#2a2a2a;width:42px;text-align:right;flex-shrink:0;text-transform:uppercase;letter-spacing:.04em}
.src-footer{display:flex;align-items:center;justify-content:space-between;padding-top:10px;border-top:1px solid #161616}
.src-total{font-size:11px;color:#555}
.src-total strong{color:#ccc}
.run-confirm-btn{padding:5px 14px;background:#fff;color:#0a0a0a;border:none;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer}
.run-confirm-btn:hover{opacity:.85}
.run-confirm-btn:disabled{opacity:.35;cursor:default}
#live-panel{display:none;padding:16px 24px 0;border-bottom:1px solid #111;margin-bottom:4px}
.live-phases{display:flex;gap:0;margin-bottom:16px}
.live-phase{font-size:10px;color:#2a2a2a;padding:4px 10px;border:1px solid #1a1a1a;border-right:none;letter-spacing:.04em}
.live-phase:last-child{border-right:1px solid #1a1a1a}
.live-phase.active{color:#f59e0b;border-color:#3a2a00;background:#0d0800}
.live-phase.done{color:#4ade80;border-color:#1a2a1a;background:#080d08}
.live-sources{display:flex;flex-direction:column;gap:10px;margin-bottom:16px}
.live-src{display:flex;flex-direction:column;gap:3px}
.live-src-head{display:flex;align-items:baseline;gap:8px}
.live-src-name{font-size:11px;font-weight:600;color:#666}
.live-src-status{font-size:10px;color:#333}
.live-src-status.searching{color:#f59e0b}
.live-src-status.done{color:#4ade80}
.live-feed{display:flex;flex-direction:column;gap:2px;max-height:220px;overflow-y:auto}
.live-line{font-size:11px;line-height:1.5;padding:1px 0}
.live-line.step{color:#555;font-weight:600;margin-top:6px}
.live-line.new{color:#4ade80}
.live-line.skip{color:#2a2a2a}
.live-line.check{color:#444;font-style:italic}
.live-line.excl{color:#7f1d1d}
.live-line.info{color:#333}
</style>
</head>
<body>
<div class="topbar">
  <span class="sdot" id="sdot"></span>
  <span class="topbar-title">sourcing</span><span style="font-size:10px;color:#2a2a2a;margin-left:4px">v${VERSION}</span>
  <span class="topbar-meta" id="topbar-meta">${runMeta}</span>
  <span class="topbar-sched" id="sched-label">${schedText}</span>
  <span id="balance-display" style="font-size:10px;color:#2a2a2a"></span>
  <button class="run-btn" id="run-btn" onclick="toggleSourcePanel()">run sourcing</button>
</div>
${alertBanners.join('\n')}
<div id="source-panel">
  <div class="panel-section-label">Roles</div>
  <div class="role-grid" id="role-grid">${PRESET_ROLES.map(r => {
    const chk = !savedRoles.length || savedRoles.includes(r.toLowerCase());
    return '<label class="role-chip' + (chk?' checked':'') + '" onclick="this.classList.toggle(\'checked\')">'
      + '<input type="checkbox"' + (chk?' checked':'') + ' value="' + r + '">'
      + r + '</label>';
  }).join('')}</div>
  <div class="role-chip-custom">
    <input type="text" id="role-custom" placeholder="custom title…">
  </div>
  <div class="panel-section-label" style="margin-top:16px">Sources</div>
  <div class="src-sel-grid" id="src-sel-grid">
    <!-- populated by JS -->
  </div>
  <div class="src-footer">
    <span class="src-total">Total: <strong id="src-total-val">— credits</strong> &nbsp;<span id="src-balance" style="color:#444;font-size:10px"></span></span>
    <button class="run-confirm-btn" id="run-confirm-btn" onclick="confirmRun()">Run sourcing</button>
  </div>
</div>
<div id="live-panel">
  <div class="live-phases" id="live-phases">
    <div class="live-phase" id="ph1">1 · scraping</div>
    <div class="live-phase" id="ph2">2 · validating</div>
    <div class="live-phase" id="ph3">3 · location</div>
    <div class="live-phase" id="ph4">4 · saving</div>
  </div>
  <div class="live-sources" id="live-sources"></div>
  <div class="live-feed" id="live-feed"></div>
</div>
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
const BASE=location.origin;
let es=null,statusPoller=null;

// Show credit balance in topbar
fetch(BASE+'/credits').then(r=>r.json()).then(d=>{
  const b=d.balance??d.credits??null;
  const el=document.getElementById('balance-display');
  if(el&&b!==null){el.textContent=b+' cr';el.style.color=b<20?'#b45309':'#444';}
}).catch(()=>{});

// Live run state
const state={phase:0,sources:{},currentSrc:null};

function setPhase(n){
  state.phase=n;
  for(let i=1;i<=4;i++){
    const el=document.getElementById('ph'+i);
    el.className='live-phase'+(i<n?' done':i===n?' active':'');
  }
}

function getOrCreateSrc(name){
  if(!state.sources[name]){
    state.sources[name]={name,status:'searching',jobs:[]};
    const el=document.createElement('div');
    el.className='live-src';
    el.id='src-'+name.replace(/[^a-z0-9]/gi,'_');
    el.innerHTML=\`<div class="live-src-head"><span class="live-src-name">\${name}</span><span class="live-src-status searching" id="ss-\${el.id}">searching…</span></div>\`;
    document.getElementById('live-sources').appendChild(el);
  }
  return state.sources[name];
}

function setSrcStatus(name,text,cls){
  const src=state.sources[name];
  if(!src)return;
  const id='ss-src-'+name.replace(/[^a-z0-9]/gi,'_');
  const el=document.querySelector(\`[id^="ss-src-"]\`);
  // find by searching
  const heads=document.querySelectorAll('.live-src-status');
  const parent=document.getElementById('src-'+name.replace(/[^a-z0-9]/gi,'_'));
  if(parent){const ss=parent.querySelector('.live-src-status');if(ss){ss.textContent=text;ss.className='live-src-status '+(cls||'');}}
}

function addFeedLine(text,cls){
  const feed=document.getElementById('live-feed');
  const div=document.createElement('div');
  div.className='live-line '+(cls||'info');
  div.textContent=text;
  feed.appendChild(div);
  feed.scrollTop=feed.scrollHeight;
  // keep last 60 lines
  while(feed.children.length>60)feed.removeChild(feed.firstChild);
}

function parseLine(raw){
  const l=raw.trim();
  if(!l)return;

  // Phase markers
  const phM=l.match(/Phase\s+(\d)/);
  if(phM){setPhase(parseInt(phM[1]));return;}

  // Section headers (══ Name ══)
  const secM=l.match(/^[═─\s]*(.+?)[═─\s]*$/);
  if(l.includes('══')){
    const name=l.replace(/[═\s]+/g,'').trim();
    if(name&&!name.match(/^Phase/)){
      state.currentSrc=name;
      getOrCreateSrc(name);
    }
    return;
  }

  const src=state.currentSrc;

  // Found count
  const foundM=l.match(/Role matches extracted:\s*(\d+)/);
  if(foundM&&src){setSrcStatus(src,foundM[1]+' found','done');return;}

  // Scanned
  const scannedM=l.match(/Scanned:\s*(\d+)/);
  if(scannedM&&src){setSrcStatus(src,'scanned '+scannedM[1]+'…','searching');return;}

  // New job
  if(l.match(/✓\s*NEW:/)){addFeedLine(l.replace(/^\s*[✓~–]\s*/,'+ ').trim(),'new');return;}

  // Skip
  if(l.match(/–\s*skip:/)){addFeedLine(l.replace(/^\s*[–~]\s*/,'').trim(),'skip');return;}

  // Location check
  if(l.match(/Checking .+?\.\.\./)){addFeedLine(l.trim(),'check');return;}

  // Excluded
  if(l.match(/EXCLUDED/)){addFeedLine(l.trim(),'excl');return;}

  // Confirmed location
  if(l.match(/✓.+Remote|✓.+Austin/)){addFeedLine(l.trim(),'new');return;}

  // Misc info
  if(l.match(/Saved|No new|Total pipeline|new leads/)){addFeedLine(l.trim(),'step');return;}
}

// Source selector state
let sourceCatalog=[];
let userBalance=null;

async function loadBalance(){
  try{
    const d=await fetch(BASE+'/credits').then(r=>r.json());
    userBalance=d.balance??d.credits??null;
    const el=document.getElementById('src-balance');
    if(el&&userBalance!==null)el.textContent=userBalance+' available';
  }catch{}
}

async function loadCatalog(){
  if(sourceCatalog.length)return;
  try{sourceCatalog=await fetch(BASE+'/source/catalog').then(r=>r.json());}catch{return;}
  const grid=document.getElementById('src-sel-grid');
  grid.innerHTML='';
  for(const s of sourceCatalog){
    const id='src-cb-'+s.name.replace(/[^a-z0-9]/gi,'_');
    const row=document.createElement('div');
    row.className='src-sel-row';
    row.innerHTML=\`<input type="checkbox" id="\${id}" checked data-credits="\${s.credits}" onchange="updateTotal()">
<label class="src-sel-name" for="\${id}">\${s.name}</label>
<span class="src-sel-type">\${s.type}</span>
<span class="src-sel-cost" id="cost-\${id}">\${s.credits} cr</span>\`;
    grid.appendChild(row);
  }
  updateTotal();
}

function updateTotal(){
  const cbs=document.querySelectorAll('#src-sel-grid input[type=checkbox]');
  let total=0;
  cbs.forEach(cb=>{if(cb.checked)total+=parseInt(cb.dataset.credits||1);});
  const el=document.getElementById('src-total-val');
  if(el)el.textContent=total+' credit'+(total===1?'':'s');
  const btn=document.getElementById('run-confirm-btn');
  if(btn)btn.textContent='Run sourcing ('+total+' credits)';
}

function toggleSourcePanel(){
  const panel=document.getElementById('source-panel');
  const visible=panel.style.display!=='none'&&panel.style.display!=='';
  if(!visible){loadCatalog();loadBalance();panel.style.display='block';}
  else panel.style.display='none';
}

async function confirmRun(){
  const cbs=document.querySelectorAll('#src-sel-grid input[type=checkbox]');
  const selected=[];
  cbs.forEach(cb=>{
    if(cb.checked){
      const label=cb.parentElement.querySelector('.src-sel-name');
      if(label)selected.push(label.textContent.trim());
    }
  });
  if(!selected.length){alert('Select at least one source.');return;}

  const roleCbs=document.querySelectorAll('#role-grid input[type=checkbox]:checked');
  const roles=[];
  roleCbs.forEach(cb=>roles.push(cb.value));
  const custom=document.getElementById('role-custom').value.trim();
  if(custom)custom.split(',').map(r=>r.trim()).filter(Boolean).forEach(r=>roles.push(r));
  if(!roles.length){alert('Select at least one role.');return;}

  const cbs2=document.querySelectorAll('#src-sel-grid input[type=checkbox]:checked');
  let totalCost=0;cbs2.forEach(cb=>totalCost+=parseInt(cb.dataset.credits||1));
  if(userBalance!==null&&userBalance<totalCost){
    alert('Not enough credits — you have '+userBalance+' but this run costs '+totalCost+'. Buy more at /buy.');
    return;
  }
  document.getElementById('source-panel').style.display='none';
  const btn=document.getElementById('run-btn');
  btn.disabled=true;btn.textContent='starting…';
  try{
    const d=await fetch(BASE+'/source/run',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({sources:selected,roles}),
    }).then(r=>r.json());
    if(d.status==='already_running'){
      btn.textContent='already running';
      setTimeout(()=>{btn.disabled=false;btn.textContent='run sourcing';},2000);
    } else if(d.error){
      btn.disabled=false;btn.textContent='run sourcing';
      alert(d.error+(d.balance!=null?' (balance: '+d.balance+', needed: '+d.required+')':''));
    } else {
      startLive();
    }
  }catch{btn.disabled=false;btn.textContent='run sourcing';}
}

function startLive(){
  document.getElementById('live-panel').style.display='';
  document.getElementById('sdot').className='sdot active';
  document.getElementById('topbar-meta').textContent='sourcing in progress…';
  document.getElementById('run-btn').disabled=true;
  document.getElementById('run-btn').textContent='running…';
  setPhase(1);

  // Stream log lines via SSE
  es=new EventSource(BASE+'/source/stream');
  es.onmessage=e=>{
    try{parseLine(JSON.parse(e.data));}catch{}
  };

  // Poll status to detect completion
  statusPoller=setInterval(async()=>{
    try{
      const st=await fetch(BASE+'/source/status').then(r=>r.json());
      if(!st.active){
        clearInterval(statusPoller);
        if(es){es.close();es=null;}
        document.getElementById('sdot').className='sdot';
        document.getElementById('topbar-meta').textContent='done — reloading…';
        setTimeout(()=>location.reload(),2000);
      }
    }catch{}
  },3000);
}

// On page load — auto-connect if a run is already in progress
fetch(BASE+'/source/status').then(r=>r.json()).then(st=>{
  if(st.active) startLive();
}).catch(()=>{});

function trackOpen(url){
  fetch(BASE+'/track/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})}).catch(()=>{});
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

app.post('/track/open', (req, res) => {
  const { url } = req.body;
  if (!url) return res.json({ ok: false });
  const file = path.join(__dirname, '../logs/opened.json');
  try {
    let opened = [];
    try { opened = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch {}
    if (!opened.some(o => o.url === url)) {
      opened.push({ url, opened_at: new Date().toISOString() });
      fs.writeFileSync(file, JSON.stringify(opened, null, 2));
    }
  } catch {}
  res.json({ ok: true });
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

app.post('/audit/missed', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    let company = '';
    try {
      const u = new URL(url);
      if (u.hostname.includes('ashbyhq.com')) company = url.match(/ashbyhq\.com\/([^/]+)/)?.[1] || '';
      else if (u.hostname.includes('lever.co')) company = url.match(/lever\.co\/([^/]+)/)?.[1] || '';
      else if (u.hostname.includes('greenhouse.io')) company = url.match(/greenhouse\.io\/([^/]+)/)?.[1] || '';
      else company = u.hostname.replace(/^www\./, '').split('.')[0];
    } catch {}
    const userEmail = reqUserEmail(req);
    const existing = await db.getJobByUrl(url);
    if (existing) return res.json({ ok: true, status: 'already_exists' });
    const today = new Date().toISOString().slice(0, 10);
    const id = `manual-${today}-${Math.random().toString(36).slice(2, 6)}`;
    await db.insertJob({ id, url, company, role: 'Unknown', ats: 'other', fit_score: 7, tier: '2', location: 'Remote', notes: 'added manually via audit', found_at: today, status: 'new', user_email: userEmail });
    res.json({ ok: true, id, company });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Pipeline page ─────────────────────────────────────────────────────────────

app.get('/pipeline', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const userEmail = reqUserEmail(req);
  const allJobs = await db.getJobs(null, 2000, userEmail);
  const jobsJson = JSON.stringify(allJobs).replace(/<\/script>/gi, '<\\/script>');

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Pipeline — applyapply</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#000;color:#fff;font-size:13px;-webkit-font-smoothing:antialiased;overflow:hidden}
a{text-decoration:none;color:inherit}
.topbar{height:40px;background:#000;border-bottom:1px solid #111;padding:0 20px;display:flex;align-items:center;gap:16px;flex-shrink:0}
.topbar-title{font-weight:700;font-size:13px;letter-spacing:-.01em}
.topbar a{color:#555;font-size:12px}
.topbar a:hover{color:#fff}
.tbar-r{margin-left:auto;display:flex;align-items:center;gap:10px}
#balance-display{font-size:11px;color:#555}
.kb-btn{font-size:11px;color:#777;cursor:pointer;padding:3px 8px;border:1px solid #222;background:none}
.kb-btn:hover{color:#fff;border-color:#666}
.pl-wrap{display:flex;height:calc(100vh - 40px - 34px)}

/* Left list pane */
.pl-left{width:256px;flex-shrink:0;border-right:1px solid #111;display:flex;flex-direction:column}
.pl-filters{padding:10px 12px;border-bottom:1px solid #111;display:flex;gap:5px;flex-wrap:wrap}
.pf{padding:4px 9px;background:transparent;color:#555;border:1px solid #181818;font-size:11px;cursor:pointer;font-family:inherit;transition:color .1s,border-color .1s}
.pf:hover{color:#ccc;border-color:#333}
.pf.on{color:#fff;border-color:#555;background:#111}
.pf-n{font-size:10px;color:#555;margin-left:2px}
.pf.on .pf-n{color:#888}
.pl-list{flex:1;overflow-y:auto}
.pitem{padding:10px 14px;border-bottom:1px solid #0d0d0d;cursor:pointer;transition:background .08s}
.pitem:hover{background:#080808}
.pitem.on{background:#111;box-shadow:inset 2px 0 0 #fff}
.pitem.fading{opacity:0;transition:opacity .2s}
.pi-co{font-size:13px;font-weight:600;color:#fff;margin-bottom:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pi-role{font-size:11px;color:#666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.pi-meta{font-size:10px;color:#3a3a3a}
.pl-empty{padding:16px 14px;font-size:12px;color:#333}

/* Right detail pane */
.pl-right{flex:1;overflow-y:auto;display:flex;flex-direction:column;min-width:0}
.pr-idle{display:flex;align-items:center;justify-content:center;height:100%;color:#282828;font-size:13px;letter-spacing:.02em}
.pr-head{padding:28px 36px 22px;border-bottom:1px solid #111}
.pr-co{font-size:26px;font-weight:700;letter-spacing:-.04em;margin-bottom:4px}
.pr-role{font-size:14px;color:#888;margin-bottom:14px}
.pr-attrs{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:16px}
.pr-attr{font-size:11px;color:#444}
.pr-attr b{color:#777;font-weight:500}
.pr-url{font-size:12px;color:#555;border-bottom:1px solid #1e1e1e;padding-bottom:1px}
.pr-url:hover{color:#fff;border-color:#555}
.pr-body{padding:24px 36px;flex:1}
.pr-fit{display:inline-flex;align-items:baseline;gap:3px;margin-bottom:20px}
.pr-fit-n{font-size:36px;font-weight:700;letter-spacing:-.05em;line-height:1}
.pr-fit-d{font-size:14px;color:#444}
.pr-fit-l{font-size:10px;color:#444;margin-left:8px;letter-spacing:.05em;text-transform:uppercase}
.pr-btns{display:flex;gap:8px;align-items:center;margin-bottom:20px}
.pr-open-btn{display:inline-flex;align-items:center;gap:10px;padding:11px 18px;background:#fff;color:#000;border:none;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
.pr-open-btn:hover{background:#e5e5e5}
.pr-skip-btn{display:inline-flex;align-items:center;gap:8px;padding:11px 16px;background:transparent;color:#555;border:1px solid #1e1e1e;font-size:13px;cursor:pointer;font-family:inherit}
.pr-skip-btn:hover{color:#fff;border-color:#555}
.pr-open-key{display:inline-block;background:#ddd;color:#000;font-size:11px;padding:1px 6px;border-radius:2px}
.pr-skip-btn .pr-open-key{background:#1a1a1a;color:#888}

/* Keyboard help */
.kb-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;align-items:center;justify-content:center}
.kb-overlay.on{display:flex}
.kb-panel{background:#0d0d0d;border:1px solid #222;padding:24px 28px;min-width:220px}
.kb-panel-title{font-size:11px;font-weight:700;color:#666;letter-spacing:.07em;text-transform:uppercase;margin-bottom:14px}
.kb-panel table{font-size:12px;border-collapse:collapse;width:100%}
.kb-panel td{padding:4px 0;color:#bbb}
.kb-panel td:first-child{color:#444;width:48px;font-family:monospace;font-size:11px}
.kb-panel-close{margin-top:14px;font-size:11px;color:#333}

.kb-bar{position:fixed;bottom:0;left:0;right:0;height:34px;background:#050505;border-top:1px solid #111;display:flex;align-items:center;padding:0 20px;gap:0;z-index:50}
.kb-bar-item{display:flex;align-items:center;gap:5px;font-size:11px;color:#444;padding:0 14px;border-right:1px solid #111}
.kb-bar-item:first-child{padding-left:0}
.kb-bar kbd{display:inline-block;background:#111;border:1px solid #1e1e1e;color:#777;font-size:10px;padding:1px 6px;min-width:16px;text-align:center;font-family:inherit;border-radius:2px}
.kb-bar-hint{margin-left:auto;font-size:11px;color:#2a2a2a;cursor:pointer;padding:0 0 0 14px}
.kb-bar-hint:hover{color:#666}
.toast{position:fixed;bottom:48px;right:24px;background:#fff;color:#000;padding:8px 16px;font-size:12px;font-weight:600;opacity:0;transition:opacity .18s;pointer-events:none}
.toast.on{opacity:1}
</style></head><body>
<div class="topbar">
  <span class="topbar-title">applyapply</span>
  <a href="/sourcing">Sourcing</a>
  <a href="/setup">Profile</a>
  <div class="tbar-r">
    <span id="balance-display"></span>
    <button class="kb-btn" id="kb-toggle">?</button>
  </div>
</div>
<div class="pl-wrap">
  <div class="pl-left">
    <div class="pl-filters" id="pl-filters"></div>
    <div class="pl-list" id="pl-list"></div>
  </div>
  <div class="pl-right" id="pl-right">
    <div class="pr-idle">j &nbsp;/&nbsp; k &nbsp; to navigate</div>
  </div>
</div>
<div class="kb-bar">
  <span class="kb-bar-item"><kbd>j</kbd><kbd>k</kbd> move</span>
  <span class="kb-bar-item"><kbd>&#x21b5;</kbd> open job</span>
  <span class="kb-bar-item"><kbd>a</kbd> applying</span>
  <span class="kb-bar-item"><kbd>s</kbd> skip</span>
  <span class="kb-bar-item"><kbd>d</kbd> applied</span>
  <span class="kb-bar-item"><kbd>u</kbd> undo</span>
  <span class="kb-bar-hint" id="kb-toggle2">all shortcuts &rarr;</span>
</div>
<div class="toast" id="toast"></div>
<div class="kb-overlay" id="kb-overlay">
  <div class="kb-panel">
    <div class="kb-panel-title">Shortcuts</div>
    <table><tbody>
      <tr><td>j / k</td><td>Next / previous lead</td></tr>
      <tr><td>&crarr;</td><td>Open job posting</td></tr>
      <tr><td>a</td><td>Mark applying</td></tr>
      <tr><td>d</td><td>Mark applied / done</td></tr>
      <tr><td>s</td><td>Skip</td></tr>
      <tr><td>u</td><td>Move back to new</td></tr>
      <tr><td>?</td><td>This panel</td></tr>
    </tbody></table>
    <div class="kb-panel-close">Esc to close</div>
  </div>
</div>
<script>
var JOBS = ${jobsJson};

var filter = 'new';
var selIdx = -1;
var listItems = [];

var FILTERS = [
  {key:'new',label:'New'},
  {key:'applying',label:'Applying'},
  {key:'applied',label:'Applied'},
  {key:'skipped',label:'Skipped'},
  {key:'all',label:'All'},
];

function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function counts() {
  var c = {};
  JOBS.forEach(function(j){ c[j.status]=(c[j.status]||0)+1; });
  return c;
}

function renderFilters() {
  var c = counts();
  document.getElementById('pl-filters').innerHTML = FILTERS.map(function(f) {
    var n = f.key === 'all' ? JOBS.length : (c[f.key]||0);
    return '<button class="pf' + (f.key===filter?' on':'') + '" data-f="' + f.key + '">'
      + f.label + (f.key!=='all' ? '<span class="pf-n" id="pfc-'+f.key+'">' + n + '</span>' : '')
      + '</button>';
  }).join('');
  document.querySelectorAll('.pf').forEach(function(btn) {
    btn.addEventListener('click', function() { setFilter(btn.dataset.f); });
  });
}

function setFilter(f) {
  filter = f;
  selIdx = -1;
  renderFilters();
  renderList();
}

function getFiltered() {
  return filter === 'all' ? JOBS.slice() : JOBS.filter(function(j){ return j.status===filter; });
}

function renderList() {
  listItems = getFiltered();
  var list = document.getElementById('pl-list');
  if (!listItems.length) {
    list.innerHTML = '<div class="pl-empty">Nothing here</div>';
    document.getElementById('pl-right').innerHTML = '<div class="pr-idle">Nothing in this filter</div>';
    return;
  }
  list.innerHTML = '';
  listItems.forEach(function(j, i) {
    var el = document.createElement('div');
    el.className = 'pitem';
    el.id = 'pitem-' + i;
    var fit = j.fit_score ? ' &middot; ' + j.fit_score + '/10' : '';
    el.innerHTML = '<div class="pi-co">' + esc(j.company||j.url) + '</div>'
      + '<div class="pi-role">' + esc(j.role||'') + '</div>'
      + '<div class="pi-meta">' + esc(j.location||'') + fit + '</div>';
    (function(idx){ el.addEventListener('click', function(){ selectItem(idx); }); })(i);
    list.appendChild(el);
  });
  selectItem(0);
}

function selectItem(idx) {
  if (idx < 0 || idx >= listItems.length) return;
  selIdx = idx;
  document.querySelectorAll('.pitem').forEach(function(el){ el.classList.remove('on'); });
  var el = document.getElementById('pitem-' + idx);
  if (el) { el.classList.add('on'); el.scrollIntoView({block:'nearest'}); }
  renderDetail(listItems[idx]);
}

function renderDetail(j) {
  var html = '<div class="pr-head">';
  html += '<div class="pr-co">' + esc(j.company||j.url) + '</div>';
  html += '<div class="pr-role">' + esc(j.role||'') + '</div>';
  html += '<div class="pr-attrs">';
  if (j.location) html += '<span class="pr-attr"><b>' + esc(j.location) + '</b></span>';
  if (j.source)   html += '<span class="pr-attr">via <b>' + esc(j.source) + '</b></span>';
  if (j.found_at) html += '<span class="pr-attr"><b>' + esc(j.found_at) + '</b></span>';
  if (j.tier)     html += '<span class="pr-attr">T<b>' + esc(String(j.tier)) + '</b></span>';
  html += '</div>';
  html += '</div>';
  html += '<div class="pr-body">';
  if (j.fit_score) html += '<div class="pr-fit"><span class="pr-fit-n">' + j.fit_score + '</span><span class="pr-fit-d">/10</span><span class="pr-fit-l">fit</span></div>';
  html += '<div class="pr-btns">';
  html += '<button class="pr-open-btn" onclick="openAndGenerate(listItems[' + selIdx + '])"><span class="pr-open-key">&crarr;</span> Open &amp; generate kit</button>';
  if (j.status !== 'skipped') html += '<button class="pr-skip-btn" onclick="doAction(&apos;skipped&apos;)"><span class="pr-open-key">S</span> Skip</button>';
  if (j.status === 'skipped') html += '<button class="pr-skip-btn" onclick="doAction(&apos;new&apos;)"><span class="pr-open-key">U</span> Undo</button>';
  html += '</div>';
  html += '</div>';
  document.getElementById('pl-right').innerHTML = html;
}

async function openAndGenerate(j) {
  await fetch('/sourced/pending-generate', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({url: j.url})
  }).catch(()=>{});
  window.open(j.url, '_blank');
  if (j.status === 'new') doAction('applying');
}

async function doAction(status) {
  if (selIdx < 0 || selIdx >= listItems.length) return;
  var j = listItems[selIdx];
  var res = await fetch('/sourced/status', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({url:j.url, status:status})
  });
  if (!res.ok) { showToast('Error'); return; }
  j.status = status;
  var master = JOBS.find(function(x){ return x.url===j.url; });
  if (master) master.status = status;
  showToast('→ ' + status);

  if (filter !== 'all' && filter !== status) {
    var el = document.getElementById('pitem-' + selIdx);
    if (el) el.classList.add('fading');
    var nextIdx = selIdx;
    setTimeout(function() {
      listItems.splice(selIdx, 1);
      var goTo = nextIdx < listItems.length ? nextIdx : nextIdx - 1;
      renderListOnly();
      renderFilters();
      if (listItems.length) selectItem(Math.max(0, goTo));
    }, 210);
  } else {
    renderFilters();
    renderDetail(j);
  }
}

function renderListOnly() {
  var list = document.getElementById('pl-list');
  if (!listItems.length) {
    list.innerHTML = '<div class="pl-empty">All caught up</div>';
    document.getElementById('pl-right').innerHTML = '<div class="pr-idle">All caught up &mdash; find more roles in <a href="/sourcing" style="color:#555;text-decoration:underline">Sourcing</a></div>';
    return;
  }
  list.innerHTML = '';
  listItems.forEach(function(j, i) {
    var el = document.createElement('div');
    el.className = 'pitem' + (i === selIdx ? ' on' : '');
    el.id = 'pitem-' + i;
    var fit = j.fit_score ? ' &middot; ' + j.fit_score + '/10' : '';
    el.innerHTML = '<div class="pi-co">' + esc(j.company||j.url) + '</div>'
      + '<div class="pi-role">' + esc(j.role||'') + '</div>'
      + '<div class="pi-meta">' + esc(j.location||'') + fit + '</div>';
    (function(idx){ el.addEventListener('click', function(){ selectItem(idx); }); })(i);
    list.appendChild(el);
  });
}

function showToast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(t._t);
  t._t = setTimeout(function(){ t.classList.remove('on'); }, 1800);
}

var kbOverlay = document.getElementById('kb-overlay');
function toggleKb(){ kbOverlay.classList.toggle('on'); }
document.getElementById('kb-toggle').addEventListener('click', toggleKb);
document.getElementById('kb-toggle2').addEventListener('click', toggleKb);
kbOverlay.addEventListener('click', function(e){
  if (e.target === kbOverlay) kbOverlay.classList.remove('on');
});

document.addEventListener('keydown', function(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (kbOverlay.classList.contains('on')) {
    if (e.key === 'Escape') kbOverlay.classList.remove('on');
    return;
  }
  switch(e.key) {
    case 'j': case 'ArrowDown': e.preventDefault(); if (selIdx<listItems.length-1) selectItem(selIdx+1); break;
    case 'k': case 'ArrowUp':   e.preventDefault(); if (selIdx>0) selectItem(selIdx-1); break;
    case 'Enter': if (selIdx>=0 && listItems[selIdx]) openAndGenerate(listItems[selIdx]); break;
    case 'a': doAction('applying'); break;
    case 'd': doAction('applied'); break;
    case 's': doAction('skipped'); break;
    case 'u': doAction('new'); break;
    case '?': kbOverlay.classList.add('on'); break;
    case 'Escape': kbOverlay.classList.remove('on'); break;
  }
});

fetch('/credits').then(function(r){return r.json();}).then(function(d){
  var b = d.balance ?? d.credits ?? null;
  var el = document.getElementById('balance-display');
  if (el && b !== null) { el.textContent = b + ' cr'; el.style.color = b < 20 ? '#92400e' : '#555'; }
}).catch(function(){});

renderFilters();
renderList();
</script>
</body></html>`);
});

// ── URL-prepend catch-all: applyapply.xyz/<job-url> ──────────────────────────
const JOB_DOMAINS = /^\/((jobs\.|job-boards\.|app\.|boards\.)?(ashbyhq|greenhouse|lever|workable|smartrecruiters|myworkdayjobs|jobvite|icims|taleo|breezy|recruitee|careerpuck|builtin|workatastartup|comeet|linkedin)\.)/;
app.use((req, res, next) => {
  // Bare domain (missing https://) — redirect to canonical form
  if (JOB_DOMAINS.test(req.path)) {
    return res.redirect(301, '/https:/' + req.originalUrl);
  }
  if (!req.path.match(/^\/https?:\/\//)) return next();
  const jobUrl = req.originalUrl.slice(1);
  const encodedReturn = encodeURIComponent(req.originalUrl);

  res.setHeader('Cache-Control', 'no-store');
  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>applyapply — kit incoming</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#000;color:#fff;min-height:100vh;-webkit-font-smoothing:antialiased}
a{text-decoration:none;color:inherit}
.topbar{height:44px;border-bottom:1px solid #111;padding:0 20px;display:flex;align-items:center}
.logo{font-weight:700;font-size:13px;letter-spacing:-.02em}
.topbar-r{margin-left:auto;display:flex;gap:16px;align-items:center}
.topbar-r a{font-size:12px;color:#fff;transition:color .15s}
.topbar-r a:hover{opacity:.7}
.wrap{max-width:720px;margin:0 auto;padding:40px 20px 120px}

/* loading */
.load-wrap{padding:60px 0 40px;text-align:center}
.load-step{font-size:13px;color:#fff;min-height:20px;transition:opacity .3s}
.load-bar{height:2px;background:#111;margin:20px 0 0;border-radius:1px;overflow:hidden}
.load-fill{height:100%;background:#fff;width:0%;transition:width .6s ease}
.load-done{font-size:28px;font-weight:800;letter-spacing:-.04em;color:#fff;margin-top:32px;display:none}

/* login / error */
.box{border:1px solid #1a1a1a;padding:32px;margin-top:40px;text-align:center}
.box p{font-size:13px;color:#ccc;margin-bottom:20px;line-height:1.6}
.box-err{border-color:#2a1a1a;background:#080404}
.box-err p{color:#ef4444}

/* kit */
.kit{display:none}
.job-tag{display:flex;align-items:baseline;gap:10px;margin-bottom:36px}
.job-co{font-size:22px;font-weight:800;letter-spacing:-.04em}
.job-role{font-size:13px;color:#fff}
.kit-headline{font-size:15px;font-weight:600;letter-spacing:-.02em;line-height:1.4;color:#fff;margin-bottom:36px;padding:16px;background:#0a0a0a;border:1px solid #111}

/* sections */
.section{margin-bottom:40px}
.section-hd{margin-bottom:16px;padding-bottom:10px;border-bottom:1px solid #0d0d0d}
.section-label{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#fff}

/* field rows */
.fields-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.field{background:#050505;border:1px solid #111;padding:10px 12px}
.field-label{font-size:10px;color:#fff;margin-bottom:5px;text-transform:uppercase;letter-spacing:.06em}
.field-val{font-size:12px;color:#fff;outline:none;width:100%;background:transparent;border:none;font-family:inherit;resize:none;line-height:1.5}
.field-val::placeholder{color:#222}

/* generated blocks */
.gen-block{background:#050505;border:1px solid #111;padding:16px;margin-bottom:8px}
.gen-block-hd{display:flex;align-items:center;gap:6px;margin-bottom:10px}
.gen-q{font-size:11px;font-weight:600;color:#fff;flex:1;line-height:1.4}
.gen-actions{display:flex;gap:4px;flex-shrink:0}
.icon-btn{padding:4px 8px;background:transparent;border:1px solid #1a1a1a;color:#888;font-size:10px;cursor:pointer;font-family:inherit;transition:all .15s;white-space:nowrap}
.icon-btn:hover{color:#fff;border-color:#444}
.icon-btn.listening{color:#ef4444;border-color:#ef4444;animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.gen-ta{width:100%;background:transparent;border:none;color:#fff;font-size:13px;font-family:inherit;line-height:1.7;resize:vertical;outline:none;min-height:60px}

/* warm path */
.warm{font-size:11px;color:#555;padding:10px 12px;border:1px solid #0d0d0d;font-style:italic;margin-top:-4px;margin-bottom:8px}

/* actions */
.kit-actions{position:fixed;bottom:0;left:0;right:0;background:#000;border-top:1px solid #111;padding:12px 20px;display:none;gap:8px;align-items:center}
.btn{padding:9px 18px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;letter-spacing:-.01em;border:none;transition:all .15s}
.btn-primary{background:#fff;color:#000;display:flex;align-items:center;gap:8px}
.btn-primary:hover{background:#e0e0e0}
.btn-primary .kbd{background:#000;color:#999;font-size:10px;padding:2px 5px;border-radius:2px;font-family:monospace}
.btn-ghost{background:transparent;color:#ccc;border:1px solid #1a1a1a}
.btn-ghost:hover{color:#fff;border-color:#555}
.btn-danger{background:transparent;color:#888;border:1px solid #333;font-size:11px}
.btn-danger:hover{color:#ef4444;border-color:#ef4444}
.actions-r{margin-left:auto;display:flex;gap:6px}

/* retry drawer */
.retry-drawer{display:none;position:fixed;bottom:57px;left:0;right:0;background:#050505;border-top:1px solid #1a1a1a;padding:16px 20px;z-index:10}
.retry-drawer textarea{width:100%;background:transparent;border:1px solid #1a1a1a;color:#fff;font-size:12px;font-family:inherit;padding:10px;resize:none;outline:none;line-height:1.5}
.retry-drawer textarea:focus{border-color:#555}
.retry-drawer textarea::placeholder{color:#2a2a2a}
.retry-row{display:flex;gap:8px;margin-top:8px;align-items:center}
.retry-hint{font-size:11px;color:#555;flex:1}
</style>
</head>
<body>
<div class="topbar">
  <a href="/" class="logo">applyapply</a>
  <div class="topbar-r">
    <a href="/pipeline">pipeline</a>
    <a href="/setup">profile</a>
  </div>
</div>
<div class="wrap">

  <div class="load-wrap" id="loadWrap">
    <div class="load-step" id="loadStep">Checking session...</div>
    <div class="load-bar"><div class="load-fill" id="loadFill"></div></div>
    <div class="load-done" id="loadDone"></div>
  </div>

  <div id="loginBox" class="box" style="display:none">
    <p>You need an account to unlock this.<br>Takes 30 seconds, no password.</p>
    <a href="/login?return=${encodedReturn}" class="btn btn-primary">Sign in to continue →</a>
  </div>

  <div id="errorBox" class="box box-err" style="display:none">
    <p id="errorMsg">Something broke.</p>
  </div>

  <div class="kit" id="kit">
    <div class="job-tag">
      <span class="job-co" id="kitCo"></span>
      <span class="job-role" id="kitRole"></span>
    </div>
    <div class="kit-headline" id="kitHeadline"></div>

    <div class="section">
      <div class="section-hd"><span class="section-label">The basics</span></div>
      <div class="fields-grid" id="basicFields"></div>
    </div>

    <div class="section">
      <div class="section-hd"><span class="section-label">Your answers</span></div>
      <div id="genFields"></div>
    </div>
  </div>

</div>

<div class="retry-drawer" id="retryDrawer">
  <textarea id="retryNote" rows="2" placeholder="What's wrong with it? Be specific. &quot;Make the cover note less formal&quot;, &quot;lean into the Filmhub angle more&quot;, etc."></textarea>
  <div class="retry-row">
    <span class="retry-hint">Costs 10 credits — rewrites the whole kit.</span>
    <button class="btn btn-ghost" onclick="closeRetry()">Never mind</button>
    <button class="btn btn-primary" onclick="doRetry()">Cook it again →</button>
  </div>
</div>

<div class="kit-actions" id="kitActions">
  <button class="btn btn-primary" onclick="openAndApply()">Open &amp; apply <span class="kbd">↵</span></button>
  <button class="btn btn-ghost" onclick="downloadKit()">Download <span style="font-size:10px">D</span></button>
  <div class="actions-r">
    <button class="btn btn-danger" onclick="toggleRetry()">↺ Redo <span style="font-size:10px">R</span></button>
  </div>
</div>

<script>
var JOB_URL = ${JSON.stringify(jobUrl)};
var kitData = null;
var activeRecorder = null;

function getSession() { try { return localStorage.getItem('aa_session') || ''; } catch { return ''; } }
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function setStep(msg, pct) {
  document.getElementById('loadStep').textContent = msg;
  if (pct !== undefined) document.getElementById('loadFill').style.width = pct + '%';
}

function showDone(msg) {
  document.getElementById('loadStep').textContent = '';
  document.getElementById('loadFill').style.width = '100%';
  var d = document.getElementById('loadDone');
  d.textContent = msg;
  d.style.display = 'block';
  setTimeout(function() { document.getElementById('loadWrap').style.display = 'none'; }, 900);
}

function showError(msg) {
  document.getElementById('loadWrap').style.display = 'none';
  var b = document.getElementById('errorBox');
  document.getElementById('errorMsg').innerHTML = msg;
  b.style.display = 'block';
}

// ── copy button ───────────────────────────────────────────────────────────────
function copyField(btn, taId) {
  var ta = document.getElementById(taId);
  var text = ta ? ta.value : '';
  navigator.clipboard.writeText(text).then(function() {
    var orig = btn.textContent;
    btn.textContent = 'Copied ✓';
    btn.style.color = '#4ade80';
    btn.style.borderColor = '#4ade80';
    setTimeout(function() { btn.textContent = orig; btn.style.color = ''; btn.style.borderColor = ''; }, 1500);
  }).catch(function() {
    btn.textContent = 'Failed ✗';
    setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
  });
}

// ── voice ─────────────────────────────────────────────────────────────────────
function voiceField(btn, taId, question) {
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    alert('Voice not supported in this browser. Try Chrome.');
    return;
  }
  if (activeRecorder) { activeRecorder.stop(); activeRecorder = null; return; }
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = new SR();
  rec.continuous = false;
  rec.interimResults = false;
  activeRecorder = rec;
  btn.textContent = '⏹ Stop';
  btn.classList.add('listening');
  rec.onresult = function(e) {
    var transcript = e.results[0][0].transcript;
    btn.textContent = '✦ Polishing...';
    btn.classList.remove('listening');
    activeRecorder = null;
    fetch('/voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getSession() },
      body: JSON.stringify({ transcript: transcript, question: question, appId: kitData && kitData.id }),
    })
    .then(function(r) {
      if (r.status === 401) { btn.textContent = '🔒 Sign in'; setTimeout(function(){ btn.textContent = '🎤 Voice'; }, 2000); return null; }
      if (r.status === 402) { btn.textContent = '0 credits'; setTimeout(function(){ btn.textContent = '🎤 Voice'; }, 2000); return null; }
      return r.json();
    })
    .then(function(d) {
      if (!d) return;
      var ta = document.getElementById(taId);
      if (ta && d.text) ta.value = d.text;
      btn.textContent = '🎤 Voice';
    })
    .catch(function() { btn.textContent = '🎤 Voice'; });
  };
  rec.onerror = function() { btn.textContent = '🎤 Voice'; btn.classList.remove('listening'); activeRecorder = null; };
  rec.onend = function() { if (btn.classList.contains('listening')) { btn.textContent = '🎤 Voice'; btn.classList.remove('listening'); activeRecorder = null; } };
  rec.start();
}

// ── render ────────────────────────────────────────────────────────────────────
function makeGenBlock(id, question, answer) {
  var d = document.createElement('div');
  d.className = 'gen-block';
  d.innerHTML =
    '<div class="gen-block-hd">' +
      '<div class="gen-q">' + esc(question) + '</div>' +
      '<div class="gen-actions">' +
        '<button class="icon-btn" onclick="voiceField(this,\\'ta-' + id + '\\',\\''+esc(question).replace(/'/g,'\\\\&apos;')+'\\')">🎤 Voice</button>' +
        '<button class="icon-btn" onclick="copyField(this,\\'ta-' + id + '\\')">Copy</button>' +
      '</div>' +
    '</div>' +
    '<textarea class="gen-ta" id="ta-' + id + '" rows="4">' + esc(answer) + '</textarea>';
  return d;
}

function makeBasicField(label, value, key) {
  var multiline = key === 'bio' || key === 'salary';
  return '<div class="field"><div class="field-label">' + esc(label) + '</div>' +
    (multiline
      ? '<textarea class="field-val" rows="2" data-key="' + key + '">' + esc(value) + '</textarea>'
      : '<input class="field-val" value="' + esc(value) + '" data-key="' + key + '">') +
    '</div>';
}

function renderKit(kit) {
  kitData = kit;
  showDone('Kit\\'s hot. 🔥');

  document.getElementById('kitCo').textContent = kit.company || '';
  document.getElementById('kitRole').textContent = kit.role || '';
  document.getElementById('kitHeadline').textContent = kit.tailored && kit.tailored.headline || '';

  // Basic profile fields
  var p = kit.profile || {};
  var basics = [
    ['First name', p.first_name || '', 'first_name'],
    ['Last name', p.last_name || '', 'last_name'],
    ['Email', p.email || '', 'email'],
    ['Phone', p.phone || '', 'phone'],
    ['LinkedIn', p.linkedin || '', 'linkedin'],
    ['Work auth', p.work_authorization || '', 'work_authorization'],
    ['Salary ask', p.salary || '', 'salary'],
    ['Location', p.location || '', 'location'],
  ].filter(function(f) { return f[1]; });
  var grid = document.getElementById('basicFields');
  grid.innerHTML = basics.map(function(f) { return makeBasicField(f[0], f[1], f[2]); }).join('');

  // Generated fields
  var gen = document.getElementById('genFields');
  gen.innerHTML = '';
  var t = kit.tailored || {};
  if (t.why_role) {
    var clBlock = makeGenBlock('why', 'Cover letter', t.why_role);
    var pdfBtn = document.createElement('button');
    pdfBtn.className = 'icon-btn';
    pdfBtn.textContent = 'PDF';
    pdfBtn.onclick = downloadCoverLetterPDF;
    clBlock.querySelector('.gen-actions').appendChild(pdfBtn);
    gen.appendChild(clBlock);
  }
  if (t.cover_note) gen.appendChild(makeGenBlock('cover', 'Cover note', t.cover_note));
  if (kit.warm_path && kit.warm_path !== 'Cold apply') {
    var w = document.createElement('div');
    w.className = 'warm';
    w.textContent = '↗ ' + kit.warm_path;
    gen.appendChild(w);
  }
  (t.qa || []).forEach(function(item, i) {
    gen.appendChild(makeGenBlock('qa' + i, item.q, item.a));
  });

  document.getElementById('kit').style.display = 'block';
  document.getElementById('kitActions').style.display = 'flex';
}

// ── actions ───────────────────────────────────────────────────────────────────
function openAndApply() {
  if (!kitData) return;
  window.open(kitData.url || JOB_URL, '_blank');
}

function downloadCoverLetterPDF() {
  if (!kitData || !kitData.tailored || !kitData.tailored.why_role) return;
  function generate() {
    var doc = new window.jspdf.jsPDF();
    var margin = 22;
    var pageW = doc.internal.pageSize.getWidth() - margin * 2;
    var y = 28;
    // Header
    doc.setFontSize(12); doc.setFont(undefined, 'bold');
    doc.text(kitData.company || '', margin, y); y += 7;
    doc.setFont(undefined, 'normal');
    doc.text(kitData.role || '', margin, y); y += 7;
    doc.setFontSize(10);
    doc.text(new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }), margin, y); y += 14;
    // Body
    doc.setFontSize(11);
    var text = document.getElementById('ta-why').value || kitData.tailored.why_role;
    var lines = doc.splitTextToSize(text, pageW);
    lines.forEach(function(line) {
      if (y > 272) { doc.addPage(); y = 22; }
      doc.text(line, margin, y); y += 6.5;
    });
    var slug = ((kitData.company || '') + '-' + (kitData.role || '')).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    doc.save(slug + '-cover-letter.pdf');
  }
  if (window.jspdf) { generate(); return; }
  var s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  s.onload = generate;
  document.head.appendChild(s);
}

function downloadKit() {
  if (!kitData) return;
  var t = kitData.tailored || {};
  var lines = [
    (kitData.company || '') + (kitData.role ? ' — ' + kitData.role : ''),
    kitData.url || JOB_URL,
    '',
  ];
  if (t.why_role) {
    lines.push('COVER LETTER');
    lines.push(t.why_role);
    lines.push('');
  }
  if (t.cover_note) {
    lines.push('COVER NOTE');
    lines.push(t.cover_note);
    lines.push('');
  }
  (t.qa || []).forEach(function(item) {
    lines.push('Q: ' + item.q);
    lines.push('A: ' + item.a);
    lines.push('');
  });
  var blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = ((kitData.company || 'kit') + '-' + (kitData.role || 'application')).toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.txt';
  a.click();
}

function addToPipeline() {
  if (!kitData) return;
  var btn = event.target;
  btn.textContent = 'Saving...';
  fetch('/sourced/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getSession() },
    body: JSON.stringify({ url: kitData.url || JOB_URL, status: 'applying' }),
  }).then(function() {
    btn.textContent = 'Saved ✓';
    btn.style.color = '#4ade80';
  }).catch(function() { btn.textContent = 'Saved ✓'; });
}

function toggleRetry() {
  var d = document.getElementById('retryDrawer');
  d.style.display = d.style.display === 'block' ? 'none' : 'block';
  if (d.style.display === 'block') document.getElementById('retryNote').focus();
}
function closeRetry() { document.getElementById('retryDrawer').style.display = 'none'; }
function doRetry() {
  var note = document.getElementById('retryNote').value.trim();
  closeRetry();
  document.getElementById('kit').style.display = 'none';
  document.getElementById('kitActions').style.display = 'none';
  document.getElementById('loadWrap').style.display = 'block';
  document.getElementById('loadDone').style.display = 'none';
  generate(getSession(), true, note);
}

// ── generate ──────────────────────────────────────────────────────────────────
var STEPS = [
  [0,   'Fetching their job posting...'],
  [25,  'Making Claude sweat...'],
  [55,  'Mapping your background...'],
  [80,  'Polishing the answers...'],
  [95,  'Almost there...'],
];
var stepIdx = 0, stepTimer = null;
function startSteps() {
  stepIdx = 0;
  function tick() {
    if (stepIdx >= STEPS.length) return;
    setStep(STEPS[stepIdx][1], STEPS[stepIdx][0]);
    stepIdx++;
    stepTimer = setTimeout(tick, 2800);
  }
  tick();
}

function generate(session, force, note) {
  startSteps();
  fetch('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + session },
    body: JSON.stringify({ url: JOB_URL, force: force || false, note: note || undefined }),
  })
  .then(function(r) {
    clearTimeout(stepTimer);
    if (r.status === 402) {
      showError('You\\'re out of credits. <a href="/buy" style="color:#ef4444;text-decoration:underline">Top up →</a>');
      return null;
    }
    if (r.status === 401) {
      document.getElementById('loadWrap').style.display = 'none';
      document.getElementById('loginBox').style.display = 'block';
      return null;
    }
    if (!r.ok) return r.json().then(function(e) { showError(e.error || 'Generation failed — try again?'); return null; });
    return r.json();
  })
  .then(function(kit) { if (kit) renderKit(kit); })
  .catch(function(e) { showError('Network error. <a href="" onclick="location.reload()" style="color:#ef4444;text-decoration:underline">Retry →</a>'); });
}

// ── keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', function(e) {
  if (!kitData) return;
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'Enter') { e.preventDefault(); openAndApply(); }
  if (e.key === 'd' || e.key === 'D') downloadKit();
  if (e.key === 'r' || e.key === 'R') toggleRetry();
});

// ── boot ──────────────────────────────────────────────────────────────────────
(function() {
  var session = getSession();
  if (!session) {
    document.getElementById('loadWrap').style.display = 'none';
    document.getElementById('loginBox').style.display = 'block';
    return;
  }
  setStep('Checking cache...', 5);
  fetch('/application?url=' + encodeURIComponent(JOB_URL), {
    headers: { 'Authorization': 'Bearer ' + session },
  })
  .then(function(r) { return r.ok ? r.json() : null; })
  .then(function(cached) {
    if (cached && cached.id) { showDone('Already got this one.'); renderKit(cached); }
    else { generate(session); }
  })
  .catch(function() { generate(session); });
})();
</script>
</body></html>`);
});

// Keep internal errors and stack traces out of browser/API responses. Route
// handlers log actionable context; clients receive a stable error contract.
app.use((error, _req, res, _next) => {
  if (error?.message === 'Origin not allowed') return res.status(403).json({ error: 'Origin not allowed' });
  console.error('[request error]', error);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  db.initSchema()
    .then(() => console.log('DB schema ready'))
    .catch(e => { console.error('DB schema init failed:', e.message); process.exit(1); })
    .then(() => {
      app.listen(PORT, () => {
        console.log(`\nJob Apply Server — http://localhost:${PORT}`);
        const count = fs.existsSync(APPS_DIR) ? fs.readdirSync(APPS_DIR).filter(f => f.endsWith('.json')).length : 0;
        console.log(`${count} applications loaded`);
        console.log(`AI: ${keys ? `enabled via ${keys.provider} (haiku)` : 'disabled — no API key found'}\n`);
        startCron();
      });
    });
}

module.exports = { app };
