let SERVER = 'http://localhost:3747';
let API_KEY = '';
chrome.storage.sync.get(['serverUrl', 'apiKey'], (s) => {
  if (s.serverUrl) SERVER = s.serverUrl;
  if (s.apiKey) API_KEY = s.apiKey;
});

function serverFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (API_KEY) headers['x-api-key'] = API_KEY;
  const opts = { ...options, headers };
  // Try routing through background service worker first (needed for CORS on some pages)
  // Fall back to direct fetch if chrome.runtime is unavailable (e.g. after extension reload)
  if (chrome?.runtime?.sendMessage) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          { type: 'SERVER_FETCH', url: SERVER + path, options: {
              method: opts.method || 'GET',
              headers: opts.headers || {},
              body: opts.body || null,
          }},
          res => {
            if (chrome.runtime.lastError) return directFetch(path, opts).then(resolve).catch(reject);
            if (!res) return reject(new Error('No response from background'));
            resolve(res);
          }
        );
      } catch {
        directFetch(path, opts).then(resolve).catch(reject);
      }
    });
  }
  return directFetch(path, opts);
}

function directFetch(path, options = {}) {
  return fetch(SERVER + path, {
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body || null,
  }).then(async r => {
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { ok: r.ok, status: r.status, data };
  });
}

// Full profile — shown immediately without waiting for generation
const DEFAULTS = {
  first_name: 'Chad',
  last_name: 'Wittman',
  email: 'wittman.c@gmail.com',
  phone: '920-378-6761',
  linkedin: 'https://linkedin.com/in/chadwittman',
  location: 'Austin, TX',
  work_authorization: 'U.S. Citizen, no sponsorship needed',
  salary: '265000',
  current_employer: 'ELDRICK',
  school: 'University of Wisconsin (UWEC)',
  github: 'https://github.com/chadwittman',
  twitter: 'https://x.com/ChadWittman',
  website: 'https://youtu.be/lS140EUgOg4',
};

function mergeProfile(profile) {
  const merged = { ...DEFAULTS };
  if (profile) Object.entries(profile).forEach(([k, v]) => { if (v != null && v !== '') merged[k] = v; });
  return merged;
}

let currentApp = null;
let shadow = null;
let isOpen = false;

function detectATS() {
  if (window.__JAA_ATS) return window.__JAA_ATS;

  const h = location.hostname;
  if (h === 'jobs.ashbyhq.com') return 'ashby';
  if (['job-boards.greenhouse.io', 'jobs.greenhouse.io', 'boards.greenhouse.io'].includes(h)) return 'greenhouse';
  if (h === 'jobs.lever.co') return 'lever';
  if (h === 'instacart.careers') return 'greenhouse';
  if (h === 'stripe.com') return 'stripe';

  const params = new URLSearchParams(location.search);
  if (params.has('gh_jid')) return 'greenhouse';
  if (params.has('ashby_jid')) return 'ashby';
  if (params.has('lever_job_id')) return 'lever';

  const html = document.documentElement.innerHTML;
  if (/ashby/i.test(html) && (/ashbyhq\.com/i.test(html) || document.querySelector('[data-ashby]'))) return 'ashby';
  if (document.getElementById('grnhse_app') || /greenhouse\.io\/embed/i.test(html)) return 'greenhouse';
  if (/lever\.co\/jobs-embed/i.test(html) || document.querySelector('iframe[src*="lever.co"]')) return 'lever';

  const text = document.body?.innerText || '';
  const looksLikeApp = /apply\s+now|submit\s+application|upload\s+resume|cover\s+letter/i.test(text);
  if (looksLikeApp) return 'generic';

  return null;
}

// Reads the Ashby left-panel metadata (h2 label → p value pairs)
function getAshbyMeta(label) {
  for (const h2 of document.querySelectorAll('h2')) {
    if (h2.textContent.trim() === label) {
      return h2.nextElementSibling?.textContent?.trim() || null;
    }
  }
  return null;
}

function detectLocationType() {
  return getAshbyMeta('Location Type'); // 'Remote' | 'On-site' | 'Hybrid' | null
}

function isApplicationPage() {
  const ats = detectATS();
  if (!ats) return false;
  if (ats === 'generic') return true;
  if (/\/(apply|application)(\/|$)/i.test(location.pathname)) return true;
  if (ats === 'greenhouse') return true;
  return false;
}

// ── Loading bar ─────────────────────────────────────────────────────────────
function startLoadingBar() {
  const bar = document.createElement('div');
  bar.id = 'jaa-bar';
  bar.style.cssText = 'position:fixed;top:0;left:0;height:3px;width:8%;background:#0a0a0a;z-index:2147483647;transition:width .5s ease;pointer-events:none;';
  document.body.appendChild(bar);
  return bar;
}
function progressBar(bar, pct) { if (bar) bar.style.width = pct + '%'; }
function finishBar(bar) {
  if (!bar) return;
  bar.style.width = '100%';
  setTimeout(() => { bar.style.opacity = '0'; bar.style.transition = 'width .5s,opacity .4s'; setTimeout(() => bar.remove(), 400); }, 350);
}

const IN_FRAME = window.self !== window.top;

async function init() {
  if (!detectATS()) return;

  // In an iframe: skip sidebar, just fill fields + report form questions to parent
  if (IN_FRAME) {
    try {
      const url = window.top?.location?.href || location.href;
      const res = await serverFetch(`/application?url=${encodeURIComponent(url)}`);
      if (res.ok) currentApp = res.data;
    } catch {}
    setTimeout(() => {
      if (currentApp) deterministicFill(currentApp);
      injectCopyButtons();
    }, 1800);
    // Report actual form questions to background so the parent frame can use them
    setTimeout(() => {
      const skipBasic = /^(name|email|phone|mobile|linkedin|github|twitter|website|portfolio|location|city|salary|resume|cover\s*letter|first\s*(name)?|last\s*(name)?|url|upload|pronoun|referral|source|how did you hear)/i;
      const questions = scanPageFields()
        .filter(f => f.label.includes('?') || (f.label.length > 20 && !skipBasic.test(f.label.trim())))
        .map(f => f.label);
      if (questions.length && chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'STORE_IFRAME_QUESTIONS', questions });
      }
    }, 2500);
    observeFields();
    return;
  }

  const bar = startLoadingBar();
  let serverDown = false;
  try {
    progressBar(bar, 35);
    // Check for a previously generated application for this URL
    const res = await serverFetch(`/application?url=${encodeURIComponent(location.href)}`);
    if (res.ok) currentApp = res.data;
    progressBar(bar, 65);
  } catch { serverDown = true; progressBar(bar, 65); }

  injectWidget(serverDown);
  injectCopyButtons();
  observeFields();

  if (isApplicationPage() && currentApp) {
    const fillDelay = detectATS() === 'greenhouse' ? 3500 : 1800;
    setTimeout(async () => {
      deterministicFill(currentApp);
      progressBar(bar, 85);
      try { await aiFill(currentApp); } catch {}
      finishBar(bar);
    }, fillDelay);
  } else {
    finishBar(bar);
  }
}

function buildLocBadge(locType) {
  const jobText = (document.body?.innerText || '').slice(0, 3000).toLowerCase();
  const isAustin = /austin/.test(jobText);
  const isOnsite = /on.?site/i.test(locType);
  const warn = isOnsite && !isAustin;
  const color = locType === 'Remote' ? '#16a34a' : locType === 'Hybrid' ? '#2563eb' : warn ? '#dc2626' : '#92400e';
  const label = warn ? `${locType} (not Austin)` : locType;
  return `<span style="display:inline-block;padding:1px 6px;border-radius:3px;font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;background:${color}22;color:${color};margin-top:5px;">${label}</span>`;
}

