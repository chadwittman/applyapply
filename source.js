#!/usr/bin/env node
// Daily job sourcing agent — browser-first with visual validation
// Run: node source.js

const fs = require('fs');
const path = require('path');
const { insertRun, upsertJob, getSeenUrls, getProfileByUserEmail, cacheKeyFor, roleKeyFor, getCachedSources, putCachedSource } = require('./server/db');

// Board results are identical for everyone; Google results vary only by role
// titles. Sharing them means one fetch serves every user who wants that
// combination, and a run whose sources are all cached needs no browser at all.
const SOURCE_CACHE_HOURS = Number(process.env.SOURCE_CACHE_HOURS || 20);

const BASE = __dirname;
const SOURCED_FILE = path.join(BASE, 'sourced-jobs.json');
const APPLIED_FILE = path.join(BASE, 'applied-log.json');
const APPS_DIR = path.join(BASE, 'applications');
const LOG_DIR = path.join(BASE, 'logs');

function loadKey() {
  return process.env.ANTHROPIC_API_KEY || null;
}

function loadHBKey() {
  return process.env.HYPERBROWSER_API_KEY || null;
}

async function createHBSession(hbKey) {
  const r = await fetch('https://app.hyperbrowser.ai/api/session', {
    method: 'POST',
    headers: { 'x-api-key': hbKey, 'content-type': 'application/json' },
    body: JSON.stringify({ headless: true }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    if (r.status === 402) throw new Error(`HB quota exceeded (402) — check hyperbrowser.ai billing. ${body.slice(0,200)}`);
    throw new Error(`HB session error ${r.status}: ${body.slice(0,200)}`);
  }
  return r.json();
}

async function closeHBSession(hbKey, id) {
  await fetch(`https://app.hyperbrowser.ai/api/session/${id}`, {
    method: 'DELETE', headers: { 'x-api-key': hbKey },
  }).catch(() => {});
}

function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return []; }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function log(msg) { process.stdout.write(msg + '\n'); }
function step(label) { log(`\n── ${label}`); }
function item(symbol, msg) { log(`   ${symbol}  ${msg}`); }

async function callClaude(key, body) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`API error ${r.status}: ${await r.text()}`);
  return r.json();
}

function extractText(data) {
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

// For Ashby jobs, pull location directly from their public API
async function fetchAshbyLocation(url) {
  try {
    const m = url.match(/jobs\.ashbyhq\.com\/([^/]+)\/([a-f0-9-]{36})/);
    if (!m) return null;
    const [, org, jobId] = m;

    // Fetch the org's job board page — it embeds all jobs as JSON including
    // secondaryLocations which is how multi-location jobs (e.g. "Vancouver HQ; Remote (US)")
    // are represented. The old single-job API endpoint is unreliable.
    const r = await fetch(`https://jobs.ashbyhq.com/${org}`, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    });
    if (!r.ok) return null;
    const html = await r.text();

    // Find the job object by scanning JSON objects that contain the target ID
    const idStr = `"id":"${jobId}"`;
    const idx = html.indexOf(idStr);
    if (idx === -1) return null;
    // Walk backwards to find the opening `{` of this object
    const start = html.lastIndexOf('{', idx);
    if (start === -1) return null;
    // Walk forwards counting braces to find the matching `}`
    let depth = 0, end = -1;
    for (let i = start; i < Math.min(start + 2000, html.length); i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return null;
    let job;
    try { job = JSON.parse(html.slice(start, end + 1)); } catch { return null; }

    // Collect ALL location names: primary + secondaryLocations
    const locs = [];
    if (job.locationName) locs.push(job.locationName);
    if (Array.isArray(job.secondaryLocations)) {
      for (const sl of job.secondaryLocations) {
        const n = sl.locationName || sl.name || (typeof sl === 'string' ? sl : null);
        if (n && !locs.includes(n)) locs.push(n);
      }
    }
    if (job.workplaceType && job.workplaceType !== 'OnSite') locs.push(`type:${job.workplaceType}`);

    return locs.length ? `Ashby locations: ${locs.join(' | ')}` : null;
  } catch { return null; }
}

async function fetchPageText(url) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    });
    if (!r.ok) return null;
    const html = await r.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 6000);
    return text.trim().length < 200 ? null : text;
  } catch { return null; }
}

