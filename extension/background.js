// ── Offscreen voice recording ─────────────────────────────────────────────────

let SERVER = 'http://localhost:3747';
let API_KEY = '';
chrome.storage.sync.get(['serverUrl', 'apiKey'], (s) => {
  if (s.serverUrl) SERVER = s.serverUrl;
  if (s.apiKey) API_KEY = s.apiKey;
});

function serverHeaders(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (API_KEY) h['x-api-key'] = API_KEY;
  return h;
}

let voicePending = null; // { tabId, frameId, question }

// Iframe form questions — keyed by tabId, set by iframe content script, read by main frame
const iframeQuestionsMap = new Map();

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
  let text = transcript;
  try {
    const r = await fetch(`${SERVER}/voice`, {
      method: 'POST',
      headers: serverHeaders(),
      body: JSON.stringify({ transcript, question }),
    });
    if (r.ok) { const d = await r.json(); text = d.text || transcript; }
  } catch {
    const { apiKey } = await chrome.storage.sync.get('apiKey');
    if (apiKey) {
      try {
        const prompt = `Clean up this voice transcript into polished written prose.
${question ? `\nQuestion: ${question}` : ''}
Transcript: ${transcript}

Rules: remove filler words, fix grammar, no em dashes, short sentences. Return only the cleaned text.`;
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
        });
        if (r.ok) { const d = await r.json(); text = d.content?.[0]?.text?.trim() || transcript; }
      } catch {}
    }
  }
  return text;
}

// ── Main message listener ─────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'STORE_IFRAME_QUESTIONS') {
    if (sender.tab?.id) iframeQuestionsMap.set(sender.tab.id, msg.questions);
    return;
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

  if (msg.type === 'SERVER_FETCH') {
    fetch(msg.url, {
      method: msg.options?.method || 'GET',
      headers: msg.options?.headers || {},
      body: msg.options?.body || null,
    })
      .then(async res => {
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        sendResponse({ ok: res.ok, status: res.status, data });
      })
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === 'VOICE_CLEANUP') {
    handleVoiceCleanup(msg.transcript, msg.question).then(sendResponse).catch(() => sendResponse({ text: msg.transcript }));
    return true;
  }

  // Route voice through offscreen doc (works in cross-origin iframes)
  if (msg.type === 'VOICE_START') {
    voicePending = { tabId: sender.tab?.id, frameId: sender.frameId, question: msg.question };
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
  // Try server first (has richer context from app)
  try {
    const r = await fetch(`${SERVER}/voice`, {
      method: 'POST',
      headers: serverHeaders(),
      body: JSON.stringify({ transcript, question }),
    });
    if (r.ok) return r.json();
  } catch {}

  // Fall back to direct Anthropic call using stored API key
  const { apiKey } = await chrome.storage.sync.get('apiKey');
  if (!apiKey) return { text: transcript };

  const prompt = `Clean up this voice transcript into polished written prose.

${question ? `Question being answered: ${question}\n` : ''}Raw transcript: ${transcript}

Rules:
- Remove filler words: um, uh, like, you know, sort of, kind of, I mean, basically, literally
- Break up run-on sentences — if a sentence has multiple clauses joined by "and" or "so", split it
- Fix grammar throughout
- Keep every idea — do not drop substance, do not add new content
- No em dashes. Use periods and short sentences.
- Write how a direct, confident person writes, not how they talk
- Return only the cleaned text, no preamble`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) return { text: transcript };
  const data = await r.json();
  return { text: data.content?.[0]?.text?.trim() || transcript };
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

    // Already handled by content_scripts manifest — skip known ATS domains
    if (/jobs\.ashbyhq\.com|greenhouse\.io|jobs\.lever\.co|instacart\.careers|jobs\.a16z\.com|stripe\.com/.test(host)) return false;

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
  if (changeInfo.status !== 'complete') return;
  const url = tab.url;
  if (!url || !isEmbeddedJobPage(url)) return;

  const key = `${tabId}:${url}`;
  if (injected.has(key)) return;
  injected.add(key);

  const ats = atsFromUrl(url);

  const doInject = () =>
    chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
      .then(() => console.log('[applyapply] injected into', url))
      .catch(err => console.warn('[applyapply] inject failed:', err.message, url));

  if (ats) {
    // Stamp the ATS type on the window BEFORE content.js runs, so detectATS()
    // returns the right value even if the page already stripped the URL params.
    chrome.scripting.executeScript({
      target: { tabId },
      func: (type) => { window.__JAA_ATS = type; },
      args: [ats],
    }).then(doInject).catch(doInject);
  } else {
    doInject();
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  for (const key of injected) {
    if (key.startsWith(`${tabId}:`)) injected.delete(key);
  }
  iframeQuestionsMap.delete(tabId);
});