// ── Widget ──────────────────────────────────────────────────────────────────

function setBodyPush(open) {
  document.body.style.transition = 'margin-right .28s cubic-bezier(.4,0,.2,1)';
  document.body.style.marginRight = open ? '360px' : '28px';
}

function injectWidget(serverDown = false) {
  if (document.getElementById('jaa-root')) return;
  const host = document.createElement('div');
  host.id = 'jaa-root';
  host.style.cssText = 'all:initial;position:fixed;top:0;right:0;bottom:0;z-index:2147483647;width:400px;pointer-events:none;overflow:visible;';
  document.body.appendChild(host);
  shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = buildHTML(serverDown);
  setBodyPush(isOpen);
  bindEvents();
}

function buildHTML(serverDown) {
  const a = currentApp;
  const locType = detectLocationType();
  const locBadge = locType ? buildLocBadge(locType) : '';
  return `
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}

.sidebar{
  position:absolute;top:0;right:0;bottom:0;width:360px;
  transform:translateX(332px);
  transition:transform .28s cubic-bezier(.4,0,.2,1);
  background:#fff;border-left:1px solid #ddd;
  box-shadow:-6px 0 40px rgba(0,0,0,.1);
  display:flex;flex-direction:column;pointer-events:auto;
}
.sidebar.open{transform:translateX(0);}

.tab{
  position:absolute;left:-28px;top:50%;
  transform:translateY(-50%);
  width:28px;height:110px;
  background:#0a0a0a;border:none;cursor:pointer;
  border-radius:4px 0 0 4px;
  display:flex;align-items:center;justify-content:center;
  pointer-events:auto;
}
.tab-lbl{
  writing-mode:vertical-lr;transform:rotate(180deg);
  color:#fff;font-size:9px;font-weight:700;
  letter-spacing:.14em;text-transform:uppercase;
}

.sh{
  padding:14px 16px 12px;background:#0a0a0a;flex-shrink:0;
  display:flex;align-items:flex-start;gap:10px;
}
.sh-info{flex:1;min-width:0;}
.sh-eyebrow{font-size:9px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#444;margin-bottom:8px;}
.sh-company{font-size:17px;font-weight:700;color:#fff;letter-spacing:-.02em;line-height:1.1;margin-bottom:3px;}
.sh-role{font-size:11px;color:#777;line-height:1.4;}
.sh-meta{font-size:10px;color:#555;margin-top:5px;}
.x-btn{background:none;border:none;color:#444;cursor:pointer;font-size:20px;line-height:1;padding:0;flex-shrink:0;margin-top:-2px;}
.x-btn:hover{color:#aaa;}

.act{padding:11px 14px;border-bottom:1px solid #ebebeb;flex-shrink:0;}
.act-row{display:flex;gap:6px;}
.fill-btn{
  flex:1;padding:9px;background:#0a0a0a;color:#fff;border:none;
  font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  cursor:pointer;font-family:inherit;
}
.fill-btn:hover{background:#222;}
.fill-btn:disabled{background:#ccc;cursor:not-allowed;}
.fill-note{font-size:10px;color:#9a9a9a;margin-top:6px;min-height:14px;}

.body{flex:1;overflow-y:auto;}

.sec{border-bottom:1px solid #ebebeb;}
.sec-hd{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;cursor:pointer;}
.sec-label{font-size:9px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#9a9a9a;}
.sec-actions{display:flex;align-items:center;gap:8px;}
.copy-btn{font-size:10px;color:#9a9a9a;background:none;border:none;cursor:pointer;padding:0;font-family:inherit;transition:color .15s;}
.copy-btn:hover{color:#0a0a0a;}
.copy-btn.ok{color:#0a0a0a;}
.chev{font-size:10px;color:#ccc;transition:transform .2s;}
.sec.collapsed .sec-body{display:none;}
.sec.collapsed .chev{transform:rotate(-90deg);}
.sec-body{padding:0 14px 12px;}

.field{display:flex;gap:10px;padding:4px 0;border-bottom:1px solid #f3f3f3;cursor:pointer;border-radius:4px;transition:background .12s;}
.field:last-child{border-bottom:none;}
.field:hover{background:#f5f5f5;}
.field:hover .field-copy{opacity:1;}
.field-lbl{font-size:10px;color:#bbb;width:64px;flex-shrink:0;padding-top:2px;}
.field-val{font-size:12px;color:#0a0a0a;flex:1;word-break:break-all;line-height:1.5;}
.field-copy{font-size:9px;color:#bbb;flex-shrink:0;opacity:0;transition:opacity .12s;padding-top:3px;user-select:none;}

.prose{font-size:12px;line-height:1.7;color:#0a0a0a;white-space:pre-wrap;}

.qa{margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #f3f3f3;}
.qa:last-child{border-bottom:none;margin-bottom:0;padding-bottom:0;}
.qa-q{font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#9a9a9a;margin-bottom:4px;}
.qa-a{font-size:11px;color:#0a0a0a;line-height:1.6;margin-bottom:6px;}
.qa-actions{display:flex;align-items:center;gap:6px;}
.qa-mic{background:#0a0a0a;color:#fff;border:none;border-radius:50%;width:22px;height:22px;font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}

.cl-btn{
  padding:9px 12px;
  background:none;color:#9a9a9a;border:1px solid #e8e8e8;
  font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  cursor:pointer;font-family:inherit;text-align:center;transition:all .15s;white-space:nowrap;
}
.cl-btn:hover{color:#0a0a0a;border-color:#ccc;}
.cl-btn:disabled{color:#ccc;cursor:not-allowed;}
.cl-out{padding:14px;border-bottom:1px solid #ebebeb;font-size:11px;line-height:1.7;color:#0a0a0a;white-space:pre-wrap;background:#fafafa;transition:background .12s;}
.cl-out:hover{background:#f0f0f0;}

.gen-wrap{padding:16px 14px;border-bottom:1px solid #ebebeb;}
.gen-btn{
  width:100%;padding:10px;background:#0a0a0a;color:#fff;border:none;
  font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  cursor:pointer;font-family:inherit;
}
.gen-btn:hover{background:#222;}
.gen-btn:disabled{background:#ccc;cursor:not-allowed;}
.gen-status{font-size:10px;color:#9a9a9a;margin-top:8px;min-height:14px;}

.job-link{display:block;padding:12px 14px;font-size:11px;color:#9a9a9a;text-decoration:none;border-top:1px solid #ebebeb;}
.job-link:hover{color:#0a0a0a;}
</style>

<div class="sidebar" id="jaa-sidebar">
  <button class="tab" id="jaa-tab"><span class="tab-lbl">APPLYAPPLY</span></button>
  <div class="sh">
    <div class="sh-info">
      <div class="sh-eyebrow">applyapply</div>
      <div class="sh-company">${a ? a.company : (serverDown ? 'Server offline' : 'Ready')}</div>
      <div class="sh-role">${a ? a.role : (serverDown ? 'npm start in ~/job-search/server' : 'Generate application below')}</div>
      ${a ? `<div class="sh-meta">Tier ${a.tier} &nbsp;·&nbsp; ${a.fit_score}/10</div>` : ''}
      ${locBadge}
    </div>
    <button class="x-btn" id="jaa-close">×</button>
  </div>
  ${a ? `<div class="act">
    <div class="act-row">
      <button class="fill-btn" id="jaa-fill">Fill form</button>
      <button class="cl-btn" id="jaa-gen-cl">Cover letter</button>
      <button class="cl-btn" id="jaa-regen" title="Regenerate application from scratch">↺</button>
    </div>
    <div class="fill-note" id="jaa-note"></div>
  </div>` : ''}
  <div class="body">
    <div id="jaa-cl-out"></div>
    ${a ? appHTML(a) : noAppBody()}
  </div>
</div>`;
}

