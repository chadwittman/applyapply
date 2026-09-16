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
const { zipDirectory } = require('./zip');
const { getProfileByUserEmail, setProfile, getUser, getOrCreateUser, addUserCredits, deductUserCredits, createMagicLink, getMagicLink, useMagicLink, PROFILE_FIELDS: DB_PROFILE_FIELDS } = require('./db');
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
const VERSION = '0.24.0';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const APP_ORIGIN = process.env.APP_ORIGIN || 'http://localhost:5000';
const ALLOWED_WEB_ORIGINS = new Set(
  (process.env.CORS_ORIGINS || APP_ORIGIN)
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
);

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

// Brand assets: icons, the social card, and the web app manifest. Cached hard
// because every filename is stable and the art rarely changes.
app.use('/brand', express.static(path.join(__dirname, '../brand'), {
  maxAge: '30d', immutable: false, fallthrough: true,
}));

// Canonical origin for absolute URLs in social tags. Crawlers do not run
// JavaScript and will not follow a relative og:image.
function escapeHtml(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function metaHead({ title, desc, path: urlPath = '/', noindex = false }) {
  const origin = APP_ORIGIN.replace(/\/$/, '');
  const url = origin + urlPath;
  const img = origin + '/brand/og.png';
  const esc = escapeHtml;
  return `<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(url)}">
${noindex ? '<meta name="robots" content="noindex,nofollow">' : '<meta name="robots" content="index,follow">'}
<link rel="icon" href="/brand/favicon.ico" sizes="any">
<link rel="icon" type="image/png" href="/brand/icon-32.png" sizes="32x32">
<link rel="icon" type="image/png" href="/brand/icon-192.png" sizes="192x192">
<link rel="apple-touch-icon" href="/brand/icon-180.png">
<link rel="manifest" href="/brand/site.webmanifest">
<meta name="theme-color" content="#0a0a0a">
<meta property="og:type" content="website">
<meta property="og:site_name" content="applyapply">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="applyapply — job applications, done for you.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}">`;
}

// Only the marketing surface should be crawled; everything else is a signed-in
// app page and is marked noindex in its head as well.
// The extension is not on the Web Store yet, so this is how it reaches a
// second machine or an early user: a zip built from the same folder that is
// deployed, so it can never drift from what is running.
let extZipCache = null;
function extensionZip() {
  if (extZipCache) return extZipCache;
  const dir = path.join(__dirname, '../extension');
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version;
  extZipCache = { version, buf: zipDirectory(dir) };
  return extZipCache;
}

app.get('/extension.zip', (req, res) => {
  try {
    const { version, buf } = extensionZip();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition',
      `attachment; filename="applyapply-extension-${version}.zip"`);
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(buf);
  } catch (e) {
    console.error('[extension.zip]', e.message);
    res.status(500).send('Could not build the extension archive');
  }
});

app.get('/extension', (req, res) => {
  let version = '';
  try { version = extensionZip().version; } catch {}
  res.setHeader('Cache-Control', 'no-store');
  res.send(`<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${metaHead({title:'Install the extension — applyapply', desc:'Add applyapply to Chrome. It fills job application forms with your generated apply kit.', path:'/extension'})}
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#000;color:#fff;-webkit-font-smoothing:antialiased}
a{text-decoration:none;color:inherit}
${NAV_CSS}
.wrap{max-width:660px;margin:0 auto;padding:56px 24px 120px}
h1{font-size:30px;font-weight:800;letter-spacing:-.04em;margin-bottom:10px}
.sub{font-size:14px;color:#fff;margin-bottom:34px;line-height:1.6}
.dl{display:inline-flex;align-items:center;gap:12px;background:#fff;color:#000;font-size:15px;font-weight:700;padding:15px 28px;letter-spacing:-.01em}
.dl:hover{background:#e5e5e5}
.ver{font-size:12px;color:#8f8f8f;margin-top:12px}
ol{margin:40px 0 0;padding:0;list-style:none;counter-reset:step}
li{counter-increment:step;position:relative;padding:0 0 22px 46px;font-size:14px;line-height:1.65}
li::before{content:counter(step);position:absolute;left:0;top:-1px;width:28px;height:28px;background:#fff;color:#000;font-size:13px;font-weight:700;display:flex;align-items:center;justify-content:center}
li b{font-weight:700}
code{background:#111;border:1px solid #1e1e1e;padding:2px 7px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.note{margin-top:34px;padding:18px;border:1px solid #1e1e1e;background:#080808;font-size:13px;line-height:1.65}
</style></head><body>
<div class="topbar"><a href="/" class="logo">applyapply</a><div class="nav">${navHTML('/extension')}</div></div>
<div class="wrap">
  <h1>Install the extension</h1>
  <div class="sub">It opens on a job posting, fills the form from your apply kit, and attaches your tailored resume.</div>

  <a class="dl" href="/extension.zip" download>Download for Chrome</a>
  <div class="ver">Version ${escapeHtml(version)} &middot; works in Chrome, Edge, Brave and Arc</div>

  <ol>
    <li>Unzip the download, then move the unzipped folder somewhere permanent &mdash; your home folder is fine. Chrome loads the extension from that folder every time it starts, so moving or deleting it later uninstalls the extension.</li>
    <li>Open <code>chrome://extensions</code> in a new tab.</li>
    <li>Turn on <b>Developer mode</b> using the switch in the top right.</li>
    <li>Click <b>Load unpacked</b> and pick that folder &mdash; the one with <code>manifest.json</code> directly inside it.</li>
    <li>Click the applyapply icon in your toolbar and <b>Sign in</b>. The same account and credits you already have.</li>
  </ol>

  <div class="note">Developer mode is only needed because applyapply is not in the Chrome Web Store yet. Once it is listed, installing is one click and Chrome keeps it updated and synced across your machines on its own.</div>
</div>
</body></html>`);
});

app.get('/robots.txt', (req, res) => {
  const origin = APP_ORIGIN.replace(/\/$/, '');
  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /$',
    'Allow: /buy',
    'Allow: /extension',
    'Allow: /brand/',
    'Disallow: /pipeline',
    'Disallow: /sourcing',
    'Disallow: /setup',
    'Disallow: /login',
    'Disallow: /auth/',
    'Disallow: /checkout',
    'Disallow: /admin/',
    'Disallow: /https://',
    'Disallow: /http://',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n'));
});

app.get('/sitemap.xml', (req, res) => {
  const origin = APP_ORIGIN.replace(/\/$/, '');
  const day = new Date().toISOString().slice(0, 10);
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    ['/', '/buy', '/extension'].map(u =>
      `  <url><loc>${origin}${u}</loc><lastmod>${day}</lastmod></url>`).join('\n') +
    `\n</urlset>\n`);
});

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
  resume: 8,
  analyze: 3,
  interview: 3,
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
        // from overspending. Return the reservation if the handler fails — or if
        // it did no billable work, which a handler signals with res.noCharge().
        let refunded = false;
        res.noCharge = () => { res.locals.noCharge = true; };
        res.on('finish', () => {
          if ((res.statusCode < 400 && !res.locals.noCharge) || refunded) return;
          refunded = true;
          addUserCredits(payload.email, cost)
            .catch(error => console.error(`[credits] refund failed for ${payload.email}:`, error.message));
        });
      }
      req.userEmail = payload.email;
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


// One navigation for every page. Each page had invented its own set of links,
// which is how /sourcing ended up with no way to reach /pipeline — the page
// where its own results land — and how /buy stranded people after paying.
function navHTML(active = '') {
  const items = [
    ['/pipeline', 'Pipeline'],
    ['/sourcing', 'Sourcing'],
    ['/setup', 'Profile'],
    ['/extension', 'Extension'],
    ['/buy', 'Credits'],
  ];
  return items.map(([href, label]) =>
    `<a href="${href}" class="nav-item${href === active ? ' nav-active' : ''}">${label}</a>`
  ).join('');
}

const NAV_CSS = `
.nav-item{font-size:12px;color:#b9b9b9;text-decoration:none;margin-right:14px;padding-bottom:2px;border-bottom:1px solid transparent}
.nav-item:hover{color:#fff}
.nav-active{color:#fff;border-bottom-color:#fff}
`;

