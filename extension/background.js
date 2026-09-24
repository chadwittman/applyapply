// ── Offscreen voice recording ─────────────────────────────────────────────────

const CLOUD_URL = 'https://applyapply.xyz';
const LEGACY_CLOUD_URL = 'https://applyapply-production.up.railway.app';
const LOCAL_URL = 'http://localhost:5000';
let SERVER = LOCAL_URL;
let API_KEY = '';
let sessionEpoch = 0;
async function readSession() {
  const state = await chrome.storage.sync.get(['mode', 'serverUrl', 'apiKey']);
  // Migrate installs that remembered the old Railway hostname before the
  // custom domain became canonical.
  SERVER = state.serverUrl === LEGACY_CLOUD_URL
    ? CLOUD_URL
    : (state.serverUrl || (state.mode === 'local' ? LOCAL_URL : CLOUD_URL));
  API_KEY = state.apiKey || '';
}
let sessionReady = readSession();

// Reject stale responses and clear account-specific state on every session change.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync' || !['apiKey', 'mode', 'serverUrl'].some(k => changes[k])) return;
  sessionEpoch++;
  voicePending = null;
  iframeQuestionsMap.clear();
  sessionReady = readSession();
  await sessionReady;
  chrome.action.setBadgeText({ text: '' });
});

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'SET_SESSION' || typeof msg.token !== 'string') return;
  (async () => {
    await sessionReady;
    const origin = new URL(sender.url).origin;
    const allowed = SERVER === CLOUD_URL ? [CLOUD_URL, 'https://applyapply.xyz'] : [new URL(SERVER).origin];
    if (!allowed.includes(origin) || new URL(sender.url).pathname !== '/auth/success') throw new Error('Untrusted sign-in page');
    const r = await fetch(SERVER + '/auth/me', { headers: { 'x-api-key': msg.token } });
    if (!r.ok) throw new Error('Invalid session');
    const account = await r.json();
    await chrome.storage.sync.remove(['profile', 'userEmail']);
    await chrome.storage.sync.set({ apiKey: msg.token, userEmail: account.email || '' });
    sendResponse({ ok: true });
  })().catch(e => sendResponse({ ok: false, error: e.message }));
  return true;
});

function serverHeaders(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (API_KEY) h['x-api-key'] = API_KEY;
  return h;
}

let voicePending = null; // { tabId, frameId, question }

// Iframe form questions — keyed by tabId, set by iframe content script, read by main frame
const iframeQuestionsMap = new Map();
const frameFills = new Map();

async function ensureOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Voice transcription for job applications',
    });
  } catch (e) {
    // "Only a single offscreen document may be created" = already open, that's fine
    if (!e.message?.toLowerCase().includes('single') && !e.message?.toLowerCase().includes('already')) throw e;
  }
}

async function cleanupVoice(transcript, question) {
  if (!transcript?.trim()) return '';
  await sessionReady;
  const epoch = sessionEpoch;
  try {
    const r = await fetch(SERVER + '/voice', {
      method: 'POST', headers: serverHeaders(),
      body: JSON.stringify({ transcript, question }),
    });
    if (epoch !== sessionEpoch) return '';
    if (r.ok) return (await r.json()).text || transcript;
  } catch {}
  return epoch === sessionEpoch ? transcript : '';
}