function appHTML(a) {
  const p = mergeProfile(a.profile);
  const t = a.tailored;

  const rows = [
    ['Name', `${p.first_name} ${p.last_name}`],
    ['Email', p.email],
    ['Phone', p.phone],
    ['LinkedIn', p.linkedin],
    ['GitHub', p.github],
    ['Twitter', p.twitter],
    ['Website', p.website],
    ['Location', p.location],
    ['Employer', p.current_employer],
    ['School', p.school],
    ['Work auth', p.work_authorization],
    p.salary ? ['Salary', `$${Number(p.salary).toLocaleString()}`] : null,
  ].filter(Boolean);

  return `
<div class="sec">
  <div class="sec-hd" data-sec="profile"><span class="sec-label">Profile</span><span class="chev">▾</span></div>
  <div class="sec-body">${rows.map(([l, v]) => `<div class="field" data-copy="${v}"><span class="field-lbl">${l}</span><span class="field-val">${v}</span><span class="field-copy">copy</span></div>`).join('')}</div>
</div>

<div class="sec">
  <div class="sec-hd" data-sec="why">
    <span class="sec-label">Why this role</span>
    <div class="sec-actions"><button class="copy-btn" data-key="why_role" title="Copy · ⌥↩ when field focused">Copy</button><span class="chev">▾</span></div>
  </div>
  <div class="sec-body"><div class="prose">${t.why_role}</div></div>
</div>

<div class="sec">
  <div class="sec-hd" data-sec="cover">
    <span class="sec-label">Cover note</span>
    <div class="sec-actions"><button class="copy-btn" data-key="cover_note" title="Copy · ⌥↩ when field focused">Copy</button><span class="chev">▾</span></div>
  </div>
  <div class="sec-body">
    <div class="prose">${t.cover_note}</div>
  </div>
</div>

${t.headline ? `<div class="sec">
  <div class="sec-hd" data-sec="hl">
    <span class="sec-label">Headline</span>
    <div class="sec-actions"><button class="copy-btn" data-key="headline" title="Copy · ⌥↩ when field focused">Copy</button><span class="chev">▾</span></div>
  </div>
  <div class="sec-body"><div class="prose">${t.headline}</div></div>
</div>` : ''}

${t.qa?.length ? `<div class="sec">
  <div class="sec-hd" data-sec="qa"><span class="sec-label">Q & A</span><span class="chev">▾</span></div>
  <div class="sec-body">
    ${t.qa.map((item, i) => `<div class="qa">
      <div class="qa-q">${item.q}</div>
      <div class="qa-a" id="jaa-qa-a-${i}">${item.a}</div>
      <div class="qa-actions">
        <button class="copy-btn" data-qa-copy="${i}" title="Copy · ⌥↩ when field focused">Copy</button>
        <button class="qa-mic" data-qa-idx="${i}" data-qa-q="${encodeURIComponent(item.q)}" title="Record your answer">🎤</button>
      </div>
    </div>`).join('')}
  </div>
</div>` : ''}

${a.warm_path ? `<div class="sec">
  <div class="sec-hd" data-sec="warm"><span class="sec-label">Warm path</span><span class="chev">▾</span></div>
  <div class="sec-body"><div class="prose" style="font-size:11px;color:#6b6b6b;">${a.warm_path}</div></div>
</div>` : ''}

<a class="job-link" href="${a.url}" target="_blank">Open job posting ↗</a>

${quickCopySection(a)}`;
}

function noAppBody() {
  const p = DEFAULTS;
  const locType = detectLocationType();
  const locBadgeHTML = locType ? `<div style="margin-bottom:10px;">${buildLocBadge(locType)}</div>` : '';
  const rows = [
    ['Name', `${p.first_name} ${p.last_name}`],
    ['Email', p.email],
    ['Phone', p.phone],
    ['LinkedIn', p.linkedin],
    ['GitHub', p.github],
    ['Twitter', p.twitter],
    ['Website', p.website],
    ['Location', p.location],
    ['Employer', p.current_employer],
    ['School', p.school],
    ['Work auth', p.work_authorization],
    ['Salary', `$${Number(p.salary).toLocaleString()}`],
  ];

  return `
<div class="sec">
  <div class="sec-hd" data-sec="profile"><span class="sec-label">Profile</span><span class="chev">▾</span></div>
  <div class="sec-body">${rows.map(([l, v]) => `<div class="field" data-copy="${v}"><span class="field-lbl">${l}</span><span class="field-val">${v}</span><span class="field-copy">copy</span></div>`).join('')}</div>
</div>
<div class="gen-wrap">
  ${locBadgeHTML}<button id="jaa-generate" class="gen-btn">Generate application</button>
  <div id="jaa-gen-status" class="gen-status"></div>
</div>`;
}

function quickCopySection(a) {
  const p = mergeProfile(a.profile);
  const t = a.tailored;

  const fields = [
    ['First name', p.first_name],
    ['Last name', p.last_name],
    ['Full name', `${p.first_name} ${p.last_name}`],
    ['Email', p.email],
    ['Phone', p.phone],
    ['LinkedIn', p.linkedin],
    ['GitHub', p.github],
    ['Twitter', p.twitter],
    ['Website', p.website],
    ['Location', p.location],
    ['Employer', p.current_employer],
    ['School', p.school],
    ['Work auth', p.work_authorization],
    p.salary ? ['Salary', `$${Number(p.salary).toLocaleString()}`] : null,
    ['Why this role', t.why_role],
    ['Cover note', t.cover_note],
    t.headline ? ['Headline', t.headline] : null,
    ...(t.qa || []).map((item, i) => [`Q${i + 1}: ${item.q}`, item.a]),
  ].filter(Boolean);

  return `<div class="sec collapsed">
  <div class="sec-hd" data-sec="quickcopy"><span class="sec-label">Quick copy</span><span class="chev">▾</span></div>
  <div class="sec-body" style="padding-bottom:14px;">
    ${fields.map(([label, value]) => `
    <div class="field" style="align-items:flex-start;padding:6px 0;">
      <span class="field-lbl" style="padding-top:2px;">${label}</span>
      <span class="field-val" style="font-size:11px;line-height:1.5;flex:1;color:#444;white-space:pre-wrap;">${value.length > 60 ? value.slice(0, 60) + '…' : value}</span>
      <button class="copy-btn" data-text="${encodeURIComponent(value)}" title="Copy · ⌥↩ when field focused" style="flex-shrink:0;margin-left:6px;margin-top:2px;">Copy</button>
    </div>`).join('')}
  </div>
</div>`;
}

// ── Events ──────────────────────────────────────────────────────────────────