async function auditLocation(key, job, pageText) {
  let ashbyLoc = null;
  if (job.url.includes('jobs.ashbyhq.com')) {
    ashbyLoc = await fetchAshbyLocation(job.url);
  }

  const locationContext = [
    ashbyLoc ? `Ashby API location: "${ashbyLoc}"` : null,
    job.location ? `Location from search: "${job.location}"` : null,
    pageText ? `Page content: ${pageText}` : null,
  ].filter(Boolean).join('\n\n') || 'No location data available';

  const hybridCity = SOURCE_LOCATION;
  const prompt = `You are auditing a job posting for location eligibility.

The candidate is in ${hybridCity}. They will only apply to:
- Jobs that include ANY "Remote (US)" or "Remote US" or unqualified "Remote" option (even if other locations like HQ cities are also listed)
- Hybrid jobs where the office is specifically in ${hybridCity}

Job: ${job.role} at ${job.company}
URL: ${job.url}

Location data:
${locationContext}

Rules — read ALL listed locations, not just the first one:
- If ANY location option says "Remote (US)", "Remote US", "Remote - US", "US Remote" → verdict: remote
- If ANY location says unqualified "Remote" or "Fully Remote" or "100% Remote" with no country → verdict: remote (assume US unless explicitly restricted)
- If ANY location says "${hybridCity}" with hybrid/in-office → verdict: hybrid
- If remote is qualified as ONLY non-US (e.g. "Remote (Canada)", "Remote (Europe)", "Remote - EMEA") with no US option → verdict: exclude
- If the ONLY locations are specific non-${hybridCity} offices → verdict: exclude
- If location data is ambiguous or partially loaded, lean toward remote if the role is listed on a remote-friendly job board
- Only exclude if you are confident the role is NOT available remote in the US

Respond with JSON only:
{"verdict":"remote"|"hybrid"|"exclude","location_found":"exact text from data","reason":"one sentence"}`;

  try {
    const data = await callClaude(key, {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = extractText(data);
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { verdict: 'exclude', reason: 'parse error' };
  } catch { return { verdict: 'exclude', reason: 'audit error' }; }
}

// ── Browser sources ────────────────────────────────────────────────────────────
// Each entry is one of three modes:
//   apiMode      — hit an internal API directly (a16z)
//   googleSearch — navigate Google, extract results with vision
//   (default)    — navigate the page, scroll, screenshot + text → vision extract

const HB_SOURCES = [
  {
    name: 'a16z job board',
    url: 'https://jobs.a16z.com/jobs?remoteOnly=true&postedSince=P2D',
    waitMs: 2000,
    apiMode: {
      endpoint: '/api-boards/search-jobs',
      body: { meta: { size: 200 }, board: { id: 'andreessen-horowitz', isParent: true }, query: { remoteOnly: true, postedSince: 'P2D', promoteFeatured: true } },
    },
  },
  {
    name: 'Sequoia job board',
    url: 'https://jobs.sequoiacap.com/jobs?remote=true',
    waitMs: 2000,
    apiMode: {
      endpoint: '/api-boards/search-jobs',
      body: { meta: { size: 200 }, board: { id: 'sequoia-capital', isParent: true }, query: { remoteOnly: true, promoteFeatured: true } },
    },
  },
  {
    name: 'YC / Work at a Startup',
    googleSearch: true,
    query: 'site:workatastartup.com ("head of product" OR "head of growth" OR "founding pm" OR "founding product" OR "vp of product" OR "director of product") remote',
  },
  {
    name: 'Wellfound',
    googleSearch: true,
    query: 'site:wellfound.com ("head of product" OR "head of growth" OR "founding pm" OR "founding product" OR "vp of product" OR "director of product") remote',
  },
  {
    name: 'Builtin remote product',
    googleSearch: true,
    query: 'site:builtin.com ("head of product" OR "head of growth" OR "founding pm" OR "director of product" OR "vp of product") remote',
  },
  {
    name: 'Ashby jobs (Google)',
    googleSearch: true,
    query: 'site:jobs.ashbyhq.com ("head of product" OR "head of growth" OR "founding pm" OR "vp of product" OR "director of product" OR "founding product") remote',
  },
  {
    name: 'Lever jobs (Google)',
    googleSearch: true,
    query: 'site:jobs.lever.co ("head of product" OR "head of growth" OR "founding pm" OR "vp of product" OR "director of product") remote',
  },
  {
    name: 'Greenhouse jobs (Google)',
    googleSearch: true,
    query: 'site:greenhouse.io ("head of product" OR "head of growth" OR "founding pm" OR "vp product" OR "senior product manager" OR "director of product") remote',
  },
];

// Resolved at runtime from profile — see buildSourceConfig()
let ROLE_RE = /head of product|head of growth|vp of product|vp of growth|director of product|director of growth|founding pm|founding product|growth pm|gtm lead|growth lead|product manager|senior product|staff product/i;
let ROLE_TITLES = 'Head of Product, VP of Product, Director of Product, Head of Growth, VP of Growth, Director of Growth, Founding PM, Founding Head of Product, Founding Product Lead, Growth PM, GTM Lead, Growth Lead';
// JAA_TARGET_ROLES overrides profile roles (set by /source/run from the role picker UI)
if (process.env.JAA_TARGET_ROLES) {
  ROLE_TITLES = process.env.JAA_TARGET_ROLES;
  const parts = ROLE_TITLES.split(',').map(t => t.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()).filter(Boolean);
  ROLE_RE = new RegExp(parts.join('|'), 'i');
}
let SOURCE_USER_EMAIL = process.env.JAA_USER_EMAIL || null;
let SOURCE_LOCATION = 'Austin TX'; // user's city for hybrid-office check
let SOURCE_LOCATION_PREF = 'remote'; // 'remote' | 'hybrid' | 'any'

function buildHBSources() {
  const roleParts = ROLE_TITLES.split(', ').map(t => `"${t.toLowerCase()}"`).join(' OR ');
  const remoteQ = SOURCE_LOCATION_PREF === 'hybrid' ? '' : ' remote';
  return [
    {
      name: 'a16z job board',
      url: 'https://jobs.a16z.com/jobs?remoteOnly=true&postedSince=P2D',
      waitMs: 2000,
      apiMode: {
        endpoint: '/api-boards/search-jobs',
        body: { meta: { size: 200 }, board: { id: 'andreessen-horowitz', isParent: true }, query: { remoteOnly: true, postedSince: 'P2D', promoteFeatured: true } },
      },
    },
    {
      name: 'Sequoia job board',
      url: 'https://jobs.sequoiacap.com/jobs?remote=true',
      waitMs: 2000,
      apiMode: {
        endpoint: '/api-boards/search-jobs',
        body: { meta: { size: 200 }, board: { id: 'sequoia-capital', isParent: true }, query: { remoteOnly: true, promoteFeatured: true } },
      },
    },
    {
      name: 'YC / Work at a Startup',
      googleSearch: true,
      query: `site:workatastartup.com (${roleParts})${remoteQ}`,
    },
    {
      name: 'Wellfound',
      googleSearch: true,
      query: `site:wellfound.com (${roleParts})${remoteQ}`,
    },
    {
      name: 'Builtin remote product',
      googleSearch: true,
      query: `site:builtin.com (${roleParts})${remoteQ}`,
    },
    {
      name: 'Ashby jobs (Google)',
      googleSearch: true,
      query: `site:jobs.ashbyhq.com (${roleParts})${remoteQ}`,
    },
    {
      name: 'Lever jobs (Google)',
      googleSearch: true,
      query: `site:jobs.lever.co (${roleParts})${remoteQ}`,
    },
    {
      name: 'Greenhouse jobs (Google)',
      googleSearch: true,
      query: `site:greenhouse.io (${roleParts})${remoteQ} ai startup`,
    },
  ];
}

async function runBrowserSources(claudeKey, hbKey) {
  let HB_SOURCES = buildHBSources();
  if (process.env.JAA_ENABLED_SOURCES) {
    try {
      const enabled = new Set(JSON.parse(process.env.JAA_ENABLED_SOURCES));
      HB_SOURCES = HB_SOURCES.filter(s => enabled.has(s.name));
      log(`   Running ${HB_SOURCES.length} of ${buildHBSources().length} sources`);
    } catch {}
  }
  const results = [];

  // Only allScanned is cacheable — `jobs` is filtered by this user's role
  // regex, so it gets recomputed locally from the shared raw results.
  const keyOf = src => cacheKeyFor(src.name, ROLE_TITLES, !!src.apiMode);
  let misses = HB_SOURCES;
  try {
    const cached = await getCachedSources(HB_SOURCES.map(keyOf), SOURCE_CACHE_HOURS);
    misses = [];
    for (const source of HB_SOURCES) {
      const hit = cached[keyOf(source)];
      if (!hit) { misses.push(source); continue; }
      const all = hit.allScanned || [];
      const found = all.filter(j => ROLE_RE.test(j.role));
      item('·', `${source.name} — shared cache, ${all.length} scanned, ${found.length} match`);
      results.push({ source: source.name, searched: hit.searched, rawCount: hit.rawCount, jobs: found, allScanned: all, fromCache: true });
    }
  } catch (e) {
    log(`   cache unavailable (${e.message}) — fetching everything`);
    misses = HB_SOURCES;
  }

  if (!misses.length) {
    log('   Every source already cached — skipping the browser session entirely');
    return results;
  }
  HB_SOURCES = misses;

  const sess = await createHBSession(hbKey);
  log(`   HB session: ${sess.id}`);
  // playwright-core, not playwright: we never launch a browser, we attach to a
  // Hyperbrowser session over CDP, so the bundled browser downloads are dead
  // weight. Resolved against server/ because that is where deps are installed.
  // This was an absolute path into a developer's home directory, so every run
  // on Railway died here before doing any work — no output, no run row, which
  // is why the live view stayed blank and history stayed empty.
  const { createRequire } = require('module');
  const serverRequire = createRequire(path.join(__dirname, 'server', 'package.json'));
  const { chromium } = serverRequire('playwright-core');
  let browser;

  try {
    browser = await chromium.connectOverCDP(sess.wsEndpoint);
    const ctx = browser.contexts()[0] || await browser.newContext();
    const page = await ctx.newPage();

    for (const source of HB_SOURCES) {
      process.stdout.write(`   Browsing ${source.name}...`);
      try {

        // ── API mode (a16z) ────────────────────────────────────────────────
        if (source.apiMode) {
          await page.goto(source.url, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForTimeout(source.waitMs);
          const apiData = await page.evaluate(async ({ endpoint, body }) => {
            const r = await fetch(endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'accept': 'application/json', 'x-csrf-token': document.querySelector('meta[name=csrf-token]')?.content || '' },
              body: JSON.stringify(body),
            });
            const d = await r.json();
            return (d.jobs || []).map(j => ({ role: j.title || '', company: j.companyName || '', url: j.applyUrl || '', location: j.remote ? 'Remote' : (j.location?.name || '') }));
          }, source.apiMode);
          const allApiJobs = apiData.filter(j => j.url?.startsWith('http')).map(j => ({ ...j, fit_score: j.fit_score || 7 }));
          const found = allApiJobs.filter(j => ROLE_RE.test(j.role));
          log(` ${apiData.length} total, ${found.length} matches`);
          results.push({ source: source.name, searched: source.url, rawCount: apiData.length, jobs: found, allScanned: allApiJobs });
          continue;
        }

        // ── Google search mode ─────────────────────────────────────────────
        if (source.googleSearch) {
          await page.goto(`https://www.google.com/search?q=${encodeURIComponent(source.query)}&num=30`, {
            waitUntil: 'domcontentloaded', timeout: 30000,
          });
          await page.waitForTimeout(3000);

          const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 });

          const links = await page.evaluate(() => {
            const out = [];
            document.querySelectorAll('a[href]').forEach(a => {
              const href = a.href;
              if (!href.startsWith('http') || href.includes('google.com') || href.includes('webcache')) return;
              const title = a.querySelector('h3')?.innerText?.trim() || '';
              const snippet = a.closest('[data-sokoban-container]')?.innerText?.trim()
                || a.closest('div')?.innerText?.trim()
                || a.innerText?.trim()
                || '';
              if (href && (title || snippet)) out.push({ href, title, snippet: snippet.replace(/\s+/g, ' ').slice(0, 200) });
            });
            return out.filter(l => l.title || l.snippet).slice(0, 40);
          });

          if (!links.length) {
            log(` (no results — possible CAPTCHA or block)`);
            results.push({ source: source.name, searched: source.query, rawCount: 0, jobs: [] });
            continue;
          }

          const payload = links.map(l => `URL: ${l.href}\nTitle: ${l.title}\nSnippet: ${l.snippet}`).join('\n---\n');
          const data = await callClaude(claudeKey, {
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 2000,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshot.toString('base64') } },
                { type: 'text', text: `Google search results. Extract real job postings matching: ${ROLE_TITLES}

Results:
${payload.slice(0, 6000)}

Return JSON array ONLY — no markdown:
[{"company":"Name","role":"Title","url":"https://...","location":"Remote or city","fit_score":7}]

- Use exact URLs from results
- fit_score 1-10: AI-first company higher; founding/senior mandate higher; remote confirmed higher
- Skip non-matching roles
- Return [] if nothing matches` }
              ],
            }],
          });

          const text = extractText(data);
          let found = [];
          try { const m = text.match(/\[[\s\S]*\]/); if (m) found = JSON.parse(m[0]).filter(j => j.url?.startsWith('http')); } catch {}
          const allScannedLinks = links.map(l => ({ company: '', role: l.title || '(no title)', url: l.href, fit_score: 0, snippet: l.snippet }));
          log(` ${links.length} results, ${found.length} matches`);
          results.push({ source: source.name, searched: source.query, rawCount: links.length, jobs: found, allScanned: allScannedLinks });
          continue;
        }

        // ── Visual scrape (default) ────────────────────────────────────────
        await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(source.waitMs);

        // Scroll to trigger lazy loading
        let prevHeight = 0, stalls = 0;
        while (stalls < 3) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(800);
          const h = await page.evaluate(() => document.body.scrollHeight);
          if (h === prevHeight) stalls++; else stalls = 0;
          prevHeight = h;
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(400);

        const [pageText, domLinks, screenshot] = await Promise.all([
          page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 14000)),
          page.evaluate(() => {
            const seen = new Set();
            const out = [];
            document.querySelectorAll('a[href]').forEach(a => {
              const href = a.href;
              if (!href?.startsWith('http') || seen.has(href)) return;
              seen.add(href);
              out.push({ href, text: (a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120) });
            });
            return out.slice(0, 250);
          }),
          page.screenshot({ type: 'jpeg', quality: 70 }),
        ]);

        if (pageText.trim().length < 300) {
          log(` (page empty or blocked)`);
          results.push({ source: source.name, searched: source.url, rawCount: null, jobs: [] });
          continue;
        }

        const linkList = domLinks.map(l => `${l.text} → ${l.href}`).join('\n').slice(0, 5000);

        const data = await callClaude(claudeKey, {
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: screenshot.toString('base64') } },
              { type: 'text', text: `This is ${source.name} (${source.url}). Extract product/growth job listings.

Page text:
${pageText.slice(0, 6000)}

Links on page:
${linkList}

Target roles: ${ROLE_TITLES}

Return JSON array ONLY — no markdown:
[{"company":"Name","role":"Title","url":"https://...","location":"Remote or city","fit_score":7}]

Rules:
- Pull real application URLs from the links list above
- fit_score 1-10: AI-first = higher; founding/senior mandate = higher; remote confirmed = higher
- Skip engineering, design, legal, finance, sales, ops, recruiting
- Return [] if no matching roles` }
            ],
          }],
        });

        const text = extractText(data);
        let found = [];
        try { const m = text.match(/\[[\s\S]*\]/); if (m) found = JSON.parse(m[0]).filter(j => j.url?.startsWith('http')); } catch {}
        log(` ${found.length} matches`);
        results.push({ source: source.name, searched: source.url, rawCount: null, jobs: found });

      } catch (e) {
        log(` ERROR: ${e.message.slice(0, 100)}`);
        results.push({ source: source.name, searched: source.googleSearch ? source.query : source.url, rawCount: null, jobs: [] });
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await closeHBSession(hbKey, sess.id);
  }

  // Share whatever was actually fetched so the next user this window doesn't
  // pay for a browser session to get the same thing.
  for (const r of results) {
    if (r.fromCache || !r.allScanned?.length) continue;
    const src = HB_SOURCES.find(x => x.name === r.source);
    try {
      await putCachedSource(
        cacheKeyFor(r.source, ROLE_TITLES, !!src?.apiMode),
        r.source,
        src?.apiMode ? '*' : roleKeyFor(ROLE_TITLES),
        { searched: r.searched, rawCount: r.rawCount, allScanned: r.allScanned }
      );
    } catch (e) { log(`   cache write failed for ${r.source}: ${e.message}`); }
  }

  return results;
}