// ── Main message listener ─────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OPEN_SIGNIN') {
    sessionReady.then(() => chrome.tabs.create({ url: `${SERVER}/login?ext=${chrome.runtime.id}` }));
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'STORE_IFRAME_QUESTIONS') {
    if (sender.tab?.id) iframeQuestionsMap.set(sender.tab.id, msg.questions);
    return;
  }

  // A form inside a cross-origin iframe cannot read the page it is embedded
  // in, so it cannot tell which job it is looking at. The worker can: it is the
  // only party that sees both.
  if (msg.type === 'GET_TOP_URL') {
    sendResponse({ url: sender.tab?.url || '' });
    return true;
  }

  // Fill every frame of this tab. The sidebar lives in the top frame, and on an
  // embedded board (Comparably fronting Greenhouse, say) the top frame holds no
  // fields at all, so filling only there did visibly nothing.
  if (msg.type === 'FILL_FRAMES') {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ filled: 0 }); return true; }
    frameFills.set(tabId, 0);
    chrome.tabs.sendMessage(tabId, { type: 'DO_FILL' }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'FRAME_FILLED') {
    const tabId = sender.tab?.id;
    if (tabId) frameFills.set(tabId, (frameFills.get(tabId) || 0) + (Number(msg.filled) || 0));
    return;
  }

  if (msg.type === 'GET_FRAME_FILLS') {
    sendResponse({ filled: frameFills.get(sender.tab?.id) || 0 });
    return true;
  }

  if (msg.type === 'GET_IFRAME_QUESTIONS') {
    sendResponse({ questions: iframeQuestionsMap.get(sender.tab?.id) || [] });
    return true;
  }

  if (msg.type === 'CAPTURE_SCREENSHOT') {
    chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 80 }, dataUrl => {
      if (chrome.runtime.lastError) sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      else sendResponse({ ok: true, dataUrl });
    });
    return true;
  }

  if (msg.type === 'INJECT_SUBMIT_HOOK') {
    if (!sender.tab?.id) return;
    chrome.scripting.executeScript({
      // Hook the frame that asked. The submit POST happens inside the embedded
      // ATS iframe, not the top frame.
      target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] },
      world: 'MAIN',
      func: () => {
        if (window.__jaaHookedMain) return;
        window.__jaaHookedMain = true;
        const _fetch = window.fetch;
        window.fetch = function (...a) {
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
        XMLHttpRequest.prototype.open = function (m, u) { this._jaaMethod = m; this._jaaUrl = u; return _open.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function () {
          if ((this._jaaMethod || '').toUpperCase() === 'POST' && /application|submit|apply/i.test(this._jaaUrl || '')) {
            this.addEventListener('load', () => { if (this.status >= 200 && this.status < 300) document.dispatchEvent(new CustomEvent('jaa-submitted')); });
          }
          return _send.apply(this, arguments);
        };
      },
    }).catch(() => {});
    return;
  }

  if (msg.type === 'SERVER_FETCH') {
    const epoch = sessionEpoch;
    (async () => {
      await sessionReady;
      if (epoch !== sessionEpoch) throw new Error('Session changed');
      if ((msg.options?.headers?.['x-api-key'] || '') !== API_KEY) throw new Error('Session changed');
      const target = new URL(msg.url);
      if (target.origin !== new URL(SERVER).origin || target.username || target.password) throw new Error('Untrusted server');
      const method = msg.options?.method || 'GET';
      if (!['GET', 'POST', 'DELETE'].includes(method)) throw new Error('Unsupported method');
      fetch(target.href, {
        method, headers: serverHeaders({ 'Idempotency-Key': msg.options?.headers?.['Idempotency-Key'] || crypto.randomUUID() }),
        body: method === 'GET' ? undefined : msg.options?.body,
        redirect: 'error',
      }).then(async res => {
        const body = await res.text();
        if (epoch !== sessionEpoch) return sendResponse({ ok: false, error: 'Session changed' });
        let data;
        try { data = JSON.parse(body); } catch { data = body; }
        sendResponse({ ok: res.ok, status: res.status, data });
      }).catch(e => sendResponse({ ok: false, error: e.message }));
    })().catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'VOICE_CLEANUP') {
    handleVoiceCleanup(msg.transcript, msg.question).then(sendResponse).catch(() => sendResponse({ text: msg.transcript }));
    return true;
  }

  // Route voice through offscreen doc (works in cross-origin iframes)
  if (msg.type === 'VOICE_START') {
    voicePending = { tabId: sender.tab?.id, frameId: sender.frameId, question: msg.question, epoch: sessionEpoch };
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ target: 'offscreen', type: 'START_REC' }))
      .catch(err => {
        sendResponse({ ok: false, error: err.message });
        if (voicePending) {
          chrome.tabs.sendMessage(voicePending.tabId, { type: 'VOICE_ERROR', error: err.message }, { frameId: voicePending.frameId }).catch(() => {});
          voicePending = null;
        }
      });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'VOICE_STOP') {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_REC' }).catch(() => {});
    return true;
  }

  // Messages from offscreen doc
  if (msg.type === 'VOICE_REC_STARTED') {
    if (voicePending) {
      chrome.tabs.sendMessage(voicePending.tabId, { type: 'VOICE_STARTED' }, { frameId: voicePending.frameId }).catch(() => {});
    }
    return;
  }

  if (msg.type === 'VOICE_REC_DONE') {
    const pending = voicePending;
    voicePending = null;
    if (!pending) return;
    cleanupVoice(msg.transcript, pending.question).then(text => {
      if (pending.epoch !== sessionEpoch) return;
      // Fill the field in the content script
      chrome.tabs.sendMessage(pending.tabId, { type: 'VOICE_RESULT', text }, { frameId: pending.frameId }).catch(() => {});
      // Also write to clipboard in the tab as a fallback (paste always works)
      if (text) {
        chrome.scripting.executeScript({
          target: { tabId: pending.tabId },
          func: (t) => navigator.clipboard.writeText(t).catch(() => {}),
          args: [text],
        }).catch(() => {});
      }
    });
    return;
  }

  if (msg.type === 'VOICE_REC_ERROR') {
    const pending = voicePending;
    voicePending = null;
    if (pending) {
      chrome.tabs.sendMessage(pending.tabId, { type: 'VOICE_ERROR', error: msg.error }, { frameId: pending.frameId }).catch(() => {});
    }
    return;
  }
});