function bindEvents() {
  const sidebar = shadow.getElementById('jaa-sidebar');
  const tab = shadow.getElementById('jaa-tab');
  const closeBtn = shadow.getElementById('jaa-close');

  tab.addEventListener('click', () => { isOpen = !isOpen; sidebar.classList.toggle('open', isOpen); setBodyPush(isOpen); });
  closeBtn?.addEventListener('click', () => { isOpen = false; sidebar.classList.remove('open'); setBodyPush(false); });

  const fillBtn = shadow.getElementById('jaa-fill');
  const note = shadow.getElementById('jaa-note');
  if (fillBtn) {
    fillBtn.addEventListener('click', async () => {
      fillBtn.disabled = true;
      fillBtn.textContent = 'Filling…';
      if (note) note.textContent = '';
      let result;
      try {
        result = await aiFill(currentApp);
      } catch {
        try { result = deterministicFill(currentApp); } catch { result = { filled: 0, skipped: 0 }; }
      }
      fillBtn.textContent = 'Re-fill';
      fillBtn.disabled = false;
      injectCopyButtons();
      if (note) note.textContent = result?.filled > 0
        ? `${result.filled} filled · ${result.skipped} manual`
        : 'Nothing matched — try re-fill';
    });
  }

  const genBtn = shadow.getElementById('jaa-generate');
  if (genBtn) genBtn.addEventListener('click', () => generateApp(genBtn));

  const regenBtn = shadow.getElementById('jaa-regen');
  if (regenBtn) {
    regenBtn.addEventListener('click', async () => {
      regenBtn.disabled = true;
      regenBtn.textContent = '…';
      const note = shadow.getElementById('jaa-note');
      if (note) note.textContent = 'Regenerating…';
      await fetchIframeQuestions();
      try {
        const details = scrapeJobDetails();
        const res = await serverFetch('/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...details, force: true }),
        });
        if (!res.ok) throw new Error('failed');
        currentApp = res.data;
        document.getElementById('jaa-root')?.remove();
        shadow = null;
        injectWidget(false);
        injectCopyButtons();
        const sidebar = shadow?.getElementById('jaa-sidebar');
        if (sidebar) { isOpen = true; sidebar.classList.add('open'); }
      } catch (e) {
        regenBtn.disabled = false;
        regenBtn.textContent = '↺';
        if (note) note.textContent = 'Regenerate failed — try again';
      }
    });
  }

  shadow.querySelectorAll('.sec-hd').forEach(hd => {
    hd.addEventListener('click', e => {
      if (e.target.classList.contains('copy-btn')) return;
      hd.closest('.sec').classList.toggle('collapsed');
    });
  });

  shadow.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      let text = '';
      if (btn.dataset.qaCopy != null) {
        text = currentApp?.tailored?.qa?.[parseInt(btn.dataset.qaCopy)]?.a || '';
      } else if (btn.dataset.text) {
        text = decodeURIComponent(btn.dataset.text);
      } else {
        text = currentApp?.tailored[btn.dataset.key] || '';
      }
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        const orig = btn.textContent;
        btn.classList.add('ok');
        btn.textContent = 'Copied';
        setTimeout(() => { btn.classList.remove('ok'); btn.textContent = orig; }, 2000);
      });
    });
  });

  shadow.querySelectorAll('.qa-mic').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.qaIdx);
      const question = decodeURIComponent(btn.dataset.qaQ || '');

      // Stop if already recording this button
      if (voiceQaMicBtn === btn) {
        voiceQaSR?.stop();
        btn.textContent = '⏳';
        return;
      }
      // Stop any other active QA recording
      if (voiceQaMicBtn) { voiceQaSR?.stop(); voiceQaMicBtn.textContent = '🎤'; }
      voiceQaSR = null;

      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { btn.title = 'Speech not supported in this browser'; return; }

      voiceQaMicBtn = btn;
      voiceQaMicIdx = idx;
      btn.textContent = '⏳';

      const sr = new SR();
      voiceQaSR = sr;
      sr.continuous = true;
      sr.interimResults = false;
      sr.lang = 'en-US';

      sr.onstart = () => { btn.textContent = '⏹'; };

      sr.onresult = (ev) => {
        const raw = [...ev.results].map(r => r[0].transcript).join(' ').trim();
        if (!raw) return;
        btn.textContent = '⏳';
        voiceQaMicBtn = null; voiceQaMicIdx = -1; voiceQaSR = null;

        const applyAnswer = (text) => {
          const answerEl = shadow?.getElementById(`jaa-qa-a-${idx}`);
          if (answerEl) answerEl.textContent = text;
          if (currentApp?.tailored?.qa?.[idx]) currentApp.tailored.qa[idx].a = text;
          const field = findByLabel(question);
          if (field) setVal(field, text);
          btn.textContent = '✓';
          setTimeout(() => { btn.textContent = '🎤'; }, 2000);
        };

        // Direct fetch to localhost — bypasses chrome.runtime entirely
        fetch('http://localhost:3747/voice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transcript: raw, question, appId: currentApp?.id }),
        })
          .then(r => r.ok ? r.json() : null)
          .then(data => applyAnswer(data?.text || raw))
          .catch(() => applyAnswer(raw));
      };

      sr.onerror = (ev) => {
        if (ev.error === 'not-allowed') { btn.textContent = '🔒'; btn.title = 'Mic permission denied — allow mic for this site'; }
        else btn.textContent = '🎤';
        voiceQaMicBtn = null; voiceQaMicIdx = -1; voiceQaSR = null;
      };

      sr.onend = () => {
        if (voiceQaMicBtn === btn) { btn.textContent = '🎤'; voiceQaMicBtn = null; voiceQaMicIdx = -1; }
        voiceQaSR = null;
      };

      sr.start();
    });
  });

  shadow.querySelectorAll('.field[data-copy]').forEach(field => {
    field.addEventListener('click', () => {
      const text = field.dataset.copy;
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        const hint = field.querySelector('.field-copy');
        if (hint) { hint.textContent = '✓'; hint.style.color = '#16a34a'; hint.style.opacity = '1'; }
        setTimeout(() => { if (hint) { hint.textContent = 'copy'; hint.style.color = ''; hint.style.opacity = ''; } }, 1500);
      });
    });
  });

  const genClBtn = shadow.getElementById('jaa-gen-cl');
  const clOut = shadow.getElementById('jaa-cl-out');
  if (genClBtn && clOut) {
    genClBtn.addEventListener('click', async () => {
      genClBtn.textContent = 'Generating…';
      genClBtn.disabled = true;
      try {
        const res = await serverFetch('/cover-letter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId: currentApp.id }),
        });
        if (!res.ok) throw new Error('failed');
        const text = res.data.text;
        clOut.innerHTML = '';
        const prose = document.createElement('div');
        prose.className = 'cl-out';
        prose.title = 'Click to copy';
        prose.style.cursor = 'pointer';
        prose.textContent = text;
        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:9px;color:#bbb;padding:4px 14px 10px;letter-spacing:.06em;text-transform:uppercase;';
        hint.textContent = 'click to copy';
        prose.addEventListener('click', () => {
          navigator.clipboard.writeText(text).then(() => {
            hint.textContent = '✓ copied';
            hint.style.color = '#16a34a';
            setTimeout(() => { hint.textContent = 'click to copy'; hint.style.color = '#bbb'; }, 2000);
          });
        });
        clOut.appendChild(prose);
        clOut.appendChild(hint);
        clOut.scrollIntoView({ behavior: 'smooth', block: 'start' });
        genClBtn.textContent = 'Regenerate';
        genClBtn.disabled = false;
      } catch {
        clOut.textContent = 'Error — try again';
        genClBtn.textContent = 'Generate cover letter';
        genClBtn.disabled = false;
      }
    });
  }
}