async function main() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

  const key = loadKey();
  if (!key) { log('No Anthropic API key found'); process.exit(1); }

  // Load profile config for this user
  if (SOURCE_USER_EMAIL) {
    const profile = await getProfileByUserEmail(SOURCE_USER_EMAIL);
    if (profile) {
      if (profile.target_roles) {
        ROLE_TITLES = profile.target_roles;
        const parts = ROLE_TITLES.split(',').map(t => t.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()).filter(Boolean);
        ROLE_RE = new RegExp(parts.join('|'), 'i');
      }
      if (profile.location) {
        const city = profile.location.split(',')[0].trim();
        if (city) SOURCE_LOCATION = city;
      }
      if (profile.location_pref) SOURCE_LOCATION_PREF = profile.location_pref;
      log(`Profile loaded for ${SOURCE_USER_EMAIL}: roles="${ROLE_TITLES}" location="${SOURCE_LOCATION}" pref="${SOURCE_LOCATION_PREF}"`);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  log(`\napplyapply sourcing agent — ${today}`);

  const existing = loadJSON(SOURCED_FILE);
  const seenUrls = await getSeenUrls(SOURCE_USER_EMAIL);
  log(`Already tracking ${seenUrls.size} URLs\n`);
  const runId = `${today}-${Date.now()}`;

  // ── PHASE 1: BROWSER SCRAPING ────────────────────────────────────────────────
  step('Phase 1 — Browser scraping (Hyperbrowser + vision)');

  const allCandidates = [];
  const sourceReport = [];
  const jobOutcomes = new Map();
  let hbResultsRaw = [];

  const hbKey = loadHBKey();
  if (!hbKey) { log('   No HYPERBROWSER_API_KEY — skipping browser sources'); }
  else try {
    hbResultsRaw = await runBrowserSources(key, hbKey);
    // Prefetch mode only warms the shared cache — no user, no jobs, no run row.
    if (process.env.JAA_PREFETCH_ONLY === '1') {
      const total = hbResultsRaw.reduce((n, r) => n + (r.allScanned?.length || 0), 0);
      log(`\nPrefetch complete — ${hbResultsRaw.length} sources, ${total} listings cached`);
      return;
    }
    for (const { source: srcName, searched, rawCount, jobs, allScanned } of hbResultsRaw) {
        const dupes = jobs.filter(j => seenUrls.has(j.url));
        const lowFit = jobs.filter(j => !seenUrls.has(j.url) && (j.fit_score || 5) < 6);
        const fresh = jobs.filter(j => !seenUrls.has(j.url) && (j.fit_score || 5) >= 6).map(j => ({ ...j, source: srcName }));
        const existingUrls = new Set(allCandidates.map(j => j.url));
        const net = fresh.filter(j => !existingUrls.has(j.url));
        allCandidates.push(...net);
        sourceReport.push({ source: srcName, searched, rawCount, found: jobs.length, dupes, lowFit, fresh, net });
        // Populate jobOutcomes for role-matched jobs — first-seen source wins
        for (const j of jobs) {
          if (!jobOutcomes.has(j.url)) {
            const isDupe = seenUrls.has(j.url);
            const isLowFit = !isDupe && (j.fit_score || 5) < 6;
            jobOutcomes.set(j.url, {
              company: j.company, role: j.role, url: j.url,
              fit_score: j.fit_score || 5, source: srcName,
              outcome: isDupe ? 'dupe' : isLowFit ? 'low_fit' : 'candidate',
              reason: isDupe ? 'already tracked' : isLowFit ? `fit ${j.fit_score || '<6'}` : '',
            });
          }
        }
        // Track scanned items that were filtered before role-matching
        if (allScanned) {
          for (const j of allScanned) {
            if (j.url && !jobOutcomes.has(j.url)) {
              const isDupe = seenUrls.has(j.url);
              jobOutcomes.set(j.url, {
                company: j.company || '', role: j.role || '', url: j.url,
                fit_score: j.fit_score || 0, source: srcName,
                outcome: isDupe ? 'dupe' : 'role_mismatch',
                reason: isDupe ? 'already tracked' : 'did not match target role titles',
                snippet: j.snippet || '',
              });
            }
          }
        }
      }
      // Mark cross-source dupes (fresh but not in net because another source found them first)
      const allCandidateUrls = new Set(allCandidates.map(j => j.url));
      for (const [url, d] of jobOutcomes) {
        if (d.outcome === 'candidate' && !allCandidateUrls.has(url)) {
          d.outcome = 'cross_dupe';
          d.reason = 'found by another source this run';
        }
      }
  } catch (e) {
    log(`   HB error: ${e.message}`);
  }

  log('');
  sourceReport.forEach(s => {
    step(s.source);
    const searchLabel = s.searched?.length > 110 ? s.searched.slice(0, 110) + '...' : s.searched;
    if (searchLabel) item('~', `Searched: ${searchLabel}`);
    if (s.rawCount != null) item('~', `Scanned: ${s.rawCount} total listings`);
    item('~', `Role matches extracted: ${s.found}`);
    if (!s.found) {
      item('–', 'no matching roles found');
    } else {
      s.net.forEach(j => item('✓', `NEW: ${j.company} — ${j.role} (fit ${j.fit_score || '?'})`));
      s.dupes.forEach(j => item('–', `skip: ${j.company} — ${j.role} [already tracked]`));
      s.lowFit.forEach(j => item('–', `skip: ${j.company} — ${j.role} (fit ${j.fit_score || '<6'}) [below threshold]`));
      const crossDupes = s.fresh.length - s.net.length;
      if (crossDupes > 0) item('–', `skip: ${crossDupes} duplicate${crossDupes > 1 ? 's' : ''} with another source this run`);
    }
  });

  log(`\n   Total unique new candidates: ${allCandidates.length}`);

  // Always save run detail so the audit page has something to show
  const buildRunDetail = (added = 0, exc = 0) => {
    const sources = hbResultsRaw.map(({ source: srcName, searched, rawCount, jobs, allScanned }) => {
      const displayList = (allScanned && allScanned.length > 0) ? allScanned : jobs;
      return {
        name: srcName,
        searched,
        rawCount,
        jobs: displayList.map(j => {
          const d = jobOutcomes.get(j.url);
          return d
            ? { company: d.company || j.company || '', role: d.role || j.role || '', url: d.url || j.url, fit_score: d.fit_score, outcome: d.outcome, reason: d.reason, location: d.location, snippet: d.snippet }
            : { company: j.company || '', role: j.role || '', url: j.url, fit_score: j.fit_score || 0, outcome: 'unknown', reason: '', snippet: j.snippet };
        }),
      };
    });

    // Persist per-source health history
    const healthFile = path.join(LOG_DIR, 'source-health.json');
    let health = [];
    try { health = JSON.parse(fs.readFileSync(healthFile, 'utf-8')); } catch {}
    for (const { source: srcName, rawCount, jobs } of hbResultsRaw) {
      health.push({
        date: today,
        source: srcName,
        scanned: rawCount || 0,
        found: jobs?.length || 0,
        added: (jobs || []).filter(j => jobOutcomes.get(j.url)?.outcome === 'added').length,
      });
    }
    // Keep last 30 per source
    const bySource = {};
    for (const h of health) { (bySource[h.source] = bySource[h.source] || []).push(h); }
    saveJSON(healthFile, Object.values(bySource).flatMap(arr => arr.slice(-30)));

    return { date: today, run_at: new Date().toISOString(), total_added: added, total_excluded: exc, sources };
  };

  if (!allCandidates.length) {
    log('\n   No new candidates found today.');
    saveJSON(path.join(LOG_DIR, 'last-run-detail.json'), buildRunDetail());
    const runLog = loadJSON(path.join(LOG_DIR, 'source-runs.json'));
    runLog.push({ date: today, new_leads: 0, total: existing.length, excluded: 0 });
    saveJSON(path.join(LOG_DIR, 'source-runs.json'), runLog);
    return;
  }

  // ── PHASE 2: URL VALIDATION ──────────────────────────────────────────────────
  step('Phase 2 — Validating URLs');

  const live = [];
  await Promise.all(allCandidates.map(async j => {
    try {
      const r = await fetch(j.url, { method: 'HEAD', signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) { live.push(j); item('✓', `${j.company} — ${j.role}`); }
      else {
        item('✗', `${j.company} (${r.status})`);
        if (jobOutcomes.has(j.url)) { jobOutcomes.get(j.url).outcome = 'url_dead'; jobOutcomes.get(j.url).reason = `HTTP ${r.status}`; }
      }
    } catch {
      item('✗', `${j.company} (unreachable)`);
      if (jobOutcomes.has(j.url)) { jobOutcomes.get(j.url).outcome = 'url_dead'; jobOutcomes.get(j.url).reason = 'unreachable'; }
    }
  }));

  log(`\n   ${live.length} of ${allCandidates.length} URLs live`);

  // ── PHASE 3: LOCATION AUDIT ──────────────────────────────────────────────────
  step('Phase 3 — Auditing locations');

  const remoteConfirmed = [];
  const excluded = [];

  for (const job of live) {
    process.stdout.write(`   Checking ${job.company} — ${job.role}...`);
    const pageText = await fetchPageText(job.url);
    const audit = await auditLocation(key, job, pageText);

    if (audit.verdict === 'remote' || audit.verdict === 'hybrid') {
      item('✓', `${job.company} — ${audit.location_found || audit.verdict}`);
      remoteConfirmed.push({ ...job, location: audit.location_found || job.location });
      if (jobOutcomes.has(job.url)) { jobOutcomes.get(job.url).location = audit.location_found || job.location; }
    } else {
      item('✗', `${job.company} — EXCLUDED (${audit.reason})`);
      excluded.push({ company: job.company, role: job.role, reason: audit.reason });
      if (jobOutcomes.has(job.url)) { jobOutcomes.get(job.url).outcome = 'excluded'; jobOutcomes.get(job.url).reason = audit.reason; }
    }
  }

  log(`\n   Remote confirmed: ${remoteConfirmed.length}  |  Excluded: ${excluded.length}`);
  if (excluded.length) {
    log('\n   Excluded:');
    excluded.forEach(e => item('–', `${e.company}: ${e.reason}`));
  }

  // ── PHASE 4: SAVE ────────────────────────────────────────────────────────────
  step('Phase 4 — Saving results');

  const runStart = Date.now();
  const newJobs = remoteConfirmed.map(j => ({
    id: `${slugify(j.company)}-${slugify(j.role)}-${today}`,
    company: j.company,
    role: j.role,
    url: j.url,
    ats: j.ats || 'other',
    source: j.source || null,
    run_id: runId,
    found_at: today,
    fit_score: j.fit_score || 7,
    tier: j.tier || (j.fit_score >= 9 ? 1 : j.fit_score >= 7 ? 2 : 3),
    location: j.location || 'Remote',
    notes: j.notes || '',
    status: 'new',
  }));

  // Mark added jobs in outcomes
  for (const j of remoteConfirmed) {
    if (jobOutcomes.has(j.url)) { jobOutcomes.get(j.url).outcome = 'added'; }
  }

  // Write to DB
  await insertRun({
    id: runId,
    date: today,
    run_at: new Date().toISOString(),
    sources: hbResultsRaw.length,
    found: allCandidates.length,
    added: newJobs.length,
    excluded: excluded.length,
    duration_ms: Date.now() - runStart,
    user_email: SOURCE_USER_EMAIL,
  });
  for (const j of newJobs) await upsertJob({ ...j, user_email: SOURCE_USER_EMAIL });

  // Keep flat JSON in sync for backward compat
  if (newJobs.length) saveJSON(SOURCED_FILE, [...existing, ...newJobs.map(j => ({ ...j, sourced_date: today }))]);

  if (!newJobs.length) {
    log('\n   No new remote-confirmed leads today.');
  } else {
    log(`\n   Saved ${newJobs.length} new lead${newJobs.length !== 1 ? 's' : ''}:\n`);
    newJobs.forEach(j => {
      log(`   [T${j.tier}] ${j.company} — ${j.role} (${j.fit_score}/10)`);
      log(`         ${j.location}`);
      log(`         ${j.url}`);
    });
  }

  saveJSON(path.join(LOG_DIR, 'last-run-detail.json'), buildRunDetail(newJobs.length, excluded.length));

  const runLog = loadJSON(path.join(LOG_DIR, 'source-runs.json'));
  runLog.push({ date: today, new_leads: newJobs.length, total: seenUrls.size + newJobs.length, excluded: excluded.length });
  saveJSON(path.join(LOG_DIR, 'source-runs.json'), runLog);

  log(`\nTotal pipeline: ${seenUrls.size + newJobs.length} leads tracked\n`);
}

main().catch(e => { log(`\nFatal: ${e.message}`); process.exit(1); });