async function handleVoiceCleanup(transcript, question) {
  return { text: await cleanupVoice(transcript, question) };
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('applyapply installed');
  updateBadge();
});

async function updateBadge() {
  try {
    const r = await fetch(`${SERVER}/status`, { headers: API_KEY ? { 'x-api-key': API_KEY } : {} });
    if (!r.ok) { chrome.action.setBadgeText({ text: '' }); return; }
    const { new: n } = await r.json();
    chrome.action.setTitle({ title: n > 0 ? `ApplyApply: ${n} new matches` : 'ApplyApply: open application or job pipeline' });
    if (n > 0) {
      chrome.action.setBadgeText({ text: String(n) });
      chrome.action.setBadgeBackgroundColor({ color: '#0a0a0a' });
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  } catch {
    chrome.action.setBadgeText({ text: '' });
  }
}

// Refresh badge when any tab finishes loading (catches sourcing runs completing)
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') updateBadge();
});

// Detect embedded ATS job pages on custom career domains and inject content.js
function isEmbeddedJobPage(url) {
  try {
    const u = new URL(url);
    const params = u.searchParams;
    const path = u.pathname.toLowerCase();
    const host = u.hostname;

    if (/(^|\.)(jobs\.ashbyhq\.com|greenhouse\.io|jobs\.lever\.co|instacart\.careers|jobs\.a16z\.com)$/.test(host)) return true;
    if (host === 'stripe.com' && path.startsWith('/jobs/')) return true;

    // Hosted ATS platforms. jobs.gem.com carries "jobs" in the hostname, not
    // the path, so the careers-path patterns below never matched it and the
    // sidebar never appeared.
    if (/(^|\.)(gem\.com|workable\.com|smartrecruiters\.com|myworkdayjobs\.com|jobvite\.com|icims\.com|breezy\.hr|recruitee\.com|teamtailor\.com|careerpuck\.com|comeet\.com|rippling\.com|paylocity\.com|dover\.com|pinpointhq\.com|jazzhr\.com|bamboohr\.com)$/i.test(host)) return true;

    // ATS embed query params
    if (params.has('gh_jid') || params.has('ashby_jid') || params.has('lever_job_id')) return true;

    // Common career page URL patterns
    if (/\/(careers|jobs|join|work-with-us|open-roles)(\/|$|\?)/i.test(path)) return true;
    if (/\/(apply|application)(\/|$|\?)/i.test(path)) return true;

    return false;
  } catch { return false; }
}

// Detect ATS type from URL params alone (used before content.js can check)
function atsFromUrl(url) {
  try {
    const params = new URL(url).searchParams;
    if (params.has('ashby_jid')) return 'ashby';
    if (params.has('gh_jid')) return 'greenhouse';
    if (params.has('lever_job_id')) return 'lever';
  } catch {}
  return null;
}

// Key by tabId:url so re-navigating to a different job URL reinjects
const injected = new Set();

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    for (const key of injected) if (key.startsWith(tabId + ':')) injected.delete(key);
    iframeQuestionsMap.delete(tabId);
  }
  // Opening a page never opens the sidebar. Only the toolbar action does.
});

chrome.action.onClicked.addListener(async tab => {
  // Without host access to a site Chrome omits tab.url entirely. That is the
  // intended state now: the extension asks for named ATS domains only, and
  // automatic detection everywhere else is opt-in. On a site we cannot see,
  // clicking the toolbar icon still injects through activeTab.
  const url = tab.url;
  if (!url || !isEmbeddedJobPage(url)) {
    await chrome.tabs.create({ url: `${SERVER}/pipeline` });
    return;
  }
  const tabId = tab.id;

  try {
    const reply = await chrome.tabs.sendMessage(tabId, { type: 'FORCE_INIT' }, { frameId: 0 });
    if (reply?.ok) return;
  } catch { /* First activation on this page. */ }

  const key = `${tabId}:${url}`;
  if (injected.has(key)) return;
  injected.add(key);

  const ats = atsFromUrl(url);

  const doInject = () =>
    chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['vendor/jspdf.umd.min.js', 'content.js'] })
      .then(() => console.log('[applyapply] injected into', url))
      .catch(async err => {
        injected.delete(key);
        console.warn('[applyapply] inject failed:', err.message, url);
        await chrome.tabs.create({ url: `${SERVER}/pipeline` });
      });

  {
    // Stamp the ATS type on the window BEFORE content.js runs, so detectATS()
    // returns the right value even if the page already stripped the URL params.
    chrome.scripting.executeScript({
      target: { tabId },
      func: (type) => { window.__JAA_ATS = type; window.__JAA_FORCE = true; },
      args: [ats],
    }).then(doInject).catch(doInject);
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  for (const key of injected) {
    if (key.startsWith(`${tabId}:`)) injected.delete(key);
  }
  iframeQuestionsMap.delete(tabId);
});