// ── AI fill ─────────────────────────────────────────────────────────────────

function captureScreenshot() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }, res => {
      if (chrome.runtime.lastError || !res?.ok) reject(new Error(res?.error || 'capture failed'));
      else resolve(res.dataUrl);
    });
  });
}

async function aiFill(app) {
  const fields = scanPageFields();

  // Capture the form visually so Claude can see what's actually rendered
  let screenshot = null;
  try { screenshot = await captureScreenshot(); } catch {}

  const body = { appId: app.id, fields };
  if (screenshot) body.screenshot = screenshot;

  const res = await serverFetch('/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('analyze failed');
  const { mappings } = res.data;

  let filled = 0, skipped = 0;
  for (const m of mappings) {
    if (!m.value) { skipped++; continue; }
    if (m.type === 'radio') {
      clickRadioByGroupLabel(m.label, m.value) ? filled++ : skipped++;
    } else {
      const el = findByLabel(m.label);
      if (el) { setVal(el, m.value); filled++; } else skipped++;
    }
  }
  highlightResumeField();
  return { filled, skipped };
}

// ── Deterministic fill ───────────────────────────────────────────────────────

function deterministicFill(app) {
  const p = mergeProfile(app.profile);
  const t = app.tailored;
  let filled = 0, skipped = 0;

  const rules = [
    { test: l => /legal.*(first.*last|name)/.test(l) || (l.includes('first') && l.includes('last')), value: `${p.first_name} ${p.last_name}` },
    { test: l => /preferred.*first/.test(l), value: p.first_name },
    { test: l => /preferred.*last/.test(l), value: p.last_name },
    { test: l => /^first\s*(name)?$/.test(l), value: p.first_name },
    { test: l => /^last\s*(name)?$/.test(l), value: p.last_name },
    { test: l => /email/.test(l), value: p.email },
    { test: l => /phone|mobile/.test(l), value: p.phone },
    { test: l => /linkedin/.test(l), value: p.linkedin },
    { test: l => /^(location|city|where)/.test(l), value: p.location },
    { test: l => /current.*employer|most recent.*employer|employer/.test(l), value: p.current_employer },
    { test: l => /university|school|college/.test(l), value: p.school },
    { test: l => /github/.test(l), value: p.github || '' },
    { test: l => /twitter|x\.com|@/.test(l), value: p.twitter || '' },
    { test: l => /portfolio|work\s*sample|sample\s*work|show\s*your\s*work/.test(l), value: p.website || '' },
    { test: l => /website|personal\s*site|project\s*site|online\s*presence|portfolio\s*url|personal\s*url/.test(l), value: p.website || '' },
    { test: l => /salary|compensation/.test(l), value: p.salary || '' },
    { test: l => /cover letter|additional info|tell us|message/.test(l), value: t.cover_note || '', textarea: true },
    { test: l => /how did you hear|how did you find|referred by|referral source|where did you (hear|learn)|source of (hire|application)/.test(l), value: 'LinkedIn' },
  ];

  for (const rule of rules) {
    if (!rule.value) continue;
    const el = findFieldByRule(rule);
    if (el) { setVal(el, rule.value); filled++; } else skipped++;
  }

  if (clickRadioByPattern(/authorized to work|legally authorized/, 'yes')) filled++; else skipped++;
  if (clickRadioByPattern(/sponsorship|visa/, 'no')) filled++; else skipped++;

  // Select dropdowns — phone country code and country fields
  for (const sel of document.querySelectorAll('select')) {
    const attr = (sel.getAttribute('aria-label') || sel.id || sel.name || sel.getAttribute('data-qa') || '').toLowerCase().replace(/[-_]/g, ' ');
    const labelEl = sel.id ? document.querySelector(`label[for="${CSS.escape(sel.id)}"]`) : null;
    const labelTxt = (labelEl?.textContent || '').toLowerCase().replace(/\*/g, '').trim();
    const combined = attr + ' ' + labelTxt;

    // Phone country code — prefer "+1" (US dial code) over "United States"
    if (/phone.*country|country.*code|dial.*code|calling.*code|phone.*prefix/.test(combined)) {
      const plusOne = [...sel.options].find(o => o.text.trim() === '+1' || o.value === '+1' || o.value === '1');
      if (plusOne && sel.value !== plusOne.value) {
        sel.value = plusOne.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        filled++;
      }
      continue;
    }

    // Country of residence / location country — prefer United States
    if (/^country$|country.*residence|country.*address|country.*location/.test(combined) && !/phone|code|dial/.test(combined)) {
      const us = [...sel.options].find(o =>
        /^united states$/i.test(o.text.trim()) || o.value === 'US' || o.value === 'USA' || o.value === 'United States'
      );
      if (us && !sel.value) {
        sel.value = us.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        filled++;
      }
      continue;
    }
  }

  // QA pass — match any unfilled textarea to app QA answers by word overlap
  if (t.qa?.length) {
    for (const ta of document.querySelectorAll('textarea')) {
      if (ta.value?.trim()) continue;
      const label = getLabelForTextarea(ta);
      if (!label) continue;
      const words = label.toLowerCase().split(/\W+/).filter(w => w.length > 3);
      const best = t.qa
        .map(item => {
          const hay = (item.q + ' ' + item.a).toLowerCase();
          return { ...item, score: words.filter(w => hay.includes(w)).length };
        })
        .filter(item => item.score >= 2)
        .sort((a, b) => b.score - a.score)[0];
      if (best) { setVal(ta, best.a); filled++; }
    }
  }

  highlightResumeField();
  return { filled, skipped };
}

function findFieldByRule({ test, textarea }) {
  for (const label of document.querySelectorAll('label')) {
    const txt = label.textContent.toLowerCase().replace(/\*/g, '').trim();
    if (test(txt)) {
      const forId = label.getAttribute('for');
      const el = (forId && document.getElementById(forId))
        || label.querySelector(textarea ? 'textarea' : 'input,textarea')
        || label.nextElementSibling?.querySelector?.('input,textarea')
        || label.parentElement?.querySelector('input,textarea');
      if (el) return el;
    }
  }
  for (const el of document.querySelectorAll('input,textarea')) {
    const attr = (el.name || el.id || el.placeholder || '').toLowerCase().replace(/[-_]/g, ' ');
    if (test(attr)) return el;
  }
  return null;
}

// ── Radio helpers ────────────────────────────────────────────────────────────

function clickRadioByGroupLabel(labelText, optionValue) {
  const escaped = labelText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return clickRadioByPattern(new RegExp(escaped, 'i'), optionValue);
}

function clickRadioByPattern(pattern, desiredValue) {
  for (const [groupLabel, radios] of buildRadioGroups()) {
    if (!pattern.test(groupLabel)) continue;
    for (const radio of radios) {
      if (getRadioOptionText(radio).toLowerCase().includes(desiredValue.toLowerCase())) {
        fireRadioClick(radio);
        return true;
      }
    }
  }
  return false;
}

function buildRadioGroups() {
  const groups = new Map();

  for (const group of document.querySelectorAll('[role="radiogroup"]')) {
    const labelId = group.getAttribute('aria-labelledby');
    const labelEl = labelId ? document.getElementById(labelId) : null;
    const text = (labelEl?.textContent || group.getAttribute('aria-label') || getAdjacentLabel(group) || '').trim();
    if (text) {
      const radios = [...group.querySelectorAll('input[type="radio"]')];
      if (radios.length) groups.set(text, radios);
    }
  }

  const byName = new Map();
  for (const r of document.querySelectorAll('input[type="radio"]')) {
    const name = r.name || '';
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(r);
  }
  for (const [, radios] of byName) {
    const text = getRadioGroupLabel(radios[0]);
    if (text && !groups.has(text)) groups.set(text, radios);
  }

  return groups;
}

function getRadioGroupLabel(radio) {
  let el = radio.parentElement;
  for (let i = 0; i < 6; i++) {
    if (!el) break;
    const prev = el.previousElementSibling;
    if (prev) { const t = prev.textContent.trim(); if (t.length > 10) return t; }
    const parent = el.parentElement;
    if (parent) {
      for (const child of parent.children) {
        if (child === el) break;
        const t = child.textContent.trim();
        if (t.length > 10 && !child.querySelector('input')) return t;
      }
    }
    el = parent;
  }
  return '';
}

function getAdjacentLabel(el) {
  const prev = el.previousElementSibling;
  if (prev) return prev.textContent.trim();
  const parent = el.parentElement;
  if (parent) for (const child of parent.children) {
    if (child === el) break;
    const t = child.textContent.trim();
    if (t.length > 5) return t;
  }
  return '';
}

function getRadioOptionText(radio) {
  if (radio.id) {
    const label = document.querySelector(`label[for="${radio.id}"]`);
    if (label) return label.textContent.trim();
  }
  const parent = radio.closest('label');
  if (parent) return parent.textContent.trim();
  return radio.nextElementSibling?.textContent.trim() || radio.value || '';
}

function fireRadioClick(radio) {
  radio.checked = true;
  radio.click();
  radio.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  radio.dispatchEvent(new Event('change', { bubbles: true }));
  radio.dispatchEvent(new Event('input', { bubbles: true }));
}

// ── Page scanner + helpers ───────────────────────────────────────────────────

function scanPageFields() {
  const fields = [];
  const seen = new Set();

  function push(text, input) {
    const t = text.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
    if (!t || seen.has(t) || t.length > 300) return;
    seen.add(t);
    fields.push({ label: t, type: input.type || input.tagName.toLowerCase(), name: input.name || input.id || '' });
  }

  for (const label of document.querySelectorAll('label')) {
    const forId = label.getAttribute('for');
    const input = (forId && document.getElementById(forId)) || label.querySelector('input,textarea,select');
    if (input) push(label.textContent, input);
  }

  for (const input of document.querySelectorAll('input:not([type=hidden]):not([type=file]),textarea')) {
    const id = input.getAttribute('aria-labelledby');
    if (!id) continue;
    const labelEl = document.getElementById(id);
    if (labelEl) push(labelEl.textContent, input);
  }

  for (const input of document.querySelectorAll('input[aria-label]:not([type=hidden]),textarea[aria-label]')) {
    push(input.getAttribute('aria-label'), input);
  }

  for (const ta of document.querySelectorAll('textarea')) {
    if (ta.dataset.jaaSeen) continue;
    ta.dataset.jaaSeen = '1';
    const lbl = getLabelForTextarea(ta);
    if (lbl) push(lbl, ta);
  }

  for (const input of document.querySelectorAll('input[placeholder]:not([type=hidden]):not([type=file])')) {
    const ph = input.getAttribute('placeholder');
    if (ph && ph.length < 120) push(ph, input);
  }

  for (const group of document.querySelectorAll('[role="radiogroup"]')) {
    const labelId = group.getAttribute('aria-labelledby');
    const labelEl = labelId ? document.getElementById(labelId) : null;
    const text = (labelEl?.textContent || getAdjacentLabel(group) || '').trim();
    if (!text || seen.has(text)) continue;
    const options = [...group.querySelectorAll('input[type="radio"]')].map(r => getRadioOptionText(r)).filter(Boolean);
    if (options.length) { seen.add(text); fields.push({ label: text, type: 'radio', options }); }
  }

  return fields;
}

function findByLabel(text) {
  const t = text.toLowerCase();
  for (const label of document.querySelectorAll('label')) {
    if (label.textContent.replace(/\*/g, '').trim().toLowerCase() === t) {
      const forId = label.getAttribute('for');
      return (forId && document.getElementById(forId)) || label.querySelector('input,textarea');
    }
  }
  for (const el of document.querySelectorAll('[aria-labelledby]')) {
    const labelEl = document.getElementById(el.getAttribute('aria-labelledby'));
    if (labelEl?.textContent?.replace(/\*/g, '').trim().toLowerCase() === t) return el;
  }
  for (const el of document.querySelectorAll('[aria-label]')) {
    if (el.getAttribute('aria-label')?.replace(/\*/g, '').trim().toLowerCase() === t) return el;
  }
  for (const ta of document.querySelectorAll('textarea')) {
    if (getLabelForTextarea(ta)?.toLowerCase() === t) return ta;
  }
  return null;
}

function highlightResumeField() {
  const fileInput = document.querySelector('input[type="file"]');
  if (!fileInput) return;
  const zone = fileInput.parentElement;
  fileInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (!zone) return;
  let count = 0;
  const orig = zone.style.outline;
  const interval = setInterval(() => {
    zone.style.outline = count % 2 === 0 ? '2px solid #0a0a0a' : 'none';
    zone.style.outlineOffset = '4px';
    if (++count >= 6) {
      clearInterval(interval);
      zone.style.outline = '2px solid #0a0a0a';
      setTimeout(() => { zone.style.outline = orig; }, 4000);
    }
  }, 400);
}

function setVal(el, value) {
  if (!el || el.type === 'file' || el.disabled || el.readOnly) return;
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  try {
    if (setter) setter.call(el, value); else el.value = value;
  } catch { return; }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
}

// ── On-demand application generation ────────────────────────────────────────

let cachedIframeQuestions = [];

async function fetchIframeQuestions() {
  try {
    if (!chrome?.runtime?.sendMessage) return;
    const res = await new Promise(resolve => chrome.runtime.sendMessage({ type: 'GET_IFRAME_QUESTIONS' }, resolve));
    if (res?.questions?.length) cachedIframeQuestions = res.questions;
  } catch {}
}

async function generateApp(btn) {
  const status = shadow.getElementById('jaa-gen-status');
  btn.disabled = true;
  btn.textContent = 'Generating…';
  if (status) status.textContent = 'Scraping page and calling AI…';

  await fetchIframeQuestions();

  try {
    const details = scrapeJobDetails();
    const res = await serverFetch('/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(details),
    });
    if (!res.ok) throw new Error(JSON.stringify(res.data));
    currentApp = res.data;

    // Rebuild sidebar with the generated application
    document.getElementById('jaa-root')?.remove();
    shadow = null;
    injectWidget(false);
    injectCopyButtons();

    // Open the sidebar to show results
    const sidebar = shadow?.getElementById('jaa-sidebar');
    if (sidebar) { isOpen = true; sidebar.classList.add('open'); }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Generate application';
    if (status) status.textContent = `Error: ${e.message}`;
  }
}