// ── Landing page ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${metaHead({title:'applyapply — job applications, done for you', desc:'Agents find the roles overnight, AI writes the apply kit, and the Chrome extension fills the form. Stop retyping your resume into every job board.', path:'/'})}
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
.step-n{font-size:11px;color:#b9b9b9;padding-top:3px}
.step h3{font-size:15px;font-weight:600;margin-bottom:6px;letter-spacing:-.01em}
.step p{font-size:15px;color:#bbb;line-height:1.65}
.demo-outer{max-width:680px}
.drole-bar{display:flex;gap:6px;flex-wrap:wrap;margin:20px 0 16px}
.drole{padding:7px 14px;background:transparent;color:#b9b9b9;border:1px solid #1a1a1a;font-size:12px;cursor:pointer;font-family:inherit;transition:color .1s,border-color .1s}
.drole:hover{color:#ccc;border-color:#444}
.drole.active{color:#fff;border-color:#555;background:#0d0d0d}
.demo-stage{position:relative;overflow:hidden;background:#050505;border:1px solid #1a1a1a}
.demo-log{padding:16px 20px;font-family:'SF Mono',Monaco,monospace;font-size:12px;line-height:2.1;transition:opacity .3s;min-height:150px}
.dlog-line{color:#b9b9b9;animation:logslide .22s ease}
.dlog-line.done{color:#4a9}
@keyframes logslide{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
.djob{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:14px 20px;border-top:1px solid #111;cursor:pointer;opacity:0;transform:translateY(6px);transition:opacity .22s,transform .22s,background .12s,box-shadow .12s}
.djob:hover{background:#0a0a0a}
.djob.selected{background:#0d0d0d;box-shadow:inset 2px 0 0 #fff}
.djob.visible{opacity:1;transform:none}
.djob-co{font-size:13px;font-weight:600;color:#fff;margin-bottom:2px}
.djob-role{font-size:12px;color:#888;margin-bottom:3px}
.djob-meta{font-size:11px;color:#b9b9b9}
.djob-right{text-align:right;flex-shrink:0}
.djob-fit{font-size:18px;font-weight:700;color:#fff;line-height:1}
.djob-denom{font-size:11px;color:#b9b9b9;font-weight:400}
.djob-fit-lbl{font-size:10px;color:#b9b9b9;letter-spacing:.04em;text-transform:uppercase;margin-top:2px}
.demo-sidebar{position:absolute;top:0;right:0;bottom:0;width:308px;background:#090909;border-left:1px solid #1e1e1e;display:flex;flex-direction:column;transform:translateX(100%);transition:transform .28s cubic-bezier(.4,0,.2,1)}
.demo-sidebar.open{transform:translateX(0)}
.dsb-top{display:flex;justify-content:space-between;align-items:flex-start;padding:14px 16px;border-bottom:1px solid #161616;background:#0d0d0d;flex-shrink:0}
.dsb-co{font-size:12px;font-weight:700;color:#fff;margin-bottom:3px}
.dsb-role-lbl{font-size:11px;color:#b9b9b9}
.dsb-close{background:none;border:none;color:#b9b9b9;cursor:pointer;font-size:14px;padding:0;line-height:1;margin-left:8px;flex-shrink:0}
.dsb-close:hover{color:#ccc}
.dsb-body{flex:1;overflow-y:auto}
.dsb-gen{font-size:12px;color:#b9b9b9;padding:20px 16px;animation:genpulse 1.2s ease-in-out infinite}
@keyframes genpulse{0%,100%{opacity:.4}50%{opacity:1}}
.blink{animation:blink .9s step-end infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}
#dsb-kit{display:none}
.dsb-sec{padding:13px 16px;border-bottom:1px solid #111}
.dsb-sec:last-child{border-bottom:none}
.dsb-lbl{font-size:10px;color:#b9b9b9;letter-spacing:.06em;text-transform:uppercase;margin-bottom:7px}
.dsb-txt{font-size:12px;color:#bbb;line-height:1.75}
.dsb-foot{padding:12px 16px;border-top:1px solid #161616;flex-shrink:0}
.dsb-apply-btn{width:100%;padding:9px;background:#fff;color:#000;border:none;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}
.dsb-apply-btn:hover{background:#e0e0e0}
.time-table{margin-top:28px}
.time-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0;padding:18px 0;border-top:1px solid #111;align-items:baseline}
.time-row:last-child{border-bottom:1px solid #111}
.time-task{font-size:14px;font-weight:500;color:#fff}
.time-before{font-size:13px;color:#b9b9b9;text-decoration:line-through;text-decoration-color:#444}
.time-after{font-size:14px;color:#ccc;font-weight:500}
.price-n{font-size:56px;font-weight:700;letter-spacing:-.05em;line-height:1;margin-bottom:8px}
.price-s{font-size:15px;color:#bbb;margin-bottom:12px}
.price-d{font-size:13px;color:#888;margin-bottom:24px}
.price-d span{margin-right:18px}
.price-body{font-size:15px;color:#ccc;line-height:1.75;max-width:480px;margin-top:24px}
.price-body+.price-body{margin-top:14px}
.price-cta{margin-top:28px}
footer{padding:24px 32px;border-top:1px solid #111;display:flex;justify-content:space-between;align-items:center}
.fc{font-size:12px;color:#b9b9b9}
.fl{display:flex;gap:16px}
.fl a{font-size:12px;color:#c4c4c4}
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
${metaHead({title:'Sign in — applyapply', desc:'Sign in with a magic link. No password to remember.', path:'/login', noindex:true})}
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#000;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;-webkit-font-smoothing:antialiased}
a{text-decoration:none;color:inherit}
.mark{font-size:13px;font-weight:700;letter-spacing:-.02em;color:#b9b9b9;margin-bottom:48px}
h1{font-size:24px;font-weight:700;letter-spacing:-.03em;margin-bottom:10px}
.sub{font-size:15px;color:#aaa;margin-bottom:32px}
.form{width:300px}
input{display:block;width:100%;padding:11px 13px;background:#0a0a0a;border:1px solid #222;color:#fff;font-size:15px;outline:none;font-family:inherit;margin-bottom:10px}
input:focus{border-color:#444}
input::placeholder{color:#a8a8a8}
.btn{display:block;width:100%;padding:11px;background:#fff;color:#000;border:none;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
.btn:hover{background:#e5e5e5}
.btn:disabled{opacity:.3;cursor:default}
#msg{margin-top:12px;font-size:13px;min-height:16px;text-align:center;color:#b9b9b9}
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
          <li><a href="${origin}/extension" style="color:#2563eb">Install the Chrome extension</a> — open it on any job page and hit Generate. The kit writes itself.</li>
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
${metaHead({title:'Signed in — applyapply', desc:'You are signed in.', path:'/auth/success', noindex:true})}
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#000;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;-webkit-font-smoothing:antialiased}
a{text-decoration:none;color:inherit}
.mark{font-size:13px;font-weight:700;letter-spacing:-.02em;color:#9a9a9a;margin-bottom:48px}
h1{font-size:22px;font-weight:700;letter-spacing:-.03em;margin-bottom:8px}
.em{font-size:13px;color:#9a9a9a;margin-bottom:32px}
.btn{display:inline-block;padding:10px 20px;background:#fff;color:#000;font-size:13px;font-weight:600;cursor:pointer;letter-spacing:-.01em}
.btn:hover{background:#e5e5e5}
#extStatus{margin-top:20px;font-size:12px;color:#8f8f8f;min-height:16px}
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

app.post('/admin/credits/add-by-email', requireAdmin, async (req, res) => {
  const { email, credits } = req.body;
  if (!email || !credits) return res.status(400).json({ error: 'email and credits required' });
  const normalized = email.toLowerCase();
  await getOrCreateUser(normalized);
  await addUserCredits(normalized, credits);
  const user = await getUser(normalized);
  res.json({ ok: true, email: normalized, balance: user?.credits });
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


// GET /buy — simple purchase page
app.get('/buy', (req, res) => {
  const stripeKey = loadStripeKey();
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${metaHead({title:'Buy credits — applyapply', desc:'Credits pay for sourcing runs and generated apply kits. No subscription.', path:'/buy'})}
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#000;color:#fff;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;-webkit-font-smoothing:antialiased}
a{text-decoration:none;color:inherit}
.mark{font-size:13px;font-weight:700;letter-spacing:-.02em;color:#9a9a9a;margin-bottom:48px}
.price{font-size:52px;font-weight:700;letter-spacing:-.05em;line-height:1;margin-bottom:6px}
.price-s{font-size:14px;color:#888;margin-bottom:20px}
.form{width:300px}
label{display:block;font-size:11px;color:#9a9a9a;letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px}
input{display:block;width:100%;padding:10px 12px;background:#0a0a0a;border:1px solid #1a1a1a;color:#fff;font-size:14px;outline:none;font-family:inherit;margin-bottom:10px}
input:focus{border-color:#2a2a2a}
input::placeholder{color:#6a6a6a}
button{width:100%;padding:10px;background:#fff;color:#000;border:none;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
button:hover{background:#e5e5e5}
button:disabled{opacity:.3;cursor:default}
.error{font-size:12px;color:#f87171;margin-top:10px;display:none}
</style>
</head>
<body>
<a href="/" class="mark">applyapply</a>
<div style="position:fixed;top:16px;right:20px;display:flex;gap:14px">
  <a href="/pipeline" style="font-size:12px;color:#b9b9b9;text-decoration:none">Pipeline</a>
  <a href="/sourcing" style="font-size:12px;color:#b9b9b9;text-decoration:none">Sourcing</a>
  <a href="/setup" style="font-size:12px;color:#b9b9b9;text-decoration:none">Profile</a>
</div>
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
<head><meta charset="utf-8">${metaHead({title:"You're in — applyapply", desc:'Your credits are ready.', path:'/checkout/success', noindex:true})}
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#ccc;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{width:440px;padding:40px;border:1px solid #1a1a1a;border-radius:8px;text-align:center}
.check{font-size:42px;margin-bottom:16px}
h2{font-size:20px;font-weight:700;color:#fff;margin-bottom:8px}
.sub{font-size:13px;color:#b9b9b9;line-height:1.6;margin-bottom:28px}
.email-box{background:#111;border:1px solid #222;border-radius:6px;padding:10px 14px;font-size:13px;color:#4ade80;margin-bottom:24px}
.steps{text-align:left;font-size:13px;color:#b9b9b9;line-height:2}
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

  // This endpoint mints credits, so an unverified event is never trusted. The
  // previous form fell back to req.body whenever the secret or the raw body was
  // missing, which would have turned a body-parser change into a way for anyone
  // to grant themselves credits by POSTing a checkout.session.completed.
  if (!webhookSecret) {
    console.error('[stripe webhook] STRIPE_WEBHOOK_SECRET is not set — refusing to process');
    return res.status(503).send('Webhook not configured');
  }
  if (!req.rawBody) {
    console.error('[stripe webhook] no raw body captured — refusing to process');
    return res.status(400).send('Webhook error: raw body unavailable');
  }
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.headers['stripe-signature'], webhookSecret);
  } catch (e) {
    console.error('[stripe webhook] signature failed:', e.message);
    return res.status(400).send(`Webhook error: ${e.message}`);
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
// Self-hosted single-user mode only. This is one real person's identity, so it
// must never reach a signed-in account: merged as a fallback it quietly filled
// this name, email and phone into other people's applications wherever their
// own profile had a gap, and an account with no profile row got all of it.
const LOCAL_PROFILE = {
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

// Every profile key, blank. A missing field must stay missing rather than
// inherit somebody else's answer.
const BLANK_PROFILE = Object.fromEntries(Object.keys(LOCAL_PROFILE).map(k => [k, '']));

// Local self-hosted mode keeps its convenience profile; a real account never
// falls back past its own data.
function isLocalMode(req) {
  return !IS_PRODUCTION && !req.userEmail && isLocalRequest(req);
}

async function resolveProfile(req) {
  if (req.userEmail) {
    const p = await getProfileByUserEmail(req.userEmail);
    const merged = { ...BLANK_PROFILE };
    for (const [k, v] of Object.entries(p || {})) { if (v != null && v !== '') merged[k] = v; }
    return merged;
  }
  return isLocalMode(req) ? LOCAL_PROFILE : { ...BLANK_PROFILE };
}

// ── Profile endpoints ─────────────────────────────────────────────────────────

function authFromRequest(req) {
  const bearer = req.headers['authorization']?.match(/^Bearer (.+)/)?.[1]
    || (req.headers['x-api-key']?.startsWith('eyJ') ? req.headers['x-api-key'] : null);
  if (bearer) {
    const payload = verifySession(bearer);
    return payload ? { type: 'jwt', email: payload.email } : null;
  }
  if (isLocalRequest(req)) return { type: 'local' };
  return null;
}

app.get('/profile', async (req, res) => {
  const auth = authFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'Sign in required' });
  if (auth.type === 'local') return res.json(isLocalMode(req) ? LOCAL_PROFILE : {});
  res.json(await getProfileByUserEmail(auth.email) || {});
});

app.post('/profile', async (req, res) => {
  const auth = authFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'Sign in required' });
  if (auth.type === 'local') return res.json({ ok: true, note: 'local mode' });
  // Only forward fields the client actually sent — setProfile treats absent as
  // "leave alone". The extension popup posts 8 contact fields; it must not null
  // out bio/resume_text/target_roles just because it doesn't know about them.
  const data = {};
  for (const f of DB_PROFILE_FIELDS) if (req.body[f] !== undefined) data[f] = req.body[f];
  await setProfile(auth.email, data, true);
  res.json({ ok: true });
});

// ── Resume parse ─────────────────────────────────────────────────────────────

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.post('/resume/parse', apiLimiter, async (req, res) => {
  const auth = authFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'Sign in required' });
  if (auth.type === 'jwt') req.userEmail = auth.email;
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

    // Keep the file itself. Only the extracted text was stored before, so the
    // original could never be reviewed or re-downloaded once uploaded.
    if (req.userEmail) {
      db.saveResumeFile(req.userEmail, req.file.originalname || 'resume.pdf',
        req.file.mimetype || 'application/pdf', req.file.buffer)
        .catch(e => console.error('[resume file]', e.message));
    }

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

app.get('/resume/file', async (req, res) => {
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  const row = await db.getResumeFile(userEmail);
  if (!row) return res.status(404).json({ error: 'No resume on file' });
  res.setHeader('Content-Type', row.mime || 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${(row.filename || 'resume.pdf').replace(/"/g, '')}"`);
  res.send(row.bytes);
});

app.get('/resume/meta', async (req, res) => {
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  const row = await db.getResumeFileMeta(userEmail);
  res.json(row || {});
});

// ── Setup page ────────────────────────────────────────────────────────────────

app.get('/setup', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${metaHead({title:'Profile — applyapply', desc:'Your background, target roles and resume. This is what the AI reads.', path:'/setup', noindex:true})}
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
input::placeholder,textarea::placeholder{color:#a8a8a8}
select option{background:#111}
textarea{min-height:200px;resize:vertical;line-height:1.65}
.role-pick{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.role-pill{padding:4px 9px;background:#0a0a0a;border:1px solid #222;color:#8f8f8f;font-size:11px;cursor:pointer;font-family:inherit}
.role-pill:hover{border-color:#555;color:#ccc}
.role-pill.on{background:#0d1a0d;border-color:#2a3a2a;color:#4ade80}
.resume-file{display:flex;align-items:center;gap:10px;font-size:12px;color:#b9b9b9;margin-top:10px}
.resume-file a{color:#60a5fa;text-decoration:underline}
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
    <a href="/buy" class="nav-link">Credits</a>
  </div>
</nav>
<div class="wrap">
<h1>Your profile</h1>
<p class="auth-status" id="authStatus"></p>

<div class="sec">
  <div class="sec-label">Resume</div>
  <div class="resume-drop" id="resumeDrop">
    <input type="file" id="resumeFile" accept=".pdf" style="display:none"/>
    <textarea id="resume_text" style="display:none"></textarea>
    <div class="resume-drop-label">Drop your resume PDF here, or <span class="resume-drop-browse" onclick="document.getElementById('resumeFile').click()">browse</span></div>
    <div id="resumeStatus"></div>
  </div>
  <div class="resume-file" id="resumeFileRow" style="display:none">
    <span id="resumeFileName"></span>
    <a href="/resume/file" id="resumeDownload">Download to review ↓</a>
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
    <div class="role-pick">${PRESET_ROLES.map(r => `<button type="button" class="role-pill" onclick="toggleRole(this)">${r}</button>`).join('')}</div>
    <input id="target_roles" placeholder="Head of Product, VP of Product, Founding PM"/>
    <div class="hint">Click the titles you want, or type your own. The sourcing agent searches for these exact titles, so leaving this empty gives poor results.</div>
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

<div class="sec">
  <div class="sec-label">Interview</div>
  <div class="hint" style="margin-bottom:14px;line-height:1.7">Your resume was written for the roles you held. If you're targeting something different, the work that matters most is often missing from it entirely. These questions dig it out, and every answer feeds every future application and tailored resume.</div>
  <div id="interviewList"></div>
  <button type="button" id="genQBtn" onclick="generateQuestions()" style="padding:9px 16px;background:#0a0a0a;border:1px solid #333;color:#fff;font-size:13px;cursor:pointer;font-family:inherit">Find my gaps &amp; ask me — ${CREDIT_COSTS.interview} credits</button>
  <div class="hint" id="interviewStatus" style="margin-top:8px;min-height:16px"></div>
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
const FIELDS=['first_name','last_name','email','phone','location','work_authorization','linkedin','github','twitter','website','current_employer','school','salary','bio','career_type','target_roles','location_pref','resume_text'];

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
    syncRolePills();
  }catch(e){authEl.textContent='Could not load profile.';}
}
load();
loadInterview();
showResumeFile();

function esc(t){return String(t==null?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

// Role pills drive the comma list, so the field can be filled by clicking.
function toggleRole(btn){
  btn.classList.toggle('on');
  var picked=[].slice.call(document.querySelectorAll('.role-pill.on')).map(function(b){return b.textContent.trim();});
  var input=document.getElementById('target_roles');
  var typed=input.value.split(',').map(function(x){return x.trim();}).filter(Boolean);
  var preset=[].slice.call(document.querySelectorAll('.role-pill')).map(function(b){return b.textContent.trim();});
  var custom=typed.filter(function(t){return preset.indexOf(t)===-1;});
  input.value=picked.concat(custom).join(', ');
}

function syncRolePills(){
  var input=document.getElementById('target_roles');
  if(!input)return;
  var have=input.value.split(',').map(function(x){return x.trim().toLowerCase();}).filter(Boolean);
  document.querySelectorAll('.role-pill').forEach(function(b){
    b.classList.toggle('on', have.indexOf(b.textContent.trim().toLowerCase())>=0);
  });
}

function showResumeFile(){
  fetch('/resume/meta',{headers:{'x-api-key':getKey()}}).then(function(r){return r.ok?r.json():null;}).then(function(m){
    if(!m||!m.filename)return;
    document.getElementById('resumeFileRow').style.display='flex';
    var kb=m.size?Math.round(m.size/1024)+' KB · ':'';
    document.getElementById('resumeFileName').textContent=m.filename+' ('+kb+'uploaded '+new Date(m.uploaded_at).toLocaleDateString()+')';
  }).catch(function(){});
}

var EVIDENCE=[];
var BTN_S='padding:5px 10px;background:#0a0a0a;border:1px solid #2a2a2a;color:#aaa;font-size:11px;cursor:pointer;font-family:inherit';

async function loadInterview(){
  const key=getKey(); if(!key) return;
  try{ const r=await fetch('/interview',{headers:{'x-api-key':key}});
    if(r.ok){ EVIDENCE=await r.json(); renderInterview(); } }catch(e){}
}

function renderInterview(){
  const el=document.getElementById('interviewList');
  if(!el) return;
  if(!EVIDENCE.length){ el.innerHTML=''; return; }
  el.innerHTML=EVIDENCE.map(function(e){
    return '<div class="field">'
      +'<label>'+esc(e.question)+'</label>'
      +'<textarea id="ans-'+e.id+'" style="min-height:74px" placeholder="Your own words. Specifics beat adjectives — what you owned, what shipped, what moved.">'+esc(e.answer||'')+'</textarea>'
      +'<div style="display:flex;gap:8px;margin-top:6px;align-items:center">'
      +'<button type="button" style="'+BTN_S+'" onclick="voiceAnswer(this,'+e.id+')">🎤 Speak it</button>'
      +'<button type="button" style="'+BTN_S+'" onclick="saveAnswer('+e.id+')">Save answer</button>'
      +'<span class="hint" id="st-'+e.id+'"></span>'
      +'</div></div>';
  }).join('');
}

async function generateQuestions(){
  const key=getKey(); const st=document.getElementById('interviewStatus');
  const btn=document.getElementById('genQBtn');
  if(!key){ st.textContent='Sign in first'; return; }
  btn.disabled=true; const orig=btn.textContent; btn.textContent='Looking for gaps…';
  st.textContent='Comparing your resume against what you are targeting…';
  try{
    const r=await fetch('/interview/questions',{method:'POST',headers:{'x-api-key':key,'content-type':'application/json'},body:'{}'});
    const j=await r.json();
    if(!r.ok){ st.textContent=j.error||'Failed'; st.style.color='#f87171'; }
    else { EVIDENCE=j.questions||[]; renderInterview(); st.textContent='Answer what you can. Blank ones are just skipped.'; st.style.color=''; }
  }catch(e){ st.textContent='Error: '+e.message; st.style.color='#f87171'; }
  btn.disabled=false; btn.textContent=orig;
}

async function saveAnswer(id){
  const key=getKey(); const ta=document.getElementById('ans-'+id); const st=document.getElementById('st-'+id);
  if(!key||!ta) return;
  st.textContent='Saving…';
  try{
    const r=await fetch('/interview/answer',{method:'POST',headers:{'x-api-key':key,'content-type':'application/json'},body:JSON.stringify({id:id,answer:ta.value})});
    st.textContent=r.ok?'Saved':'Failed';
    if(r.ok){ const row=EVIDENCE.find(function(e){return e.id===id;}); if(row) row.answer=ta.value; }
  }catch(e){ st.textContent='Failed'; }
  setTimeout(function(){ st.textContent=''; },2000);
}

function voiceAnswer(btn,id){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){ alert('Voice needs Chrome.'); return; }
  const ta=document.getElementById('ans-'+id); const st=document.getElementById('st-'+id);
  const rec=new SR(); rec.continuous=true; rec.interimResults=false;
  let chunks=[];
  btn.textContent='⏹ Stop'; st.textContent='Listening…';
  rec.onresult=function(ev){ for(let i=ev.resultIndex;i<ev.results.length;i++) chunks.push(ev.results[i][0].transcript); };
  rec.onerror=function(){ btn.textContent='🎤 Speak it'; st.textContent=''; };
  rec.onend=async function(){
    btn.textContent='🎤 Speak it';
    const raw=chunks.join(' ').trim();
    if(!raw){ st.textContent=''; return; }
    st.textContent='Cleaning up…';
    const key=getKey();
    const q=EVIDENCE.find(function(e){return e.id===id;});
    try{
      const r=await fetch('/voice',{method:'POST',headers:{'x-api-key':key,'content-type':'application/json'},body:JSON.stringify({transcript:raw,question:q?q.question:''})});
      const j=await r.json();
      ta.value=(ta.value?ta.value+'\\n\\n':'')+((r.ok&&j.text)?j.text:raw);
    }catch(e){ ta.value=(ta.value?ta.value+'\\n\\n':'')+raw; }
    st.textContent=''; saveAnswer(id);
  };
  btn.onclick=function(){ rec.stop(); btn.onclick=function(){ voiceAnswer(btn,id); }; };
  rec.start();
}

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
    if(j.text)document.getElementById('resume_text').value=j.text;
    syncRolePills();
    showResumeFile();
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
  // Send every field this page owns, empty ones included — the server treats an
  // absent field as "leave alone", so omitting blanks would make clearing impossible.
  for(const f of FIELDS){const el=document.getElementById(f);if(!el)continue;data[f]=el.value.trim();}
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

async function loadApps(userEmail = null) {
  try { return await db.getKits(userEmail); } catch { return []; }
}

async function findApplicationByUrl(url, userEmail = null) {
  const normalize = p => p.replace(/\/(apply|application)$/, '');
  try {
    // An unowned kit (generated in local mode) is not "everyone's" — getKits
    // scopes to the caller whenever we know who they are.
    for (const app of await db.getKits(userEmail)) {
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

async function loadKit(id, userEmail) {
  let kit = null;
  try { kit = await db.getKit(id); } catch { return null; }
  if (!kit) return null;
  if (userEmail && kit.user_email !== userEmail) return 'forbidden';
  return kit;
}

// Standard fields come back with stable names; custom questions get opaque
// question_<id> names, so anything worth skipping there must match on label.
const GH_SKIP_FIELDS = new Set(['first_name','last_name','preferred_name','email','phone','resume','cover_letter','location','linkedin_profile','website']);
const GH_SKIP_LABELS = new Set(['linkedin profile','linkedin','website','portfolio','resume/cv','resume','cover letter','github']);
const ASHBY_SKIP_LABELS = new Set(['First Name','Last Name','Email','Phone','Resume','LinkedIn Profile','Website','Cover Letter','Location','City','Country']);
const ATS_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

async function greenhouseQuestions(board, jobId) {
  // ?questions=true is required — without it the API omits `questions`
  // entirely, which silently produced kits with no screening answers at all.
  const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jobId}?questions=true`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const data = await r.json();
  if (!Array.isArray(data.questions)) return null;
  return data.questions
    .filter(q => q.label
      && !GH_SKIP_FIELDS.has(q.fields?.[0]?.name)
      && !GH_SKIP_LABELS.has(q.label.trim().toLowerCase()))
    .map(q => q.label.trim());
}

async function leverQuestions(company, postingId) {
  const r = await fetch(`https://api.lever.co/v0/postings/${company}/${postingId}?mode=json`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const data = await r.json();
  const questions = [];
  if (data.additionalPlain) {
    data.additionalPlain.split('\n').forEach(l => { l = l.trim(); if (l.endsWith('?') && l.length > 10) questions.push(l); });
  }
  return questions;
}

async function ashbyQuestions(applicationUrl) {
  const r = await fetch(applicationUrl, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': ATS_UA } });
  if (!r.ok) return null;
  const html = await r.text();
  const found = [];
  let m, re = /<label[^>]*>([^<]{8,300})<\/label>/gi;
  while ((m = re.exec(html)) !== null) {
    const label = m[1].replace(/\s+/g, ' ').replace(/<[^>]+>/g, '').trim().replace(/\s*\*\s*$/, '');
    if (label && !ASHBY_SKIP_LABELS.has(label) && found.length < 12) found.push(label);
  }
  return found;
}

// Returns the application form's real questions, or null if we can't tell.
// Each ATS is reachable two ways: hosted on the ATS's own domain, or embedded
// on the company's careers site with the job id in a query param.
async function fetchATSFormQuestions(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    const parts = u.pathname.split('/').filter(Boolean);
    const qp = u.searchParams;
    // For an embed, the board token is usually the company's own domain name.
    const slug = host.replace(/^www\./, '').split('.')[0].toLowerCase();

    if (host.includes('greenhouse.io')) {
      const i = parts.indexOf('jobs');
      if (i !== -1 && parts[0] && parts[i + 1]) return await greenhouseQuestions(parts[0], parts[i + 1]);
    } else if (qp.has('gh_jid')) {
      const q = await greenhouseQuestions(slug, qp.get('gh_jid'));
      if (q) return q;
    }

    if (host.includes('lever.co') && parts.length >= 2) {
      return await leverQuestions(parts[0], parts[1]);
    } else if (qp.has('lever_job_id')) {
      const q = await leverQuestions(slug, qp.get('lever_job_id'));
      if (q) return q;
    }

    if (host.includes('ashbyhq.com') && parts.length >= 2) {
      return await ashbyQuestions(url.split('?')[0].replace(/\/application$/, '') + '/application');
    } else if (qp.has('ashby_jid')) {
      const q = await ashbyQuestions(`https://jobs.ashbyhq.com/${slug}/${qp.get('ashby_jid')}/application`);
      if (q) return q;
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

app.get('/health', async (req, res) => {
  const count = await db.countKits().catch(() => 0);
  res.json({ status: 'ok', version: VERSION, applications: count, ai: !!keys, provider: keys?.provider });
});

// Lookup a previously generated application by job URL
// Kits carry name, email, phone, LinkedIn, salary expectation and bio — these
// routes must never serve one to an anonymous caller. The ownership checks in
// findApplicationByUrl/loadKit are skipped when userEmail is null, so require
// a resolved identity up front.
app.get('/application', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url param required' });
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  const app = await findApplicationByUrl(url, userEmail);
  if (app) return res.json(app);
  res.status(404).json({ error: 'No application found' });
});

app.get('/application/:id', async (req, res) => {
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  const kit = await loadKit(req.params.id, userEmail);
  if (!kit) return res.status(404).json({ error: 'Not found' });
  if (kit === 'forbidden') return res.status(403).json({ error: 'Forbidden' });
  res.json(kit);
});

app.get('/applications', async (req, res) => {
  try {
    // Without an identity loadApps returns every user's kits — which companies
    // and roles someone is applying to is exactly what must not leak.
    const userEmail = reqUserEmail(req);
    if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
    const apps = await loadApps(userEmail);
    res.json(apps.map(({ id, company, role, url, tier, fit_score, sourced_date, applied_at }) => ({
      id, company, role, url, tier, fit_score, sourced_date, applied_at
    })).sort((a, b) => (b.fit_score || 0) - (a.fit_score || 0)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// AI field-mapping — accepts optional screenshot for visual form analysis
app.post('/analyze', apiLimiter, requireCredits('analyze'), async (req, res) => {
  const { appId, kitId, fields, screenshot, company, role } = req.body;
  const id = appId || kitId;
  if (!fields) return res.status(400).json({ error: 'fields required' });
  if (!keys) return res.status(503).json({ error: 'No API key found' });

  // A kit is optional. Contact details come from the profile, so vision-based
  // filling should work on any form the moment someone is signed in — requiring
  // a kit first meant this path could not run where it was needed most.
  let appData = null;
  if (id) {
    const kitResult = await loadKit(id, reqUserEmail(req));
    if (kitResult === 'forbidden') return res.status(403).json({ error: 'Forbidden' });
    if (kitResult) appData = kitResult;
  }
  if (!appData) {
    const prof = await resolveProfile(req);
    appData = { company: company || 'this company', role: role || 'this role', profile: prof, tailored: {} };
  }

  const p = { ...BLANK_PROFILE, ...appData.profile };
  const t = appData.tailored || {};
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
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  try {
    const status = req.query.status || null;
    res.json(await db.getJobs(status, 200, userEmail));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Coverage plus progress: how much ground was covered, over what window, and
// how much of it is still the user's to work through.
app.get('/coverage', async (req, res) => {
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  try {
    const [cov, counts] = await Promise.all([
      db.getCoverage(userEmail),
      db.getStatusCounts(userEmail),
    ]);
    const todo = (counts.new || 0) + (counts.reviewed || 0);
    const done = (counts.applied || 0) + (counts.skipped || 0) + (counts.rejected || 0);
    res.json({ ...cov, counts, todo, done, total: todo + done + (counts.applying || 0) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/sourced/counts', async (req, res) => {
  if (!reqUserEmail(req)) return res.status(401).json({ error: 'Sign in required' });
  try { res.json(await db.getStatusCounts(reqUserEmail(req))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/runs', async (req, res) => {
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  try { res.json(await db.getRuns(50, userEmail)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/runs/:id/jobs', async (req, res) => {
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  try {
    const rows = await db.getJobsForRun(req.params.id);
    res.json(rows.filter(j => !j.user_email || j.user_email === userEmail));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/sourced/status', async (req, res) => {
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  const { url, status } = req.body;
  if (!url || !status) return res.status(400).json({ error: 'url and status required' });
  const valid = ['new', 'reviewed', 'applying', 'applied', 'skipped', 'rejected'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'invalid status' });
  try {
    const n = await db.setJobStatus(url, status,
      { applied_at: status === 'applied' ? new Date().toISOString().slice(0, 10) : undefined }, userEmail);
    if (!n) return res.status(404).json({ error: 'No such job in your pipeline' });
    await db.recordDecision(url, userEmail, status);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/sourced/mark-reviewed', async (req, res) => {
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  const { ids } = req.body;
  if (!ids?.length) return res.status(400).json({ error: 'ids required' });
  try {
    const jobs = await db.getJobs('new', 500, userEmail);
    const idSet = new Set(ids);
    for (const j of jobs) { if (idSet.has(j.id)) await db.setJobStatus(j.url, 'reviewed', {}, userEmail); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/sourced/skip', async (req, res) => {
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try { await db.setJobStatus(url, 'skipped', {}, userEmail); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/sourced/mark-applied', async (req, res) => {
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    await db.setJobStatus(url, 'applied', { applied_at: new Date().toISOString().slice(0, 10) }, userEmail);
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
  if (!reqUserEmail(req)) return res.status(401).json({ error: 'Sign in required' });
  const { appId, kitId, company, role, url } = req.body;
  const id = appId || kitId;
  if (!id) return res.status(400).json({ error: 'appId required' });

  const appliedAt = new Date().toISOString().slice(0, 10);

  // Update the application JSON kit file
  const userEmail = reqUserEmail(req);
  const kitData = await loadKit(id, userEmail);
  if (kitData && kitData !== 'forbidden') {
    kitData.applied_at = appliedAt;
    await db.saveKit(kitData);
  }

  // Update DB status (authoritative)
  if (url) try { await db.setJobStatus(url, 'applied', { applied_at: appliedAt }, userEmail); } catch {}

  console.log(`Applied: ${company} — ${role} (${appliedAt})`);
  res.json({ ok: true, applied_at: appliedAt });
});

app.get('/applied', async (req, res) => {
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  try {
    const jobs = await db.getJobs('applied', 500, userEmail);
    res.json(jobs.map(({ id, company, role, url, applied_at }) => ({ appId: id, company, role, url, applied_at })));
  } catch (e) { res.json([]); }
});

app.get('/status', async (req, res) => {
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  try {
    const counts = await db.getStatusCounts(userEmail);
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
    const cached = await findApplicationByUrl(url, userEmail);
    if (cached) {
      // Served straight from Postgres — no model call, so nothing to charge for.
      res.noCharge?.();
      console.log(`Cache hit: ${cached.company} — ${cached.role} (no charge)`);
      // Backfill the pipeline row for kits generated before this existed, or
      // generated directly (extension, URL-prepend) with no sourcing row.
      db.ensureJob({
        id: cached.id, url, company: cached.company, role: cached.role,
        ats: cached.ats || null, source: 'direct', found_at: new Date().toISOString(),
        status: 'new', tier: cached.tier || null, fit_score: cached.fit_score || null,
        location: cached.profile?.location || null, user_email: userEmail || null,
      }).catch(e => console.error('[pipeline backfill]', e.message));
      return res.json(cached);
    }
  } else {
    // Delete any existing application for this URL so we regenerate fresh
    const existing = await findApplicationByUrl(url, userEmail);
    if (existing) {
      await db.deleteKit(existing.id);
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

  const salaryAsk = profile.salary ? String(profile.salary).replace(/[^0-9]/g, '') : '';

  const prompt = `Generate a job application for ${candidateName} applying to this role.${noteInstruction}

CANDIDATE BACKGROUND:
${bio}${await evidenceBlock(userEmail)}

CANDIDATE'S STATED SALARY EXPECTATION: ${salaryAsk || 'not specified — infer a reasonable ask from the role level and any range in the posting'}

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
    "salary": "<plain number string, no $ or commas. Use the candidate's stated salary expectation (${salaryAsk || 'none given'}) as-is if it falls at or below any range posted in the job description. If it exceeds the top of a posted range, use the top of that range instead — don't undercut the candidate's ask with a number from lower in the range. If the candidate gave no number, pick a value at or above the midpoint of any posted range, or a reasonable level-appropriate figure if no range is posted.>",
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
    // saveKit merges in any URLs this kit was previously reached at
    const stored = await db.saveKit(generated);
    Object.assign(generated, stored);

    // Ensure a pipeline row exists for this URL — kits generated directly
    // (extension, URL-prepend) never went through sourcing, so without this
    // they're invisible on /pipeline and kit_generated_at never sets.
    await db.ensureJob({
      id: generated.id,
      url,
      company: generated.company,
      role: generated.role,
      ats: generated.ats || ats || null,
      source: 'direct',
      found_at: new Date().toISOString(),
      status: 'new',
      tier: generated.tier || null,
      fit_score: generated.fit_score || null,
      location: generated.profile?.location || null,
      user_email: userEmail || null,
    });
    await db.setKitGenerated(url);

    // Tailor the resume in the same pass. It needs the kit's why_role, so it
    // cannot run earlier, and doing it here saves the user a second wait.
    // Charged separately and skipped rather than failing if the balance is
    // short — a missing resume must not cost them the kit they just paid for.
    if (profile.resume_text && userEmail) {
      try {
        const bal = await getUser(userEmail);
        if ((bal?.credits ?? 0) >= CREDIT_COSTS.resume) {
          generated.tailored_resume = await buildTailoredResume(profile, generated, userEmail);
          await db.deductUserCredits(userEmail, CREDIT_COSTS.resume);
          await db.saveKit(generated);
          console.log(`Tailored resume included for ${generated.company} (+${CREDIT_COSTS.resume} credits)`);
        } else {
          generated.resume_skipped = `Needed ${CREDIT_COSTS.resume} more credits to tailor your resume.`;
        }
      } catch (e) {
        console.error('Auto resume tailor failed:', e.message);
        generated.resume_skipped = 'Tailored resume could not be generated — you can retry it from the kit.';
      }
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

  const coverKit = await loadKit(id, reqUserEmail(req));
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

// Generate a job-specific tailored resume from the candidate's real uploaded
// resume text — reorders and reweights existing bullets, never invents facts.
// Shared by the on-demand endpoint and by kit generation, so both produce the
// same resume rather than drifting into two versions of the prompt.
async function buildTailoredResume(profile, appData, userEmail) {
  const t = appData.tailored || {};
  const resumeName = `${appData.profile?.first_name || profile.first_name || ''} ${appData.profile?.last_name || profile.last_name || ''}`.trim();

  const prompt = `Rewrite this candidate's resume experience for ${appData.role} at ${appData.company}.

ORIGINAL RESUME — the primary source of real facts (companies, titles, dates, numbers). Do not invent, merge, or drop any role. Do not invent a number, metric, or outcome that appears in neither the resume nor the additional evidence below:
${profile.resume_text.slice(0, 6000)}${await evidenceBlock(userEmail)}

WHY THIS ROLE / WHAT TO EMPHASIZE (from an earlier pass on this same application):
${t.why_role || t.headline || 'No additional context — use judgment based on the role title.'}

Rules:
- Every company, title, and date range in your output must match the original resume exactly.
- You may reorder bullets within a role and reword them for clarity and to mirror relevant language from "WHY THIS ROLE" — but every fact must trace back to the original resume or to the additional evidence.
- Work described in the additional evidence belongs to the role the candidate held at that time. Turn it into bullets under that role. This is the point of it: it is real work their resume left out, and for a candidate crossing a role boundary it is often the most relevant material they have.
- Cut bullets irrelevant to this role if the original has many; keep the strongest 3-5 per role.
- Do not add a role, company, or credential that appears in neither the resume nor the evidence.

Then judge your own output honestly. The candidate needs to know whether to send this or to strengthen it first, so do not flatter it.

Return ONLY valid JSON, no markdown:
{
  "summary": "<2-3 sentence resume summary tailored to this specific role, first person voice matching a resume header, not a cover letter>",
  "experience": [
    {"company": "<exact>", "title": "<exact>", "dates": "<exact>", "bullets": ["<bullet>", "..."]}
  ],
  "skills": ["<skill pulled from the original resume, ordered by relevance to this role>"],
  "coverage": {
    "confidence": "<strong | moderate | thin — how well this candidate's real evidence covers what the role asks for>",
    "evidenced": ["<a requirement of this role you could back with specific real experience>"],
    "gaps": ["<a requirement of this role you could NOT evidence from the resume or the additional evidence>"],
    "improve": "<one sentence naming the single thing the candidate could tell us that would most strengthen this resume>"
  }
}`;

  const raw = await callClaude(prompt, 2800, 'claude-sonnet-4-6');
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response');
  const tailored = cleanEmDashes(JSON.parse(match[0]));
  return { name: resumeName, company: appData.company, role: appData.role, ...tailored };
}

app.post('/resume-tailor', requireCredits('resume'), async (req, res) => {
  const { appId, kitId } = req.body;
  const id = appId || kitId;
  if (!id) return res.status(400).json({ error: 'appId required' });
  if (!keys) return res.status(503).json({ error: 'No API key' });

  const userEmail = reqUserEmail(req);
  const resumeKit = await loadKit(id, userEmail);
  if (!resumeKit) return res.status(404).json({ error: 'Application not found' });
  if (resumeKit === 'forbidden') return res.status(403).json({ error: 'Forbidden' });

  const profile = await resolveProfile(req);
  if (!profile.resume_text) {
    return res.status(422).json({ error: 'No resume on file — upload a PDF at /setup first, then try again.' });
  }

  try {
    const out = await buildTailoredResume(profile, resumeKit, userEmail);
    resumeKit.tailored_resume = out;
    await db.saveKit(resumeKit).catch(() => {});
    res.json(out);
  } catch (e) {
    console.error('Resume tailor error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Interview answers are the candidate's own words about real work, so they are
// safe to treat as source material — same standing as the resume, not invention.
async function evidenceBlock(userEmail) {
  if (!userEmail) return '';
  const rows = await db.getEvidence(userEmail, { answeredOnly: true }).catch(() => []);
  if (!rows.length) return '';
  return `\n\nADDITIONAL EVIDENCE — the candidate's own answers about work not covered by their resume. Treat these as true and usable, exactly like the resume:\n` +
    rows.map(r => `Q: ${r.question}\nA: ${r.answer}`).join('\n\n');
}

// ── Interview ────────────────────────────────────────────────────────────────
// A resume is written for the role you had. Crossing a role boundary (CEO ->
// PM) leaves the relevant work unstated, and tailoring may only reuse what is
// already there — so ask for the missing material instead of inventing it.

app.get('/interview', async (req, res) => {
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  res.json(await db.getEvidence(userEmail));
});

app.post('/interview/questions', requireCredits('interview'), async (req, res) => {
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  if (!keys) return res.status(503).json({ error: 'No API key' });

  const profile = await resolveProfile(req);
  if (!profile.resume_text && !profile.bio) {
    return res.status(422).json({ error: 'Add your resume or bio at /setup first — there is nothing to compare against yet.' });
  }

  // Optional: scope the gap analysis to one posting instead of the target roles.
  let target = profile.target_roles || profile.career_type || 'the roles they are targeting';
  let jobUrl = null;
  const { appId } = req.body || {};
  if (appId) {
    const kit = await loadKit(appId, userEmail);
    if (kit && kit !== 'forbidden') {
      target = `${kit.role} at ${kit.company}`;
      jobUrl = kit.url || null;
    }
  }

  const existing = await db.getEvidence(userEmail);
  const asked = existing.map(e => e.question);

  const prompt = `This candidate is targeting: ${target}

Their resume was written for the roles they HELD, so work that matters for the target is often missing from it entirely, or buried under a title that hides it.

RESUME:
${(profile.resume_text || '').slice(0, 5000) || '(none uploaded)'}

BIO:
${profile.bio || '(none)'}

${asked.length ? `ALREADY ASKED — do not repeat these or ask a near-duplicate:\n${asked.map(a => `- ${a}`).join('\n')}` : ''}

Find where the evidence a hiring manager for this target would look for is thin or absent, then write 4-6 questions that would surface real work this person did but did not put on their resume.

Rules:
- Anchor every question to something specific and named in their background. "You were CEO at ELDRICK — which product decisions did you personally own?" not "Tell me about your product experience."
- Go after the delta: what the target demands that this resume does not currently evidence. If they are crossing a role boundary, mine the adjacent work inside their old title.
- Ask for specifics they can actually answer: what they owned, what shipped, what they decided, what moved.
- One gap per question. No compound questions.
- No questions answerable from the resume as written.

Return ONLY valid JSON, no markdown:
{"questions":[{"question":"<question>","theme":"product|growth|leadership|technical|other"}]}`;

  try {
    const raw = await callClaude(prompt, 1500, 'claude-sonnet-4-6');
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in response');
    const parsed = JSON.parse(match[0]);
    const items = (parsed.questions || [])
      .filter(q => q.question)
      .map(q => ({ question: String(q.question).trim(), theme: q.theme || null, job_url: jobUrl }));
    if (!items.length) throw new Error('No questions produced');
    const all = await db.addEvidenceQuestions(userEmail, items);
    res.json({ questions: all });
  } catch (e) {
    console.error('Interview questions error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Context volunteered against a coverage gap, saved to the profile so every
// later generation benefits rather than just this one resume.
app.post('/interview/context', async (req, res) => {
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  const { question, answer } = req.body || {};
  if (!question || !answer?.trim()) return res.status(400).json({ error: 'question and answer required' });
  const row = await db.addAnsweredEvidence(userEmail, String(question).trim(), answer.trim());
  res.json({ ok: true, id: row?.id });
});

app.post('/interview/answer', async (req, res) => {
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  const { id, answer } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const row = await db.setEvidenceAnswer(userEmail, id, (answer || '').trim());
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.delete('/interview/:id', async (req, res) => {
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  await db.deleteEvidence(userEmail, req.params.id);
  res.json({ ok: true });
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
    const voiceKit = await loadKit(id, reqUserEmail(req));
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
app.post('/clear', async (req, res) => {
  try {
    // Previously unauthenticated: an anonymous caller resolved to a null email,
    // which made the ownership test pass for every kit and wiped all users' data.
    const clearEmail = reqUserEmail(req);
    if (!clearEmail) return res.status(401).json({ error: 'Sign in required' });
    const n = await db.deleteKitsForUser(clearEmail);
    console.log(`[clear] wiped ${n} kits for ${clearEmail}`);
    res.json({ ok: true, deleted: n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Schedule ──────────────────────────────────────────────────────────────────

// Cron already pins this timezone; naming it once keeps the schedule, the
// startup log and the UI label from drifting apart.
const SCHEDULE_TZ = process.env.SCHEDULE_TZ || 'America/Chicago';
const SCHEDULE_DEFAULT = { hour: 8, minute: 0, enabled: false };

let cronTask = null;
let prefetchTask = null;
const PREFETCH_HOUR = Number(process.env.PREFETCH_HOUR ?? 2);
const PREFETCH_MINUTE = Number(process.env.PREFETCH_MINUTE ?? 0);

function startCron() {
  if (cronTask) { cronTask.stop(); cronTask = null; }
  // Per-user times can't be expressed as one cron expression, so tick each
  // minute and dispatch whoever is due.
  cronTask = cron.schedule('* * * * *', async () => {
    const [h, m] = new Intl.DateTimeFormat('en-US', {
      timeZone: SCHEDULE_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date()).split(':').map(Number);
    let due = [];
    try { due = await db.getDueSchedules(h, m); }
    catch (e) { console.error('[cron] getDueSchedules:', e.message); return; }
    for (const row of due) {
      try { await runScheduledSourcing(row); }
      catch (e) { console.error(`[cron] ${row.user_email}:`, e.message); }
    }
  }, { timezone: SCHEDULE_TZ });
  console.log(`[cron] per-user scheduler armed (${SCHEDULE_TZ})`);

  // Warm the shared cache before anyone's run. One session at 02:00 covers
  // every distinct role set, so the individual runs afterwards need no browser
  // and cost us nothing to serve.
  if (prefetchTask) prefetchTask.stop();
  prefetchTask = cron.schedule(`${PREFETCH_MINUTE} ${PREFETCH_HOUR} * * *`, runNightlyPrefetch,
    { timezone: SCHEDULE_TZ });
  console.log(`[cron] nightly prefetch armed for ${String(PREFETCH_HOUR).padStart(2,'0')}:${String(PREFETCH_MINUTE).padStart(2,'0')} ${SCHEDULE_TZ}`);
}

// Distinct role sets across everyone scheduled — the Google sources key on
// role titles, so one pass per distinct set covers all of them.
async function runNightlyPrefetch() {
  let rows = [];
  try { rows = await db.getAllEnabledSchedules(); }
  catch (e) { return console.error('[prefetch] schedules:', e.message); }
  if (!rows.length) return console.log('[prefetch] nobody scheduled, skipping');

  const byRoles = new Map();
  for (const row of rows) {
    const profile = await getProfileByUserEmail(row.user_email).catch(() => null);
    const roles = profile?.target_roles || '';
    const key = db.roleKeyFor(roles);
    if (!byRoles.has(key)) byRoles.set(key, roles);
  }

  console.log(`[prefetch] warming ${byRoles.size} distinct role set(s) for ${rows.length} scheduled user(s)`);
  const { spawn } = require('child_process');
  for (const roles of byRoles.values()) {
    await new Promise(resolve => {
      const child = spawn('node', [path.join(__dirname, '../source.js')], {
        cwd: path.join(__dirname, '..'),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, JAA_PREFETCH_ONLY: '1', ...(roles ? { JAA_TARGET_ROLES: roles } : {}) },
      });
      child.stdout.on('data', d => process.stdout.write(`[prefetch] ${d}`));
      child.stderr.on('data', d => process.stderr.write(`[prefetch] ${d}`));
      child.on('exit', code => { console.log(`[prefetch] role set done, exit ${code}`); resolve(); });
    });
  }
}

async function runScheduledSourcing(row) {
  const email = row.user_email;
  const names = Array.isArray(row.sources) ? row.sources : null;
  const selected = names?.length
    ? SOURCE_CATALOG.filter(s => names.includes(s.name))
    : SOURCE_CATALOG.filter(s => s.on);
  if (!selected.length) return;
  const cost = selected.reduce((n, s) => n + s.credits, 0);

  // Stamp before doing anything expensive: a crash mid-run must not let the
  // next tick start a second run and charge twice.
  await db.markScheduleRun(email);

  const user = await getUser(email);
  if (!user || user.credits < cost) {
    console.log(`[cron] skipped ${email} — needs ${cost}, has ${user?.credits ?? 0}`);
    sendEmail(email, 'applyapply — nightly sourcing skipped',
      `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:40px auto;padding:32px;background:#fff;border:1px solid #e5e5e5;border-radius:8px">
        <h2 style="font-size:16px;font-weight:700;margin-bottom:10px">Nightly sourcing didn't run</h2>
        <p style="color:#555;font-size:14px;margin-bottom:20px">It needed ${cost} credits and your balance is ${user?.credits ?? 0}. Top up and tonight's run will go ahead as normal.</p>
        <a href="${APP_ORIGIN}/buy" style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600">Add credits →</a>
      </div>`,
      `Nightly sourcing needed ${cost} credits, balance ${user?.credits ?? 0}. Top up: ${APP_ORIGIN}/buy`
    ).catch(() => {});
    return;
  }

  await db.deductUserCredits(email, cost);
  console.log(`[cron] ${email}: ${cost} credits for [${selected.map(s => s.name).join(', ')}]`);

  const { spawn } = require('child_process');
  const logDir = path.join(__dirname, '../logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logFile = sourceLogFor(email);
  const ls = fs.createWriteStream(logFile, { flags: 'w' });

  const child = spawn('node', [path.join(__dirname, '../source.js')], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: {
      ...process.env,
      JAA_USER_EMAIL: email,
      JAA_ENABLED_SOURCES: JSON.stringify(selected.map(s => s.name)),
    },
  });
  child.stdout.pipe(ls);
  child.stderr.pipe(ls);
  // Also to the container log. The file lives on the ephemeral disk and is
  // gone after any deploy, so without this a failed run leaves no record at
  // all and there is nothing to diagnose from.
  child.stdout.on('data', d => process.stdout.write(`[source:${email}] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[source:${email}] ${d}`));
  child.on('error', err => console.error(`[source:${email}] spawn failed:`, err.message));
  sourcingPids.set(email, child.pid);
  child.unref();

  child.on('exit', async (code) => {
    sourcingPids.delete(email);
    ls.end();
    console.log(`[cron] ${email} finished, exit ${code}`);
    // A failed run bought nothing — give the credits back.
    if (code !== 0) {
      await db.addUserCredits(email, cost).catch(() => {});
      console.log(`[cron] refunded ${cost} to ${email} after a failed run`);
      return;
    }
    sendEmail(email, 'applyapply — daily sourcing complete',
      `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:40px auto;padding:32px;background:#fff;border:1px solid #e5e5e5;border-radius:8px">
        <h2 style="font-size:16px;font-weight:700;margin-bottom:10px">Daily sourcing finished</h2>
        <p style="color:#555;font-size:14px;margin-bottom:20px">New matches are waiting in your pipeline.</p>
        <a href="${APP_ORIGIN}/pipeline" style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600">View pipeline →</a>
      </div>`,
      `Daily sourcing complete. View pipeline: ${APP_ORIGIN}/pipeline`
    ).catch(() => {});
  });
}

app.get('/schedule', async (req, res) => {
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  const row = await db.getSchedule(userEmail);
  res.json({
    hour: row?.hour ?? SCHEDULE_DEFAULT.hour,
    minute: row?.minute ?? SCHEDULE_DEFAULT.minute,
    enabled: row?.enabled ?? false,
    sources: row?.sources || null,
    last_run_at: row?.last_run_at || null,
    timezone: SCHEDULE_TZ,
    catalog: SOURCE_CATALOG.map(s => ({ name: s.name, credits: s.credits, desc: s.desc })),
  });
});

app.post('/schedule', async (req, res) => {
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
  const { hour, minute, enabled, sources } = req.body || {};
  const h = Math.min(23, Math.max(0, Number(hour ?? SCHEDULE_DEFAULT.hour)));
  const m = Math.min(59, Math.max(0, Number(minute ?? SCHEDULE_DEFAULT.minute)));
  const names = Array.isArray(sources) && sources.length
    ? SOURCE_CATALOG.filter(s => sources.includes(s.name)).map(s => s.name)
    : null;
  // If the time they picked has already gone by today, treat today as done so
  // saving the schedule does not immediately trigger a run.
  const [nowH, nowM] = new Intl.DateTimeFormat('en-US', {
    timeZone: SCHEDULE_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date()).split(':').map(Number);
  const passedToday = (h * 60 + m) <= (nowH * 60 + nowM);
  const row = await db.setSchedule(userEmail,
    { hour: h, minute: m, enabled: !!enabled, sources: names }, passedToday);
  const selected = names?.length ? SOURCE_CATALOG.filter(s => names.includes(s.name)) : SOURCE_CATALOG.filter(s => s.on);
  res.json({
    ok: true,
    schedule: { hour: row.hour, minute: row.minute, enabled: row.enabled, sources: row.sources },
    nightly_cost: selected.reduce((n, s) => n + s.credits, 0),
    timezone: SCHEDULE_TZ,
  });
});

// Source new jobs on demand
// Per-user sourcing pid map — key is userEmail or '__local__' for anonymous
const sourcingPids = new Map();
// Legacy single-pid accessor for cron status endpoint
function getSourcingPid() { return sourcingPids.size > 0 ? [...sourcingPids.values()][0] : null; }

app.get('/source/status', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).json({ error: 'Sign in required' });
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

// One log per user. Keyed by a hash of the whole address because the part
// before the @ is not unique, and a run's log names the companies and roles
// someone is targeting.
function sourceLogFor(userEmail) {
  if (!userEmail) return SOURCE_LOG_FILE;
  const tag = crypto.createHash('sha1').update(userEmail.toLowerCase()).digest('hex').slice(0, 12);
  return `${SOURCE_LOG_FILE}.${tag}`;
}

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

  // Manual credit check (replaces requireCredits since cost is dynamic).
  // authFromRequest returns null when there is no session, and dereferencing
  // that threw before anything spawned — so in production, where requests are
  // never "local", a run could never start at all.
  const auth = authFromRequest(req);
  if (!auth) return res.status(401).json({ error: 'Sign in required' });
  if (auth.type === 'jwt') {
    const user = await db.getUser(auth.email);
    if (!user) return res.status(401).json({ error: 'user not found' });
    if (user.credits < totalCredits) return res.status(402).json({ error: 'Insufficient credits', balance: user.credits, required: totalCredits });
    await db.deductUserCredits(auth.email, totalCredits);
  }
  // local mode: no credit check

  const { spawn } = require('child_process');
  if (!fs.existsSync(path.join(__dirname, '../logs'))) fs.mkdirSync(path.join(__dirname, '../logs'), { recursive: true });
  const logFile = sourceLogFor(userEmail);
  const logStream = fs.createWriteStream(logFile, { flags: 'w' });
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
  child.stderr.pipe(logStream);
  // Mirror to the container log so a failure survives the ephemeral disk.
  child.stdout.on('data', d => process.stdout.write(`[source] ${d}`));
  child.stderr.on('data', d => process.stderr.write(`[source] ${d}`));
  // A spawn that never starts emits nothing on either stream, so without this
  // the failure is completely silent.
  child.on('error', err => {
    console.error('[source] spawn failed:', err.message);
    try { logStream.write(`\nspawn failed: ${err.message}\n`); } catch {}
  });
  console.log(`[source] spawned pid ${child.pid} for ${pidKey} — ${selectedSources.map(s => s.name).join(', ')}`);
  sourcingPids.set(pidKey, child.pid);
  child.unref();
  const runEmail = userEmail;
  child.on('exit', async (code) => {
    sourcingPids.delete(pidKey);
    logStream.end();
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
  res.setHeader('Cache-Control', 'no-store');
  const userEmail = reqUserEmail(req);
  if (!userEmail) return res.status(401).type('text/plain').send('Sign in required');
  try {
    // Per-user file first: the shared one is this user's only in local mode.
    const file = sourceLogFor(userEmail);
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '(no log yet)';
    res.type('text/plain').send(text);
  } catch { res.status(500).send('error reading log'); }
});

app.get('/source/stream', (req, res) => {
  const payload = req.query.token ? verifySession(String(req.query.token)) : null;
  const userEmail = payload?.email || reqUserEmail(req);
  if (!userEmail) return res.status(401).end();
  const logPath = sourceLogFor(userEmail);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let pos = 0;
  const send = () => {
    try {
      if (!fs.existsSync(logPath)) return;
      const stat = fs.statSync(logPath);
      if (stat.size <= pos) return;
      const buf = Buffer.alloc(stat.size - pos);
      const fd = fs.openSync(logPath, 'r');
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
  const profile = await resolveProfile(req).catch(() => ({ ...BLANK_PROFILE }));
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
  const kitUrlSet = new Set((await loadApps()).flatMap(a => [a.url, ...(a.urls||[])].filter(Boolean).map(normUrl)));

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

  const sched = (await db.getSchedule(reqUserEmail(req)).catch(() => null)) || SCHEDULE_DEFAULT;
  const schedText = sched.enabled
    ? `auto ${String(sched.hour).padStart(2,'0')}:${String(sched.minute).padStart(2,'0')} CT`
    : 'no schedule';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
${metaHead({title:'Sourcing — applyapply', desc:'Send the agents out to find roles that match your profile.', path:'/sourcing', noindex:true})}
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#ccc;font-size:13px;min-height:100vh}
.topbar{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid #181818;flex-wrap:wrap}
.topbar-title{font-size:13px;font-weight:600;color:#fff}${NAV_CSS}
.topbar-meta{font-size:11px;color:#a8a8a8;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.topbar-sched{font-size:11px;color:#8f8f8f}
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
.src-card-stats{font-size:11px;color:#b9b9b9;flex:1}
.src-card-stats strong{color:#fff}
.src-hist{display:flex;gap:3px;align-items:center}
.hist-dot{font-size:10px;width:14px;text-align:center;cursor:default}
.hdot-ok{color:#4ade80}.hdot-meh{color:#a8a8a8}.hdot-zero{color:#4a4a4a}
/* fit rows */
.fit-row{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid #0a0a0a}
.fit-link{color:#fff;font-size:13px;text-decoration:none;flex:1}
.fit-link:hover{text-decoration:underline}
.fit-badges{display:flex;gap:4px;flex-shrink:0}
.badge{font-size:9px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:2px 5px}
.b-kit{background:#0a1e0d;color:#4ade80}
.b-opened{background:#0a1020;color:#60a5fa}
.no-fit{font-size:12px;color:#9a9a9a;padding:8px 0}
/* others */
.other-toggle{background:none;border:none;font-size:11px;color:#9a9a9a;cursor:pointer;padding:10px 0 0;font-family:inherit;text-align:left}
.other-toggle:hover{color:#888}
.other-list{padding:6px 0}
.other-row{display:flex;gap:10px;padding:3px 0;align-items:baseline}
.other-lbl{font-size:10px;color:#8f8f8f;width:58px;flex-shrink:0;text-align:right}
.other-link{color:#9a9a9a;font-size:11px;text-decoration:none}
.other-link:hover{color:#888}
.empty{padding:48px 0;color:#9a9a9a;font-size:13px}
.onboard{padding:40px 0 48px;max-width:480px}
.onboard-title{font-size:16px;font-weight:700;letter-spacing:-.02em;color:#fff;margin-bottom:10px}
.onboard-body{font-size:13px;line-height:1.7;color:#888;margin-bottom:20px}
.onboard-body a{color:#fff;text-decoration:underline}
.onboard-cta{padding:9px 18px;background:#fff;color:#000;font-size:12px;font-weight:700;border:none;cursor:pointer;font-family:inherit;letter-spacing:-.01em;margin-bottom:18px}
.onboard-cta:hover{background:#e0e0e0}
.onboard-alt{font-size:11px;color:#a8a8a8;line-height:1.6}
.onboard-alt a{color:#b9b9b9;text-decoration:underline}
.missed-section{border-top:1px solid #111;padding:24px 0 0;margin-top:8px}
.missed-label{font-size:11px;color:#b9b9b9;margin-bottom:8px}
.missed-row{display:flex;gap:8px}
.missed-input{flex:1;background:#111;border:1px solid #1e1e1e;color:#fff;font-size:12px;padding:6px 10px;outline:none;font-family:inherit}
.missed-input:focus{border-color:#333}
.missed-btn{padding:6px 12px;background:none;color:#b9b9b9;border:1px solid #1e1e1e;font-size:11px;cursor:pointer;font-family:inherit}
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
.panel-section-label{font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9a9a9a;margin-bottom:8px;margin-top:14px}
.panel-section-label:first-child{margin-top:0}
.role-grid{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px}
.role-chip{display:flex;align-items:center;gap:5px;padding:4px 8px;border:1px solid #1e1e1e;background:#0a0a0a;cursor:pointer;font-size:11px;color:#b9b9b9;user-select:none}
.role-chip input[type=checkbox]{accent-color:#3b82f6;width:11px;height:11px;flex-shrink:0;cursor:pointer;margin:0}
.role-chip.checked{border-color:#2a3a2a;background:#080d08;color:#aaa}
.role-chip-custom{margin-top:6px;display:flex;align-items:center;gap:6px}
.bulk-row{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.bulk-btn{padding:2px 8px;background:#0d0d0d;border:1px solid #2a2a2a;color:#b9b9b9;font-size:10px;cursor:pointer;font-family:inherit;letter-spacing:.04em}
.bulk-btn:hover{color:#fff;border-color:#666}
.bulk-hint{font-size:10px;color:#8f8f8f;margin-left:4px}
.runs-tbl{width:100%;border-collapse:collapse;font-size:11px}
.runs-tbl th{text-align:left;color:#8f8f8f;font-weight:600;padding:4px 10px 6px 0;border-bottom:1px solid #1a1a1a;letter-spacing:.04em;text-transform:uppercase;font-size:9px}
.runs-tbl td{padding:5px 10px 5px 0;color:#ccc;border-bottom:1px solid #0f0f0f}
.only-btn{display:none;margin-left:6px;font-size:9px;color:#8f8f8f;border:1px solid #2a2a2a;padding:0 4px;letter-spacing:.04em}
.role-chip:hover .only-btn{display:inline}
.only-btn:hover{color:#fff;border-color:#666}
.role-chip-custom input[type=text]{flex:1;background:#111;border:1px solid #1e1e1e;color:#ccc;font-size:11px;padding:4px 8px;outline:none;font-family:inherit}
.role-chip-custom input[type=text]::placeholder{color:#9a9a9a}
.src-sel-grid{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
.src-sel-row{display:flex;align-items:center;gap:8px;font-size:11px}
.src-sel-row input[type=checkbox]{accent-color:#3b82f6;width:13px;height:13px;flex-shrink:0;cursor:pointer}
.src-sel-name{color:#aaa;flex:1;cursor:pointer}
.src-sel-cost{color:#a8a8a8;font-size:10px;width:60px;text-align:right;flex-shrink:0}
.src-sel-type{font-size:9px;color:#8f8f8f;width:42px;text-align:right;flex-shrink:0;text-transform:uppercase;letter-spacing:.04em}
.src-footer{display:flex;align-items:center;justify-content:space-between;padding-top:10px;border-top:1px solid #161616}
.src-total{font-size:11px;color:#b9b9b9}
.src-total strong{color:#ccc}
.run-confirm-btn{padding:5px 14px;background:#fff;color:#0a0a0a;border:none;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer}
.run-confirm-btn:hover{opacity:.85}
.run-confirm-btn:disabled{opacity:.35;cursor:default}
#live-panel{display:none;padding:16px 24px 0;border-bottom:1px solid #111;margin-bottom:4px}
.live-hero{display:flex;align-items:center;justify-content:space-between;gap:16px;border:1px solid #1e2a1e;background:#060b06;padding:14px 16px;margin-bottom:14px}
.live-hero-left{display:flex;align-items:center;gap:12px}
.live-hero-title{font-size:15px;font-weight:700;color:#fff;letter-spacing:-.02em}
.live-hero-sub{font-size:11px;color:#9a9a9a;margin-top:2px}
.live-hero-right{text-align:right}
.live-elapsed{font-size:18px;font-weight:700;color:#4ade80;font-variant-numeric:tabular-nums;line-height:1}
.live-found{font-size:10px;color:#8f8f8f;margin-top:3px;letter-spacing:.04em;text-transform:uppercase}
.live-spin{width:16px;height:16px;border:2px solid #1e3a1e;border-top-color:#4ade80;border-radius:50%;display:inline-block;animation:jaaspin .8s linear infinite;flex-shrink:0}
@keyframes jaaspin{to{transform:rotate(360deg)}}
.live-phases{display:flex;gap:0;margin-bottom:16px}
.live-phase{font-size:10px;color:#8f8f8f;padding:4px 10px;border:1px solid #1a1a1a;border-right:none;letter-spacing:.04em}
.live-phase:last-child{border-right:1px solid #1a1a1a}
.live-phase.active{color:#f59e0b;border-color:#3a2a00;background:#0d0800}
.live-phase.done{color:#4ade80;border-color:#1a2a1a;background:#080d08}
.live-sources{display:flex;flex-direction:column;gap:10px;margin-bottom:16px}
.live-src{display:flex;flex-direction:column;gap:3px}
.live-src-head{display:flex;align-items:baseline;gap:8px}
.live-src-name{font-size:11px;font-weight:600;color:#b9b9b9}
.live-src-status{font-size:10px;color:#9a9a9a}
.live-src-status.searching{color:#f59e0b}
.live-src-status.done{color:#4ade80}
.live-feed{display:flex;flex-direction:column;gap:2px;max-height:220px;overflow-y:auto}
.live-line{font-size:11px;line-height:1.5;padding:1px 0}
.live-line.step{color:#b9b9b9;font-weight:600;margin-top:6px}
.live-line.new{color:#4ade80}
.live-line.skip{color:#8f8f8f}
.live-line.check{color:#a8a8a8;font-style:italic}
.live-line.excl{color:#c05353}
.live-line.info{color:#9a9a9a}
#run-failed{display:none;border:1px solid #5a1d1d;background:#0d0505;padding:16px 18px;margin:0 24px 14px}
.rf-title{font-size:14px;font-weight:700;color:#f87171;margin-bottom:6px}
.rf-sub{font-size:12px;color:#c9c9c9;line-height:1.7;margin-bottom:12px;max-width:620px}
.rf-log{background:#080808;border:1px solid #1e1e1e;padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.6;color:#b9b9b9;white-space:pre-wrap;max-height:220px;overflow:auto;margin-bottom:12px}
.rf-actions{display:flex;gap:8px;align-items:center}
.rf-btn{padding:7px 14px;background:#fff;color:#0a0a0a;border:none;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}
.rf-btn.secondary{background:transparent;color:#c9c9c9;border:1px solid #2a2a2a}
</style>
</head>
<body>
<div class="topbar">
  <span class="sdot" id="sdot"></span>
  <span class="topbar-title">sourcing</span><span style="font-size:10px;color:#8f8f8f;margin-left:4px">v${VERSION}</span>
  <span style="margin-left:14px">${navHTML('/sourcing')}</span>
  <span class="topbar-meta" id="topbar-meta">${runMeta}</span>
  <span class="topbar-sched" id="sched-label" onclick="toggleSchedPanel()" style="cursor:pointer;text-decoration:underline;text-underline-offset:3px" title="Set up nightly sourcing">${schedText}</span>
  <span id="balance-display" style="font-size:10px;color:#8f8f8f"></span>
  <button class="run-btn" id="runs-btn" onclick="toggleRunsPanel()" style="background:none;border:1px solid #2a2a2a;color:#b9b9b9">history</button>
  <button class="run-btn" id="run-btn" onclick="toggleSourcePanel()">run sourcing</button>
</div>
${alertBanners.join('\n')}
<div id="runs-panel" style="display:none;border-bottom:1px solid #181818;padding:16px 24px;background:#060606">
  <div class="panel-section-label">Previous runs</div>
  <div id="runs-body"></div>
</div>

<div id="sched-panel" style="display:none;border-bottom:1px solid #181818;padding:16px 24px;background:#060606">
  <div class="panel-section-label">Nightly sourcing</div>
  <div style="font-size:11px;color:#c4c4c4;line-height:1.7;margin-bottom:12px;max-width:560px">
    Runs on our servers at the time you pick, so your machine doesn't need to be on.
    New matches are waiting in your pipeline in the morning, and you get an email when it finishes.
    Each run costs the same credits as running those sources by hand.
  </div>
  <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
    <label style="font-size:11px;color:#aaa;display:flex;align-items:center;gap:6px">
      <input type="checkbox" id="sched-enabled" style="accent-color:#3b82f6"> Run nightly
    </label>
    <label style="font-size:11px;color:#aaa;display:flex;align-items:center;gap:6px">
      at <input type="time" id="sched-time" value="06:00" style="background:#111;border:1px solid #1e1e1e;color:#fff;font-size:11px;padding:4px 6px;font-family:inherit">
      <span id="sched-tz" style="color:#b9b9b9"></span>
    </label>
  </div>
  <div class="panel-section-label">Sources to run</div>
  <div class="src-sel-grid" id="sched-sources"></div>
  <div class="src-footer">
    <span class="src-total">Each night: <strong id="sched-cost">—</strong> &nbsp;<span id="sched-last" style="color:#b9b9b9;font-size:10px"></span></span>
    <button class="run-confirm-btn" onclick="saveSchedule()">Save schedule</button>
  </div>
</div>

<div id="source-panel">
  <div class="panel-section-label">Roles</div>
  <div class="bulk-row">
    <button type="button" class="bulk-btn" onclick="setAllRoles(true)">all</button>
    <button type="button" class="bulk-btn" onclick="setAllRoles(false)">none</button>
    <span class="bulk-hint" id="role-count"></span>
  </div>
  <div class="role-grid" id="role-grid">${PRESET_ROLES.map(r => {
    const chk = !savedRoles.length || savedRoles.includes(r.toLowerCase());
    const esc = r.replace(/'/g, "&apos;");
    return '<label class="role-chip' + (chk?' checked':'') + '" onclick="toggleChip(event,this)">'
      + '<input type="checkbox"' + (chk?' checked':'') + ' value="' + esc + '">'
      + r
      + '<span class="only-btn" onclick="onlyRole(event,this)">only</span>'
      + '</label>';
  }).join('')}</div>
  <div class="role-chip-custom">
    <input type="text" id="role-custom" placeholder="custom title…">
  </div>
  <div class="panel-section-label" style="margin-top:16px">Sources</div>
  <div class="bulk-row">
    <button type="button" class="bulk-btn" onclick="setAllSources(true)">all</button>
    <button type="button" class="bulk-btn" onclick="setAllSources(false)">none</button>
    <span class="bulk-hint" id="src-count"></span>
  </div>
  <div class="src-sel-grid" id="src-sel-grid">
    <!-- populated by JS -->
  </div>
  <div class="src-footer">
    <span class="src-total">Total: <strong id="src-total-val">— credits</strong> &nbsp;<span id="src-balance" style="color:#a8a8a8;font-size:10px"></span></span>
    <button class="run-confirm-btn" id="run-confirm-btn" onclick="confirmRun()">Run sourcing</button>
  </div>
</div>
<div id="no-roles-banner" style="display:none;border:1px solid #3a2a00;background:#0d0800;padding:12px 18px;margin:0 24px 14px">
  <div style="font-size:12px;color:#f59e0b;font-weight:700;margin-bottom:4px">No target roles set</div>
  <div style="font-size:11px;color:#c9c9c9;line-height:1.7">Sourcing searches for the job titles on your profile, so without them it falls back to a generic list and the results will be poor. <a href="/setup" style="color:#60a5fa">Set your target roles →</a></div>
</div>

<div id="run-failed">
  <div class="rf-title">Sourcing run failed</div>
  <div class="rf-sub" id="rf-sub"></div>
  <div class="rf-log" id="rf-log"></div>
  <div class="rf-actions">
    <button class="rf-btn" onclick="toggleSourcePanel()">Try again</button>
    <button class="rf-btn secondary" onclick="document.getElementById('run-failed').style.display='none'">Dismiss</button>
    <span style="font-size:11px;color:#8f8f8f">Credits for a failed run are refunded automatically.</span>
  </div>
</div>

<div id="live-panel">
  <div class="live-hero">
    <div class="live-hero-left">
      <span class="live-spin"></span>
      <div>
        <div class="live-hero-title" id="live-title">Agents are searching</div>
        <div class="live-hero-sub" id="live-sub">Opening a browser session…</div>
      </div>
    </div>
    <div class="live-hero-right">
      <div class="live-elapsed" id="live-elapsed">0:00</div>
      <div class="live-found"><span id="live-found-n">0</span> found</div>
    </div>
  </div>
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
  <div id="missed-status" style="font-size:11px;color:#a8a8a8;margin-top:6px"></div>
</div>
</div>
<script>
const BASE=location.origin;
let es=null,statusPoller=null;

// Show credit balance in topbar
fetch(BASE+'/credits',{headers:authHeaders()}).then(r=>r.ok?r.json():{}).then(d=>{
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
    const d=await fetch(BASE+'/credits',{headers:authHeaders()}).then(r=>r.json());
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

var SCHED = null;

// This page sent no credentials at all, so anything user-scoped (balance,
// schedule) came back 401. Same session the setup page reads.
function authHeaders(){
  try{ var t=localStorage.getItem('aa_session'); return t?{'x-api-key':t}:{}; }catch(e){ return {}; }
}
// EventSource cannot set headers, so the log stream takes the session as a
// query parameter instead.
function sessionToken(){
  try{ return localStorage.getItem('aa_session')||''; }catch(e){ return ''; }
}

function toggleSchedPanel(){
  var el=document.getElementById('sched-panel');
  var open=el.style.display!=='none';
  el.style.display=open?'none':'block';
  if(!open&&!SCHED)loadSchedule();
}

// The page is a plain navigation carrying no session, so the server cannot
// know whose profile this is — anything personalised has to be resolved here.
function checkTargetRoles(){
  var key=(function(){try{return localStorage.getItem('aa_session')||'';}catch(e){return '';}})();
  if(!key)return;
  fetch('/profile',{headers:{'x-api-key':key}}).then(function(r){return r.ok?r.json():null;}).then(function(p){
    var banner=document.getElementById('no-roles-banner');
    if(!banner)return;
    var has=p&&p.target_roles&&String(p.target_roles).trim();
    banner.style.display=has?'none':'block';
  }).catch(function(){});
}

function loadSchedule(){
  fetch('/schedule',{headers:authHeaders()}).then(function(r){return r.ok?r.json():null;}).then(function(d){
    if(!d)return;
    SCHED=d;
    document.getElementById('sched-enabled').checked=!!d.enabled;
    document.getElementById('sched-time').value=String(d.hour).padStart(2,'0')+':'+String(d.minute).padStart(2,'0');
    document.getElementById('sched-tz').textContent=(d.timezone||'').split('/').pop().replace('_',' ');
    if(d.last_run_at)document.getElementById('sched-last').textContent='last run '+new Date(d.last_run_at).toLocaleString();
    var on=d.sources&&d.sources.length?d.sources:(d.catalog||[]).map(function(c){return c.name;});
    document.getElementById('sched-sources').innerHTML=(d.catalog||[]).map(function(c){
      return '<div class="src-sel-row">'
        +'<input type="checkbox" data-sched-src="'+c.name.replace(/"/g,'&quot;')+'"'+(on.indexOf(c.name)>=0?' checked':'')+' onchange="schedCost()">'
        +'<span class="src-sel-name">'+c.name+'</span>'
        +'<span class="src-sel-cost">'+c.credits+' cr</span></div>';
    }).join('');
    schedCost();
  }).catch(function(){});
}

function schedCost(){
  if(!SCHED)return;
  var picked=[].slice.call(document.querySelectorAll('[data-sched-src]:checked')).map(function(i){return i.getAttribute('data-sched-src');});
  var total=(SCHED.catalog||[]).filter(function(c){return picked.indexOf(c.name)>=0;}).reduce(function(n,c){return n+c.credits;},0);
  document.getElementById('sched-cost').textContent=total+' credits';
}

function saveSchedule(){
  var t=(document.getElementById('sched-time').value||'06:00').split(':');
  var picked=[].slice.call(document.querySelectorAll('[data-sched-src]:checked')).map(function(i){return i.getAttribute('data-sched-src');});
  fetch('/schedule',{method:'POST',headers:Object.assign({'content-type':'application/json'},authHeaders()),
    body:JSON.stringify({hour:Number(t[0]),minute:Number(t[1]),enabled:document.getElementById('sched-enabled').checked,sources:picked})})
  .then(function(r){return r.json();}).then(function(d){
    var lbl=document.getElementById('sched-label');
    if(d&&d.schedule&&d.schedule.enabled){
      lbl.textContent='auto '+String(d.schedule.hour).padStart(2,'0')+':'+String(d.schedule.minute).padStart(2,'0')+' · '+d.nightly_cost+' cr/night';
    } else if(lbl){ lbl.textContent='no schedule'; }
    document.getElementById('sched-panel').style.display='none';
  }).catch(function(){});
}

function toggleChip(e,el){
  if(e.target&&e.target.classList.contains('only-btn'))return;
  var cb=el.querySelector('input');cb.checked=!cb.checked;
  el.classList.toggle('checked',cb.checked);updateCounts();
}
function onlyRole(e,el){
  e.stopPropagation();
  var chip=el.closest('.role-chip');
  document.querySelectorAll('#role-grid .role-chip').forEach(function(c){
    var on=c===chip;c.classList.toggle('checked',on);c.querySelector('input').checked=on;
  });
  updateCounts();
}
function setAllRoles(on){
  document.querySelectorAll('#role-grid .role-chip').forEach(function(c){
    c.classList.toggle('checked',on);c.querySelector('input').checked=on;
  });
  updateCounts();
}
function setAllSources(on){
  document.querySelectorAll('#src-sel-grid input[type=checkbox]').forEach(function(i){i.checked=on;});
  updateCounts();
  if(typeof updateTotal==='function')updateTotal();
}
function updateCounts(){
  var r=document.querySelectorAll('#role-grid .role-chip.checked').length;
  var rt=document.querySelectorAll('#role-grid .role-chip').length;
  var rc=document.getElementById('role-count');if(rc)rc.textContent=r+' of '+rt+' selected';
  var sc=document.getElementById('src-count');
  if(sc){
    var on=document.querySelectorAll('#src-sel-grid input[type=checkbox]:checked').length;
    var tot=document.querySelectorAll('#src-sel-grid input[type=checkbox]').length;
    sc.textContent=on+' of '+tot+' selected';
  }
}

// ── Run history ──────────────────────────────────────────────────────────────
// A run's count is only useful if you can see what it actually produced.
function viewRunJobs(id){
  if(!id) return;
  window.open('/pipeline?run='+encodeURIComponent(id),'_blank');
}

function toggleRunsPanel(){
  var el=document.getElementById('runs-panel');
  var open=el.style.display!=='none';
  el.style.display=open?'none':'block';
  if(!open)loadRuns();
}
function loadRuns(){
  var body=document.getElementById('runs-body');
  body.innerHTML='<div style="font-size:11px;color:#8f8f8f">Loading…</div>';
  fetch(BASE+'/runs',{headers:authHeaders()}).then(function(r){return r.ok?r.json():[];}).then(function(rows){
    if(!rows.length){body.innerHTML='<div style="font-size:11px;color:#8f8f8f">No runs yet. Your first one will show up here.</div>';return;}
    body.innerHTML='<table class="runs-tbl"><tr><th>When</th><th>Sources</th><th>Found</th><th>Added</th><th>Excluded</th><th>Took</th></tr>'
      +rows.map(function(r){
        var when=r.run_at?new Date(r.run_at).toLocaleString():(r.date||'');
        var secs=r.duration_ms?Math.round(r.duration_ms/1000)+'s':'—';
        var id=(r.id||'').replace(/"/g,'');
        return '<tr style="cursor:pointer" onclick="viewRunJobs(&apos;'+id+'&apos;)" title="See the jobs this run added">'
          +'<td>'+when+'</td><td>'+(r.sources||0)+'</td><td>'+(r.found||0)+'</td>'
          +'<td style="color:#4ade80">'+(r.added||0)+'</td><td>'+(r.excluded||0)+'</td><td>'+secs+'</td></tr>';
      }).join('')+'</table>';
  }).catch(function(){body.innerHTML='<div style="font-size:11px;color:#c05353">Could not load runs.</div>';});
}

function toggleSourcePanel(){
  const panel=document.getElementById('source-panel');
  const visible=panel.style.display!=='none'&&panel.style.display!=='';
  if(!visible){
    var rp=document.getElementById('runs-panel');if(rp)rp.style.display='none';
    var sc=document.getElementById('sched-panel');if(sc)sc.style.display='none';
    loadCatalog();loadBalance();panel.style.display='block';
    setTimeout(updateCounts,300);
  }
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
      headers:Object.assign({'content-type':'application/json'},authHeaders()),
      body:JSON.stringify({sources:selected,roles}),
    }).then(r=>r.json());
    if(d.status==='already_running'){
      btn.textContent='already running';
      setTimeout(()=>{btn.disabled=false;btn.textContent='run sourcing';},2000);
    } else if(d.error){
      btn.disabled=false;btn.textContent='run sourcing';
      alert(d.error+(d.balance!=null?' (balance: '+d.balance+', needed: '+d.required+')':''));
    } else {
      startLive(true);
    }
  }catch{btn.disabled=false;btn.textContent='run sourcing';}
}

function startLive(userInitiated){
  // Hand the screen over to the run: the config panel staying open on top was
  // why a started run read as nothing happening.
  var sp=document.getElementById('source-panel');if(sp)sp.style.display='none';
  var sc=document.getElementById('sched-panel');if(sc)sc.style.display='none';
  var rp=document.getElementById('runs-panel');if(rp)rp.style.display='none';
  document.getElementById('live-panel').style.display='';
  document.getElementById('live-panel').scrollIntoView({behavior:'smooth',block:'start'});
  document.getElementById('sdot').className='sdot active';
  document.getElementById('topbar-meta').textContent='sourcing in progress…';
  document.getElementById('run-btn').disabled=true;
  document.getElementById('run-btn').textContent='running…';
  setPhase(1);

  var panel=document.getElementById('run-failed');if(panel)panel.style.display='none';
  var sawOutput=false;
  var startedAt=Date.now();

  // A visible clock and a running count, so it is never ambiguous whether
  // anything is happening.
  document.getElementById('live-found-n').textContent='0';
  document.getElementById('live-title').textContent='Agents are searching';
  document.getElementById('live-sub').textContent='Opening a browser session…';
  clearInterval(window.__jaaTick);
  window.__jaaTick=setInterval(function(){
    var s=Math.floor((Date.now()-startedAt)/1000);
    var el=document.getElementById('live-elapsed');
    if(el)el.textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0');
  },1000);
  liveNote('Run started. Connecting to the browser session…','info');

  // Stream log lines via SSE
  es=new EventSource(BASE+'/source/stream?token='+encodeURIComponent(sessionToken()));
  es.onmessage=e=>{
    try{
      sawOutput=true;
      var line=JSON.parse(e.data);
      parseLine(line);
      narrate(String(line||''));
    }catch{}
  };

  // Poll status to detect completion
  statusPoller=setInterval(async()=>{
    try{
      const st=await fetch(BASE+'/source/status',{cache:'no-store',headers:authHeaders()}).then(r=>r.json());
      if(st.active)return;
      clearInterval(statusPoller);
      clearInterval(window.__jaaTick);
      if(es){es.close();es=null;}
      document.getElementById('sdot').className='sdot';
      document.getElementById('run-btn').disabled=false;
      document.getElementById('run-btn').textContent='run sourcing';

      // A run that ends in seconds having printed nothing has failed, not
      // finished. Reloading on both made a crash look identical to success.
      // Reconnecting to an existing run is not the same as starting one: a
      // quiet reconnect must never be reported as a failed launch, which is
      // exactly what a stale cached status used to produce.
      var quick=Date.now()-startedAt<15000;
      if(userInitiated&&!sawOutput&&quick){
        document.getElementById('topbar-meta').textContent='run failed';
        showRunFailure();
        return;
      }
      document.getElementById('topbar-meta').textContent='run complete';
      liveNote('Run complete. Refreshing results…','new');
      setTimeout(()=>location.reload(),2500);
    }catch{}
  },3000);
}

// Turn raw log lines into a plain statement of what the agents are doing.
function narrate(line){
  var sub=document.getElementById('live-sub');
  var title=document.getElementById('live-title');
  if(!sub)return;
  var m;
  if((m=line.match(/Browsing ([^.]+?)\.\.\./))) sub.textContent='Searching '+m[1].trim()+'…';
  else if(/HB session/i.test(line)) sub.textContent='Browser session open. Starting the first source…';
  else if(/Running \d+ of \d+ sources/i.test(line)) sub.textContent=line.trim();
  else if((m=line.match(/(\d+) total, (\d+) matches/))) sub.textContent='Scanned '+m[1]+' listings, '+m[2]+' match your titles';
  else if(/checking location|auditing/i.test(line)) { title.textContent='Checking locations'; sub.textContent=line.trim().slice(0,90); }
  else if(/saving|inserted|added/i.test(line)) { title.textContent='Saving results'; sub.textContent=line.trim().slice(0,90); }
  var found=document.getElementById('live-found-n');
  if(found){
    var n=document.querySelectorAll('#live-feed .live-line.new').length;
    if(n)found.textContent=String(n);
  }
}

async function showRunFailure(){
  var panel=document.getElementById('run-failed');
  var sub=document.getElementById('rf-sub');
  var logEl=document.getElementById('rf-log');
  document.getElementById('live-panel').style.display='none';
  panel.style.display='block';
  sub.textContent='The run exited within seconds without producing any output, so nothing was searched.';
  logEl.textContent='Loading the run log…';
  panel.scrollIntoView({behavior:'smooth',block:'start'});
  var text='';
  try{ text=await fetch(BASE+'/source/log',{headers:authHeaders()}).then(function(r){return r.text();}); }catch(e){}
  text=(text||'').trim();
  logEl.textContent=text?text.split(String.fromCharCode(10)).slice(-16).join(String.fromCharCode(10))
                        :'No log output was captured. The run process died before it could write anything.';
  // Name the cause where the log makes it obvious — far more useful than the raw tail.
  var hints=[];
  if(/HYPERBROWSER|hbKey|hyperbrowser/i.test(text)) hints.push('Hyperbrowser rejected the session or the key is wrong.');
  if(/Cannot find module|ERR_MODULE_NOT_FOUND|playwright/i.test(text)) hints.push('A dependency is missing on the server.');
  if(/ANTHROPIC|api key/i.test(text)) hints.push('The Claude API key was rejected.');
  if(/ECONNREFUSED|ETIMEDOUT|network/i.test(text)) hints.push('A network call failed.');
  if(!text) hints.push('Nothing was logged at all, which usually means the process failed to start.');
  if(hints.length) sub.textContent+=' ' + hints.join(' ');
}

// One-off message into the live feed, so the panel is never silent.
function liveNote(text,cls){
  var feed=document.getElementById('live-feed')||document.querySelector('.live-feed');
  if(!feed)return;
  var d=document.createElement('div');
  d.className='live-line '+(cls||'info');
  d.style.whiteSpace='pre-wrap';
  d.textContent=text;
  feed.appendChild(d);
  feed.scrollTop=feed.scrollHeight;
}

// On page load — auto-connect if a run is already in progress
fetch(BASE+'/source/status',{cache:'no-store',headers:authHeaders()}).then(r=>r.json()).then(st=>{
  if(st.active) startLive(false);
}).catch(()=>{});

checkTargetRoles();

function trackOpen(url){
  fetch(BASE+'/track/open',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},authHeaders()),body:JSON.stringify({url})}).catch(()=>{});
}

async function submitMissed(){
  const input=document.getElementById('missed-url');
  const status=document.getElementById('missed-status');
  const url=input.value.trim();
  if(!url){status.textContent='paste a URL first';return;}
  status.textContent='adding…';
  try{
    const d=await fetch(BASE+'/audit/missed',{method:'POST',headers:Object.assign({'Content-Type':'application/json'},authHeaders()),body:JSON.stringify({url})}).then(r=>r.json());
    if(d.status==='already_exists'){status.textContent='already in the pipeline';}
    else{status.textContent='added'+(d.company?' ('+d.company+')':'');input.value='';}
  }catch{status.textContent='error — check server';}
}
</script>
</body>
</html>`);
});

app.post('/track/open', (req, res) => {
  if (!reqUserEmail(req)) return res.status(401).json({ error: 'Sign in required' });
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
  if (!reqUserEmail(req)) return res.status(401).json({ error: 'Sign in required' });
  const detailFile = path.join(__dirname, '../logs/last-run-detail.json');
  try {
    res.json(fs.existsSync(detailFile) ? JSON.parse(fs.readFileSync(detailFile, 'utf-8')) : null);
  } catch { res.status(500).json({ error: 'read error' }); }
});

const FEEDBACK_FILE = path.join(__dirname, '../logs/audit-feedback.json');

app.get('/audit/feedback', (req, res) => {
  if (!reqUserEmail(req)) return res.status(401).json({ error: 'Sign in required' });
  try { res.json(fs.existsSync(FEEDBACK_FILE) ? JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf-8')) : []); }
  catch { res.json([]); }
});

app.post('/audit/feedback', (req, res) => {
  if (!reqUserEmail(req)) return res.status(401).json({ error: 'Sign in required' });
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
  if (!reqUserEmail(req)) return res.status(401).json({ error: 'Sign in required' });
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
  // A page navigation carries no session, so this used to resolve to "no user"
  // and hand back every user's jobs. Render nothing here; the client fetches
  // its own list with the session it holds.
  const userEmail = reqUserEmail(req);
  const allJobs = userEmail ? await db.getJobs(null, 2000, userEmail) : [];
  const jobsJson = JSON.stringify(allJobs).replace(/<\/script>/gi, '<\\/script>');

  res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">${metaHead({title:'Pipeline — applyapply', desc:'Everything sourced for you, and what is left to work through.', path:'/pipeline', noindex:true})}
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#000;color:#fff;font-size:13px;-webkit-font-smoothing:antialiased;overflow:hidden}
a{text-decoration:none;color:inherit}
.topbar{height:40px;background:#000;border-bottom:1px solid #111;padding:0 20px;display:flex;align-items:center;gap:16px;flex-shrink:0}
.topbar-title{font-weight:700;font-size:13px;letter-spacing:-.01em}${NAV_CSS}
.topbar a{color:#b9b9b9;font-size:12px}
.topbar a:hover{color:#fff}
.tbar-r{margin-left:auto;display:flex;align-items:center;gap:10px}
#balance-display{font-size:11px;color:#b9b9b9}
.kb-btn{font-size:11px;color:#c4c4c4;cursor:pointer;padding:3px 8px;border:1px solid #222;background:none}
.kb-btn:hover{color:#fff;border-color:#b9b9b9}
.pl-wrap{display:flex;height:calc(100vh - 40px - 34px)}

/* Left list pane */
.pl-left{width:256px;flex-shrink:0;border-right:1px solid #111;display:flex;flex-direction:column}
.pl-filters{padding:10px 12px;border-bottom:1px solid #111;display:flex;gap:5px;flex-wrap:wrap}
.pf{padding:4px 9px;background:transparent;color:#b9b9b9;border:1px solid #181818;font-size:11px;cursor:pointer;font-family:inherit;transition:color .1s,border-color .1s}
.pf:hover{color:#e6e6e6;border-color:#9a9a9a}
.pf.on{color:#fff;border-color:#b9b9b9;background:#111}
.pf-n{font-size:10px;color:#b9b9b9;margin-left:2px}
.pf.on .pf-n{color:#888}
.pl-list{flex:1;overflow-y:auto}
.pitem{padding:10px 14px;border-bottom:1px solid #0d0d0d;cursor:pointer;transition:background .08s}
.pitem:hover{background:#080808}
.pitem.on{background:#111;box-shadow:inset 2px 0 0 #fff}
.pitem.fading{opacity:0;transition:opacity .2s}
.pi-co{font-size:13px;font-weight:600;color:#fff;margin-bottom:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pi-role{font-size:11px;color:#b9b9b9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px}
.pi-meta{font-size:10px;color:#8f8f8f}
.pl-empty{padding:16px 14px;font-size:12px;color:#9a9a9a}

/* Right detail pane */
.pl-right{flex:1;overflow-y:auto;display:flex;flex-direction:column;min-width:0}
.pr-idle{display:flex;align-items:center;justify-content:center;height:100%;color:#8a8a8a;font-size:13px;letter-spacing:.02em}
.pr-head{padding:28px 36px 22px;border-bottom:1px solid #111}
.pr-co{font-size:26px;font-weight:700;letter-spacing:-.04em;margin-bottom:4px}
.pr-role{font-size:14px;color:#888;margin-bottom:14px}
.pr-attrs{display:flex;gap:20px;flex-wrap:wrap;margin-bottom:16px}
.pr-attr{font-size:11px;color:#a8a8a8}
.pr-attr b{color:#c4c4c4;font-weight:500}
.pr-url{font-size:12px;color:#b9b9b9;border-bottom:1px solid #1e1e1e;padding-bottom:1px}
.pr-url:hover{color:#fff;border-color:#b9b9b9}
.pr-body{padding:24px 36px;flex:1}
.pr-fit{display:inline-flex;align-items:baseline;gap:3px;margin-bottom:20px}
.pr-fit-n{font-size:36px;font-weight:700;letter-spacing:-.05em;line-height:1}
.pr-fit-d{font-size:14px;color:#a8a8a8}
.pr-fit-l{font-size:10px;color:#a8a8a8;margin-left:8px;letter-spacing:.05em;text-transform:uppercase}
.pr-btns{display:flex;gap:8px;align-items:center;margin-bottom:20px}
.pr-open-btn{display:inline-flex;align-items:center;gap:10px;padding:11px 18px;background:#fff;color:#000;border:none;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
.pr-open-btn:hover{background:#e5e5e5}
.pr-done-btn{display:inline-flex;align-items:center;gap:8px;padding:11px 16px;background:transparent;color:#4ade80;border:1px solid #2a4a33;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
.pr-done-btn:hover{background:#132218;border-color:#4ade80}
.pr-done-btn .pr-open-key{background:#1a2a1f;color:#4ade80}
.pr-state{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#777}
.pr-state b{color:#b9b9b9;font-weight:600}
.pr-skip-btn{display:inline-flex;align-items:center;gap:8px;padding:11px 16px;background:transparent;color:#b9b9b9;border:1px solid #1e1e1e;font-size:13px;cursor:pointer;font-family:inherit}
.pr-skip-btn:hover{color:#fff;border-color:#b9b9b9}
.pr-open-key{display:inline-block;background:#ddd;color:#000;font-size:11px;padding:1px 6px;border-radius:2px}
.pr-skip-btn .pr-open-key{background:#1a1a1a;color:#888}

/* Coverage + worklist progress */
.cov{display:flex;align-items:center;gap:22px;padding:11px 20px;border-bottom:1px solid #111;background:#060606;flex-wrap:wrap}
.cov-claim{font-size:12px;color:#ccc}
.cov-claim b{color:#fff}
.cov-prog{display:flex;align-items:center;gap:10px;margin-left:auto}
.cov-bar{width:150px;height:6px;background:#161616;overflow:hidden}
.cov-fill{height:100%;background:#4ade80;width:0%;transition:width .4s ease}
.cov-num{font-size:11px;color:#b9b9b9;white-space:nowrap}
.cov-cta{font-size:11px;color:#0a0a0a;background:#fff;border:none;padding:5px 12px;font-weight:700;cursor:pointer;font-family:inherit}

/* Keyboard help */
.kb-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;align-items:center;justify-content:center}
.kb-overlay.on{display:flex}
.kb-panel{background:#0d0d0d;border:1px solid #222;padding:24px 28px;min-width:220px}
.kb-panel-title{font-size:11px;font-weight:700;color:#b9b9b9;letter-spacing:.07em;text-transform:uppercase;margin-bottom:14px}
.kb-panel table{font-size:12px;border-collapse:collapse;width:100%}
.kb-panel td{padding:4px 0;color:#bbb}
.kb-panel td:first-child{color:#a8a8a8;width:48px;font-family:monospace;font-size:11px}
.kb-panel-close{margin-top:14px;font-size:11px;color:#9a9a9a}

.kb-bar{position:fixed;bottom:0;left:0;right:0;height:34px;background:#050505;border-top:1px solid #111;display:flex;align-items:center;padding:0 20px;gap:0;z-index:50}
.kb-bar-item{display:flex;align-items:center;gap:5px;font-size:11px;color:#a8a8a8;padding:0 14px;border-right:1px solid #111}
.kb-bar-item:first-child{padding-left:0}
.kb-bar kbd{display:inline-block;background:#111;border:1px solid #1e1e1e;color:#c4c4c4;font-size:10px;padding:1px 6px;min-width:16px;text-align:center;font-family:inherit;border-radius:2px}
.kb-bar-hint{margin-left:auto;font-size:11px;color:#8f8f8f;cursor:pointer;padding:0 0 0 14px}
.kb-bar-hint:hover{color:#b9b9b9}
.toast{position:fixed;bottom:48px;right:24px;background:#fff;color:#000;padding:8px 16px;font-size:12px;font-weight:600;opacity:0;transition:opacity .18s;pointer-events:none}
.toast.on{opacity:1}
</style></head><body>
<div class="topbar">
  <span class="topbar-title">applyapply</span>
  ${navHTML('/pipeline')}
  <div class="tbar-r">
    <span id="balance-display"></span>
    <button class="kb-btn" id="kb-toggle">?</button>
  </div>
</div>
<div class="cov" id="cov" style="display:none">
  <div class="cov-claim" id="cov-claim"></div>
  <div class="cov-prog">
    <div class="cov-bar"><div class="cov-fill" id="cov-fill"></div></div>
    <span class="cov-num" id="cov-num"></span>
    <button class="cov-cta" id="cov-cta" onclick="jumpToNext()">Work the next one</button>
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
      <tr><td>d</td><td>Mark applied &mdash; you submitted it yourself</td></tr>
      <tr><td>s</td><td>Skip</td></tr>
      <tr><td>u</td><td>Move back to new</td></tr>
      <tr><td>?</td><td>This panel</td></tr>
    </tbody></table>
    <div class="kb-panel-close">Esc to close</div>
  </div>
</div>
<script>
var JOBS = ${jobsJson};

function plAuth(){ try{ var t=localStorage.getItem('aa_session'); return t?{'x-api-key':t}:{}; }catch(e){ return {}; } }

function ago(iso){
  if(!iso) return 'never';
  var m=Math.round((Date.now()-new Date(iso).getTime())/60000);
  if(m<60) return m+'m ago';
  if(m<1440) return Math.round(m/60)+'h ago';
  return Math.round(m/1440)+'d ago';
}

// Answers the two questions that matter: did we cover the ground, and how much
// is left for me to work through.
function loadCoverage(){
  fetch('/coverage',{headers:plAuth(),cache:'no-store'})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(c){
      if(!c) return;
      document.getElementById('cov').style.display='flex';
      var scanned=(c.scanned||0).toLocaleString();
      document.getElementById('cov-claim').innerHTML =
        'Scanned <b>'+scanned+'</b> postings across <b>'+(c.companies||0)+'</b> companies in '
        + (c.runs||0)+' run'+((c.runs===1)?'':'s')+' · last <b>'+ago(c.last_run)+'</b>';
      var todo=c.todo||0, done=c.done||0, total=todo+done;
      var pct=total?Math.round(done/total*100):0;
      document.getElementById('cov-fill').style.width=pct+'%';
      document.getElementById('cov-num').textContent=
        todo? (todo+' to work through · '+done+' done') : (total? 'All '+total+' worked through' : 'Nothing sourced yet');
      document.getElementById('cov-cta').style.display=todo?'':'none';
    }).catch(function(){});
}

// The server cannot identify the user on a plain page navigation, so the list
// is fetched here with the session this page holds. Without this the page
// renders an empty JOBS array and looks like nothing was ever sourced.
function loadJobs(){
  var runId=new URLSearchParams(location.search).get('run');
  if(runId){
    fetch('/runs/'+encodeURIComponent(runId)+'/jobs',{headers:plAuth(),cache:'no-store'})
      .then(function(r){return r.ok?r.json():null;})
      .then(function(rows){
        if(!rows) return;
        JOBS=rows;
        renderFilters(); renderList();
        // The coverage strip is hidden until something fills it, and
        // loadCoverage is skipped in this view.
        var cov=document.getElementById('cov');
        if(cov) cov.style.display='flex';
        var c=document.getElementById('cov-claim');
        if(c) c.innerHTML='Showing the <b>'+rows.length+'</b> job'+(rows.length===1?'':'s')+' from one run · <a href="/pipeline" style="color:#60a5fa">see everything</a>';
        var n=document.getElementById('cov-num');
        if(n) n.textContent='';
        var f=document.getElementById('cov-fill');
        if(f) f.style.width='0%';
        var cta=document.getElementById('cov-cta');
        if(cta) cta.style.display='none';
      }).catch(function(){});
    return;
  }
  fetch('/sourced',{headers:plAuth(),cache:'no-store'})
    .then(function(r){return r.ok?r.json():null;})
    .then(function(rows){
      if(!rows||!rows.length) return;
      JOBS=rows;
      renderFilters();
      renderList();
    }).catch(function(){});
}

// Jump straight to the next unworked job — the list is a queue, not an archive.
function jumpToNext(){
  var idx=listItems.findIndex(function(j){return j.status==='new'||j.status==='reviewed';});
  if(idx<0){ idx=0; }
  if(listItems[idx]) selectItem(idx);
}

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
  loadCoverage();
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
  // A kit already exists for this job — link straight to it. Prepending our own
  // origin to the job URL loads the cached kit, so reopening costs nothing.
  if (j.kit_generated_at) {
    html += '<button class="pr-open-btn" onclick="viewKit(listItems[' + selIdx + '])">View kit</button>';
  }
  html += '<button class="pr-open-btn" onclick="openAndGenerate(listItems[' + selIdx + '])"><span class="pr-open-key">&crarr;</span> ' + (j.kit_generated_at ? 'Open job page' : 'Open &amp; generate kit') + '</button>';
  if (j.status === 'applied' || j.status === 'skipped') {
    html += '<button class="pr-skip-btn" onclick="doAction(&apos;new&apos;)"><span class="pr-open-key">U</span> Back to new</button>';
  } else {
    html += '<button class="pr-done-btn" onclick="doAction(&apos;applied&apos;)"><span class="pr-open-key">D</span> I applied</button>';
    html += '<button class="pr-skip-btn" onclick="doAction(&apos;skipped&apos;)"><span class="pr-open-key">S</span> Skip</button>';
  }
  html += '</div>';
  if (j.status === 'applied')  html += '<div class="pr-state">&#10003; <b>Applied</b> &mdash; out of the worklist</div>';
  if (j.status === 'skipped')  html += '<div class="pr-state"><b>Skipped</b> &mdash; out of the worklist</div>';
  if (j.status === 'applying') html += '<div class="pr-state"><b>In progress</b> &mdash; press D once you have submitted</div>';
  html += '</div>';
  document.getElementById('pl-right').innerHTML = html;
}

// Our own origin prepended to the job URL serves the cached kit — free, no regeneration.
function viewKit(j) {
  window.open(location.origin + '/' + j.url, '_blank');
}

async function openAndGenerate(j) {
  await fetch('/sourced/pending-generate', {
    method:'POST', headers:Object.assign({'Content-Type':'application/json'}, plAuth()),
    body: JSON.stringify({url: j.url})
  }).catch(()=>{});
  window.open(j.url, '_blank');
  if (j.status === 'new') doAction('applying');
}

async function doAction(status) {
  if (selIdx < 0 || selIdx >= listItems.length) return;
  var j = listItems[selIdx];
  var res = await fetch('/sourced/status', {
    method:'POST', headers:Object.assign({'Content-Type':'application/json'}, plAuth()),
    body: JSON.stringify({url:j.url, status:status})
  });
  if (!res.ok) { showToast('Error'); return; }
  j.status = status;
  setTimeout(loadCoverage, 300);
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
    document.getElementById('pl-right').innerHTML = '<div class="pr-idle">All caught up &mdash; find more roles in <a href="/sourcing" style="color:#b9b9b9;text-decoration:underline">Sourcing</a></div>';
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

fetch('/credits',{headers:plAuth()}).then(function(r){return r.ok?r.json():{};}).then(function(d){
  var b = d.balance ?? d.credits ?? null;
  var el = document.getElementById('balance-display');
  if (el && b !== null) { el.textContent = b + ' cr'; el.style.color = b < 20 ? '#92400e' : '#555'; }
}).catch(function(){});

renderFilters();
renderList();
// Viewing one run has its own claim line; the 30-day coverage line would
// resolve later and overwrite it.
if(!new URLSearchParams(location.search).get('run')) loadCoverage();
loadJobs();
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
${metaHead({title:'Apply kit — applyapply', desc:'Your tailored application for this role.', path:'/', noindex:true})}
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
.field-val::placeholder{color:#6a6a6a}

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
.warm{font-size:11px;color:#b9b9b9;padding:10px 12px;border:1px solid #0d0d0d;font-style:italic;margin-top:-4px;margin-bottom:8px}

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
.retry-drawer textarea::placeholder{color:#8f8f8f}
.retry-row{display:flex;gap:8px;margin-top:8px;align-items:center}
.retry-hint{font-size:11px;color:#b9b9b9;flex:1}
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

    <div class="section">
      <div class="section-hd"><span class="section-label">Tailored resume</span></div>
      <div id="resumeSection"></div>
    </div>
  </div>

</div>

<div class="retry-drawer" id="retryDrawer">
  <textarea id="retryNote" rows="2" placeholder="What's wrong with it? Be specific. &quot;Make the cover note less formal&quot;, &quot;lean into the Filmhub angle more&quot;, etc."></textarea>
  <div class="retry-row">
    <span class="retry-hint">Costs ${CREDIT_COSTS.generate} credits — rewrites the whole kit.</span>
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
var resumeData = null;
var RESUME_COST = ${CREDIT_COSTS.resume};
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

  resumeData = kit.tailored_resume || null;
  renderResumeSection();
  if (kit.resume_skipped) {
    var rs = document.getElementById('resumeSection');
    if (rs) rs.insertAdjacentHTML('afterbegin',
      '<div style="font-size:11px;color:#f59e0b;margin-bottom:10px">' + esc(kit.resume_skipped) + '</div>');
  }

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

// ── tailored resume ──────────────────────────────────────────────────────────
function renderResumeSection() {
  var el = document.getElementById('resumeSection');
  if (resumeData) {
    var exp = (resumeData.experience || []).map(function(e) {
      return '<div style="margin-bottom:14px">' +
        '<div style="font-weight:600;font-size:13px;color:#fff">' + esc(e.company || '') + ' — ' + esc(e.title || '') + '</div>' +
        '<div style="font-size:11px;color:#b9b9b9;margin-bottom:6px">' + esc(e.dates || '') + '</div>' +
        '<ul style="margin:0 0 0 18px;padding:0;font-size:12px;line-height:1.7;color:#ccc">' +
        (e.bullets || []).map(function(b) { return '<li>' + esc(b) + '</li>'; }).join('') +
        '</ul></div>';
    }).join('');
    var cov = resumeData.coverage || null;
    var covHtml = '';
    if (cov) {
      var tone = cov.confidence === 'strong' ? '#4ade80' : cov.confidence === 'thin' ? '#f59e0b' : '#60a5fa';
      covHtml = '<div style="border:1px solid #1a1a1a;padding:10px 12px;margin-bottom:14px;background:#050505">'
        + '<div style="font-size:11px;color:' + tone + ';font-weight:600;margin-bottom:6px">'
        + esc(String(cov.confidence || '').toUpperCase()) + ' — how well your real experience covers this role</div>'
        + (cov.gaps && cov.gaps.length
            ? '<div style="font-size:11px;color:#b9b9b9;line-height:1.7"><b style="color:#fff">Not evidenced.</b> If you have done this, say so and it goes into your profile for every future application:</div>'
              + cov.gaps.map(function(g, i) {
                  return '<div style="margin-top:8px">'
                    + '<div style="font-size:11px;color:#ccc;margin-bottom:4px">' + esc(g) + '</div>'
                    + '<textarea id="gap-' + i + '" placeholder="What you actually did. Specifics beat adjectives." style="width:100%;min-height:52px;background:#0a0a0a;border:1px solid #222;color:#fff;font-size:11px;font-family:inherit;padding:6px;outline:none;resize:vertical"></textarea>'
                    + '<button onclick="saveGapContext(' + i + ')" style="margin-top:4px;padding:4px 10px;background:#0a0a0a;border:1px solid #2a2a2a;color:#b9b9b9;font-size:10px;cursor:pointer;font-family:inherit">Save to profile</button>'
                    + '<span class="gap-st" id="gap-st-' + i + '" style="font-size:10px;color:#8f8f8f;margin-left:8px"></span>'
                    + '</div>';
                }).join('')
              + '<button onclick="generateResume(true)" style="margin-top:12px;padding:6px 12px;background:#fff;color:#0a0a0a;border:none;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit">Regenerate with this context — ' + RESUME_COST + ' credits</button>'
            : '<div style="font-size:11px;color:#b9b9b9">Everything this role asks for is backed by real experience.</div>')
        + (cov.improve ? '<div style="font-size:11px;color:#8f8f8f;margin-top:8px">' + esc(cov.improve) + '</div>' : '')
        + '</div>';
    }
    el.innerHTML =
      '<div class="gen-block">' +
        covHtml +
        '<div style="font-size:12px;color:#ccc;line-height:1.6;margin-bottom:16px">' + esc(resumeData.summary || '') + '</div>' +
        exp +
        (resumeData.skills && resumeData.skills.length ? '<div style="font-size:11px;color:#888;margin-top:4px"><b style="color:#fff">Skills:</b> ' + esc(resumeData.skills.join(', ')) + '</div>' : '') +
        '<div class="gen-actions" style="margin-top:14px">' +
          '<button class="icon-btn" onclick="generateResume(true)">Regenerate</button>' +
          '<button class="icon-btn" onclick="downloadResumePDF()">PDF</button>' +
        '</div>' +
      '</div>';
  } else {
    el.innerHTML =
      '<div style="font-size:12px;color:#888;line-height:1.6;margin-bottom:12px">' +
        'Your own resume works fine for most applications. This rewrites it for this specific role, ' +
        'reordering and rewording your real bullets to match what the posting asks for. It never invents experience.' +
      '</div>' +
      '<button class="btn-primary" style="padding:9px 18px;font-size:12px" onclick="generateResume(false)">Generate tailored resume — ' + RESUME_COST + ' credits</button>';
  }
}

// Saves against the gap text itself, so the answer is reusable evidence rather
// than a one-off edit to this resume.
function saveGapContext(i) {
  var ta = document.getElementById('gap-' + i);
  var st = document.getElementById('gap-st-' + i);
  var gaps = (resumeData && resumeData.coverage && resumeData.coverage.gaps) || [];
  if (!ta || !ta.value.trim()) { if (st) st.textContent = 'Write something first'; return; }
  st.textContent = 'Saving…';
  fetch('/interview/context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getSession() },
    body: JSON.stringify({ question: gaps[i] || ('Context ' + i), answer: ta.value }),
  }).then(function(r) {
    st.textContent = r.ok ? 'Saved to your profile' : 'Could not save';
  }).catch(function() { st.textContent = 'Could not save'; });
}

function generateResume(force) {
  if (!kitData) return;
  var el = document.getElementById('resumeSection');
  el.innerHTML = '<div style="font-size:12px;color:#888">Rewriting your resume for this role…</div>';
  fetch('/resume-tailor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + getSession() },
    body: JSON.stringify({ appId: kitData.id }),
  })
  .then(function(r) {
    if (r.status === 402) { el.innerHTML = '<div style="font-size:12px;color:#f87171">Out of credits. <a href="/buy" style="color:#ef4444;text-decoration:underline">Top up →</a></div>'; return null; }
    if (r.status === 422) { return r.json().then(function(e) { el.innerHTML = '<div style="font-size:12px;color:#f87171">' + esc(e.error) + '</div>'; return null; }); }
    if (!r.ok) return r.json().then(function(e) { el.innerHTML = '<div style="font-size:12px;color:#f87171">' + esc(e.error || 'Failed') + '</div>'; return null; });
    return r.json();
  })
  .then(function(d) { if (d) { resumeData = d; renderResumeSection(); } })
  .catch(function() { el.innerHTML = '<div style="font-size:12px;color:#f87171">Network error.</div>'; });
}

function downloadResumePDF() {
  if (!resumeData) return;
  var r = resumeData;
  var w = window.open('', '_blank');
  if (!w) return;
  var roles = (r.experience || []).map(function(e) {
    var bullets = (e.bullets || []).map(function(b) { return '<li>' + esc(b) + '</li>'; }).join('');
    return '<section>'
      + '<div class="role"><span class="co">' + esc(e.company) + '</span><span class="dates">' + esc(e.dates) + '</span></div>'
      + '<div class="title">' + esc(e.title) + '</div>'
      + '<ul>' + bullets + '</ul>'
      + '</section>';
  }).join('');
  var skills = (r.skills && r.skills.length)
    ? '<div class="skills"><b>Skills</b> &nbsp;' + esc(r.skills.join(' \u00b7 ')) + '</div>'
    : '';
  var css = '@page { margin: 0.6in; }'
    + 'body { font-family: Georgia, "Times New Roman", serif; font-size: 10.5pt; line-height: 1.45; color: #111; max-width: 7.2in; margin: 0 auto; }'
    + 'h1 { font-size: 19pt; letter-spacing: -.02em; margin: 0 0 4pt; }'
    + '.summary { margin: 0 0 14pt; }'
    + 'section { margin-bottom: 12pt; page-break-inside: avoid; }'
    + '.role { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #ddd; padding-bottom: 2pt; }'
    + '.co { font-weight: bold; font-size: 11.5pt; }'
    + '.dates { font-size: 9pt; color:#b9b9b9; }'
    + '.title { font-style: italic; margin: 2pt 0 4pt; }'
    + 'ul { margin: 0; padding-left: 15pt; } li { margin-bottom: 3pt; }'
    + '.skills { margin-top: 12pt; font-size: 10pt; } .skills b { font-variant: small-caps; letter-spacing: .04em; }';
  w.document.write('<!DOCTYPE html><html><head><title>' + esc(r.name || 'Resume') + '</title>'
    + '<style>' + css + '</style></head><body>'
    + '<h1>' + esc(r.name || '') + '</h1>'
    + '<p class="summary">' + esc(r.summary || '') + '</p>'
    + roles + skills
    + '</body></html>');
  w.document.close();
  w.focus();
  setTimeout(function() { w.print(); }, 400);
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
  var blob = new Blob([lines.join('\\n')], { type: 'text/plain' });
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
  // A malformed request body is the caller's fault, not a server fault.
  // Returning 500 for it hides real failures in the same bucket.
  if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  console.error('[request error]', error);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  db.initSchema()
    .then(() => console.log('DB schema ready'))
    .catch(e => { console.error('DB schema init failed:', e.message); process.exit(1); })
    .then(() => {
      app.listen(PORT, async () => {
        console.log(`\nJob Apply Server — http://localhost:${PORT}`);
        const count = await db.countKits().catch(() => 0);
        console.log(`${count} kits in database`);
        console.log(`AI: ${keys ? `enabled via ${keys.provider} (haiku)` : 'disabled — no API key found'}\n`);
        startCron();
      });
    });
}

module.exports = { app };