function scrapeJobDetails() {
  const ats = detectATS();
  const pathParts = location.pathname.split('/').filter(Boolean);

  const slugToName = s => s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const companySlug = (ats === 'ashby' || ats === 'lever') ? pathParts[0] : '';
  let company = companySlug ? slugToName(companySlug) : '';

  const domCompany = ats === 'ashby'
    ? document.querySelector('[data-testid="org-name"], .org-name, header h2')?.textContent?.trim()
    : ats === 'lever'
    ? (document.title.split(' at ')[1] || '').split('|')[0].trim()
    : ats === 'greenhouse'
    ? document.querySelector('#header .company-name, .company-name')?.textContent?.trim()
    : '';
  if (domCompany && domCompany.length > 2) company = domCompany;

  if (!company) {
    const atIdx = document.title.toLowerCase().indexOf(' at ');
    if (atIdx !== -1) company = document.title.slice(atIdx + 4).split('|')[0].trim();
  }

  const role = (
    document.querySelector('h1')?.textContent?.trim() ||
    document.querySelector('h2')?.textContent?.trim() ||
    document.title.split('|')[0].split(' at ')[0]
  ).trim();

  const descEl = document.querySelector(
    '[data-testid="job-description"], .job-description, .posting-description, ' +
    '[class*="description"], [class*="content"], main, [role="main"]'
  );
  const raw = (descEl?.innerText || document.body.innerText).replace(/\s{3,}/g, '\n\n').trim();
  const description = raw.slice(0, 2500);

  const location_type = detectLocationType();

  // Scrape actual form questions — prefer questions from the live page DOM,
  // fall back to questions reported by the Ashby/Greenhouse iframe if this is an embed
  const skipBasic = /^(name|email|phone|mobile|linkedin|github|twitter|website|portfolio|location|city|salary|resume|cover\s*letter|first\s*(name)?|last\s*(name)?|url|upload|pronoun|referral|source|how did you hear)/i;
  const pageQuestions = scanPageFields()
    .filter(f => f.label.includes('?') || (f.label.length > 20 && !skipBasic.test(f.label.trim())))
    .map(f => f.label);
  const form_questions = pageQuestions.length > 0 ? pageQuestions : cachedIframeQuestions;

  return { url: location.href, company: company || 'Unknown', role: role || 'Unknown', description, ats, location_type, form_questions };
}

// ── Voice buttons ────────────────────────────────────────────────────────────

function getValueForField(label, name) {
  const p = mergeProfile(currentApp?.profile);
  const l = (label + ' ' + name).toLowerCase();

  if (/first.name|fname|preferred.first/.test(l) && !/last/.test(l)) return p.first_name || '';
  if (/last.name|lname|preferred.last/.test(l) && !/first/.test(l)) return p.last_name || '';
  if (/legal.*(name|first|last)|(first.*last|full.name)|your.name/.test(l) || (l.includes('first') && l.includes('last'))) return `${p.first_name} ${p.last_name}`;
  if (/email/.test(l)) return p.email || '';
  if (/phone|mobile|cell/.test(l)) return p.phone || '';
  if (/linkedin/.test(l)) return p.linkedin || '';
  if (/github/.test(l)) return p.github || '';
  if (/twitter|x\.com/.test(l)) return p.twitter || '';
  if (/portfolio|work\s*sample|sample\s*work|show\s*your\s*work/.test(l)) return p.website || '';
  if (/website|personal\s*site|project\s*site|online\s*presence|portfolio\s*url|personal\s*url/.test(l)) return p.website || '';
  if (/location|city|where.*based|based.in/.test(l)) return p.location || '';
  if (/salary|compensation|pay|expected/.test(l)) return p.salary ? `${Number(p.salary).toLocaleString()}` : '';
  if (/employer|company|current.*work|most recent/.test(l)) return p.current_employer || '';
  if (/school|university|college|education/.test(l)) return p.school || '';
  if (!currentApp) return '';
  const t = currentApp.tailored;
  if (/cover.letter|cover.note|additional.info|anything.else|message/.test(l)) return t.cover_note || '';
  if (/why.*join|why.*company|why.*us|why.*role|why.*apply/.test(l)) return t.why_role || '';
  if (/about.yourself|introduce|background|tell us about/.test(l)) return t.cover_note || '';
  const matches = findMatchingAnswers(label);
  if (matches.length) return matches[0].a;
  return '';
}

const JAA_COPY_MAP = new Map();

function makeFillBtn(el, value) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-jaa-copy', '1');
  btn.title = (value.length > 80 ? value.slice(0, 80) + '…' : value) + '\n\n⌥↩  paste when field is focused';
  btn.innerHTML = '<svg width="11" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>';
  btn.style.cssText = 'position:fixed;width:22px;height:22px;background:#fff;color:#999;border:1px solid #d8d8d8;border-radius:4px;cursor:pointer;z-index:2147483646;display:flex;align-items:center;justify-content:center;padding:0;box-shadow:0 1px 3px rgba(0,0,0,.12);';
  btn.addEventListener('mousedown', e => e.stopPropagation());
  btn.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    setVal(el, value);
    btn.style.background = '#0a0a0a';
    btn.style.color = '#fff';
    btn.style.borderColor = '#0a0a0a';
    setTimeout(() => {
      btn.style.background = '#fff';
      btn.style.color = '#999';
      btn.style.borderColor = '#d8d8d8';
    }, 1400);
  });
  return btn;
}

function getFieldLabel(el) {
  if (el.tagName === 'TEXTAREA') return getLabelForTextarea(el) || '';
  const labelledById = el.getAttribute('aria-labelledby');
  return (
    el.getAttribute('aria-label') ||
    (labelledById && document.getElementById(labelledById)?.textContent?.trim()) ||
    (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.replace(/\*/g,'').trim()) ||
    el.getAttribute('placeholder') || ''
  );
}

function repositionCopyBtns() {
  for (const [el, btn] of JAA_COPY_MAP) {
    if (!el.isConnected) { btn.remove(); JAA_COPY_MAP.delete(el); continue; }
    const r = el.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
    if (!visible) { btn.style.display = 'none'; continue; }
    btn.style.display = 'flex';
    btn.style.top = `${r.top + Math.max(0, (r.height - 22) / 2)}px`;
    btn.style.left = `${r.right - 26}px`;
  }
}

function tryInjectCopyBtn(el) {
  if (el.dataset.jaaCopyDone) return;
  el.dataset.jaaCopyDone = '1';

  const label = getFieldLabel(el);
  const value = getValueForField(label, el.name || el.id || '');
  if (!value) return;

  if (el.tagName === 'TEXTAREA') {
    const wrapper = el.parentElement;
    if (getComputedStyle(wrapper).position === 'static') wrapper.style.position = 'relative';
    const btn = makeFillBtn(el, value);
    btn.style.position = 'absolute';
    btn.style.top = '6px';
    btn.style.right = '40px';
    btn.style.left = '';
    wrapper.appendChild(btn);
  } else {
    const btn = makeFillBtn(el, value);
    document.body.appendChild(btn);
    JAA_COPY_MAP.set(el, btn);
    repositionCopyBtns();
  }
}

function injectCopyButtons() {
  document.querySelectorAll(
    'input:not([type=hidden]):not([type=file]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]),textarea'
  ).forEach(tryInjectCopyBtn);
}

function observeFields() {
  let debounce;
  const obs = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(() => { injectCopyButtons(); repositionCopyBtns(); }, 120);
  });
  obs.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('scroll', repositionCopyBtns, { passive: true, capture: true });
  window.addEventListener('resize', repositionCopyBtns, { passive: true });

  // Alt+Enter (Option+Enter on Mac) fires the copy button for the focused field
  document.addEventListener('keydown', e => {
    if (!e.altKey || e.key !== 'Enter') return;
    const active = document.activeElement;
    if (!active) return;
    const btn = JAA_COPY_MAP.get(active);
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      btn.click();
    } else {
      // Also check textarea siblings (absolute-positioned copy buttons)
      const sibling = active.parentElement?.querySelector('[data-jaa-copy]');
      if (sibling) { e.preventDefault(); e.stopPropagation(); sibling.click(); }
    }
  }, true);
}

function getLabelForTextarea(ta) {
  if (ta.getAttribute('aria-label')) return ta.getAttribute('aria-label');
  const labelledBy = ta.getAttribute('aria-labelledby');
  if (labelledBy) {
    const el = document.getElementById(labelledBy);
    if (el) return el.textContent.trim();
  }
  if (ta.id) {
    const el = document.querySelector(`label[for="${CSS.escape(ta.id)}"]`);
    if (el) return el.textContent.replace(/\*/g, '').trim();
  }
  let parent = ta.parentElement;
  for (let i = 0; i < 5; i++) {
    if (!parent) break;
    const lbl = parent.querySelector('label, [class*="label"], h3, h4');
    if (lbl && !lbl.contains(ta)) return lbl.textContent.replace(/\*/g, '').trim();
    parent = parent.parentElement;
  }
  return '';
}

function findMatchingAnswers(label) {
  if (!currentApp?.tailored?.qa || !label) return [];
  const words = label.toLowerCase().split(/\W+/).filter(w => w.length > 3);
  return currentApp.tailored.qa
    .map(item => {
      const haystack = (item.q + ' ' + item.a).toLowerCase();
      const score = words.filter(w => haystack.includes(w)).length;
      return { ...item, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

// Active voice state — sidebar Q&A mics only
let voiceQaMicBtn = null;
let voiceQaMicIdx = -1;
let voiceQaSR = null;

// Listen for messages from background
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'FORCE_INIT') {
    if (!IN_FRAME && !document.getElementById('jaa-root')) init();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'MANUAL_GENERATE') {
    if (IN_FRAME) { sendResponse({ ok: false, error: 'in frame' }); return true; }
    if (!document.getElementById('jaa-root')) init();
    // Give sidebar a moment to render, then trigger generate
    const tryGenerate = () => {
      const btn = shadow?.getElementById('jaa-generate');
      if (btn) { generateApp(btn); sendResponse({ ok: true }); }
      else setTimeout(tryGenerate, 300);
    };
    setTimeout(tryGenerate, 400);
    return true;
  }
});


// ── Submission detection ─────────────────────────────────────────────────────

const SUCCESS_URL = /\/(success|confirmation|thank.?you|submitted|complete|received)/i;
const SUCCESS_TEXT = /application (submitted|received|complete)|thank you for applying|we.ve received your application|you.re all set|successfully submitted/i;

function checkForSubmission() {
  if (!currentApp) return;
  const url = location.href;
  const bodyText = document.body?.innerText || '';
  if (SUCCESS_URL.test(url) || SUCCESS_TEXT.test(bodyText)) {
    recordApplied(currentApp);
  }
}

async function recordApplied(app) {
  if (window.__jaaApplied) return;
  window.__jaaApplied = true;

  try {
    await serverFetch('/applied', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: app.id, company: app.company, role: app.role, url: location.href }),
    });
  } catch {}

  const header = shadow?.querySelector('.sh-company');
  if (header) header.textContent = header.textContent + ' ✓';
}

new MutationObserver(() => checkForSubmission())
  .observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });

// Intercept fetch/XHR at the page level to catch AJAX form submissions.
// Injected script runs in page context; fires a document event visible to content script.
if (!IN_FRAME && !window.__jaaHooked) {
  window.__jaaHooked = true;
  const hook = document.createElement('script');
  hook.textContent = `(function() {
    const _fetch = window.fetch;
    window.fetch = function(...a) {
      const url = typeof a[0] === 'string' ? a[0] : (a[0]?.url || '');
      const method = (a[1]?.method || 'GET').toUpperCase();
      const p = _fetch.apply(this, a);
      if (method === 'POST' && /application|submit|apply/i.test(url)) {
        p.then(r => { if (r.ok) document.dispatchEvent(new CustomEvent('jaa-submitted')); return r; }).catch(() => {});
      }
      return p;
    };
    const _open = XMLHttpRequest.prototype.open;
    const _send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(m, u) { this._jaaMethod = m; this._jaaUrl = u; return _open.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function() {
      if ((this._jaaMethod || '').toUpperCase() === 'POST' && /application|submit|apply/i.test(this._jaaUrl || '')) {
        this.addEventListener('load', () => { if (this.status >= 200 && this.status < 300) document.dispatchEvent(new CustomEvent('jaa-submitted')); });
      }
      return _send.apply(this, arguments);
    };
  })();`;
  (document.head || document.documentElement).appendChild(hook);
  hook.remove();
  document.addEventListener('jaa-submitted', () => {
    setTimeout(checkForSubmission, 500);
    setTimeout(checkForSubmission, 2000);
  });
}

// Also catch native form submits and submit-button clicks
if (!IN_FRAME) {
  document.addEventListener('submit', () => { setTimeout(checkForSubmission, 800); setTimeout(checkForSubmission, 3000); }, true);
  document.addEventListener('click', e => {
    const btn = e.target?.closest('button,input[type=submit],[role=button]');
    if (btn && /submit|apply|send application/i.test(btn.textContent + btn.value + btn.getAttribute('aria-label'))) {
      setTimeout(checkForSubmission, 1500);
      setTimeout(checkForSubmission, 4000);
    }
  }, true);
}

// ── SPA navigation ───────────────────────────────────────────────────────────

let lastUrl = location.href;
new MutationObserver(() => {
  const currentHref = location.href;
  if (currentHref === lastUrl) return;

  // Only treat as real navigation if the pathname changed.
  // Query param changes (e.g. Greenhouse stripping ?gh_src=...) are not navigations.
  let pathChanged = true;
  try {
    pathChanged = new URL(lastUrl).pathname !== new URL(currentHref).pathname;
  } catch {}
  lastUrl = currentHref;
  if (!pathChanged) return;

  checkForSubmission();
  const prevApp = currentApp;
  currentApp = null;
  isOpen = false;
  document.getElementById('jaa-root')?.remove();
  document.body.style.marginRight = '';
  shadow = null;
  setTimeout(() => { currentApp = prevApp; init(); }, 1200);
}).observe(document.body, { childList: true, subtree: true });

init();
setTimeout(checkForSubmission, 1500);

// Guard: if the page's own JS removes jaa-root (e.g. Greenhouse SPA re-render),
// reinject without a full init cycle. Watch only direct body children for efficiency.
if (!IN_FRAME) {
  let guardReinjects = 0;
  new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.removedNodes) {
        if (node.id === 'jaa-root' && guardReinjects < 5) {
          guardReinjects++;
          setTimeout(() => {
            if (document.getElementById('jaa-root')) return;
            shadow = null;
            injectWidget(false);
            if (currentApp) { injectCopyButtons(); }
            setBodyPush(isOpen);
            if (isOpen) shadow?.getElementById('jaa-sidebar')?.classList.add('open');
          }, 600);
        }
      }
    }
  }).observe(document.body, { childList: true });
}
