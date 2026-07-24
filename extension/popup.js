const DEFAULT_SERVER = 'https://applyapplyapply.replit.app';
let SERVER = DEFAULT_SERVER;
let API_KEY = '';

const PROFILE_FIELDS = [
  'first_name', 'last_name', 'email', 'phone',
  'linkedin', 'location', 'work_authorization', 'salary',
];

// ── Boot: load server URL + key, then init ────────────────────────────────────
chrome.storage.sync.get(['serverUrl', 'apiKey', 'profile'], ({ serverUrl, apiKey, profile }) => {
  SERVER = serverUrl || DEFAULT_SERVER;
  API_KEY = apiKey || '';

  document.getElementById('serverUrl').value = SERVER !== DEFAULT_SERVER ? SERVER : '';
  if (apiKey) document.getElementById('apiKey').value = apiKey;
  if (profile) {
    for (const field of PROFILE_FIELDS) {
      const el = document.querySelector(`[data-field="${field}"]`);
      if (el && profile[field]) el.value = profile[field];
    }
  }

  document.getElementById('btn-audit').href = `${SERVER}/audit`;
  checkHealth();
});

function apiFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (API_KEY) headers['x-api-key'] = API_KEY;
  return fetch(`${SERVER}${path}`, { ...opts, headers });
}

// ── Force-inject sidebar on popup open ───────────────────────────────────────
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'FORCE_INIT' }, () => {
    if (chrome.runtime.lastError) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
    }
  });
});

// ── Server health ─────────────────────────────────────────────────────────────
const dot = document.getElementById('dot');
const statusText = document.getElementById('status-text');

function checkHealth() {
  apiFetch('/health').then(r => {
    if (r.ok) { dot.className = 'dot ok'; statusText.textContent = 'ready'; }
    else throw new Error();
  }).catch(() => {
    dot.className = 'dot err';
    statusText.textContent = 'server offline';
    document.getElementById('btn-apply').disabled = true;
  });
}

// ── Apply to this page ────────────────────────────────────────────────────────
const applyNote = document.getElementById('apply-note');

document.getElementById('btn-apply').addEventListener('click', () => {
  applyNote.textContent = 'Injecting…';
  applyNote.className = 'note';

  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id) { applyNote.textContent = 'No active tab'; return; }

    const doGenerate = () => {
      chrome.tabs.sendMessage(tab.id, { type: 'MANUAL_GENERATE' }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          applyNote.textContent = 'Could not inject — is this a job page?';
          applyNote.className = 'note err';
        } else {
          applyNote.textContent = 'Running — check the sidebar';
          applyNote.className = 'note ok';
          setTimeout(() => window.close(), 1000);
        }
      });
    };

    chrome.tabs.sendMessage(tab.id, { type: 'FORCE_INIT' }, () => {
      if (chrome.runtime.lastError) {
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }, () => {
          setTimeout(doGenerate, 600);
        });
      } else {
        setTimeout(doGenerate, 200);
      }
    });
  });
});

// ── Source & audit ────────────────────────────────────────────────────────────
document.getElementById('btn-audit').addEventListener('click', async (e) => {
  const href = e.currentTarget.href;
  try {
    const status = await apiFetch('/source/status').then(r => r.json());
    if (!status.active) await apiFetch('/source/run', { method: 'POST' });
  } catch {}
});

// ── Settings ──────────────────────────────────────────────────────────────────

document.getElementById('toggleKey').addEventListener('click', () => {
  const input = document.getElementById('apiKey');
  input.type = input.type === 'password' ? 'text' : 'password';
});

document.getElementById('saveSettings').addEventListener('click', () => {
  const serverUrl = document.getElementById('serverUrl').value.trim() || DEFAULT_SERVER;
  const apiKey = document.getElementById('apiKey').value.trim();
  const profile = {};
  for (const field of PROFILE_FIELDS) {
    const el = document.querySelector(`[data-field="${field}"]`);
    if (el?.value.trim()) profile[field] = el.value.trim();
  }
  chrome.storage.sync.set({ serverUrl, apiKey, profile }, () => {
    SERVER = serverUrl;
    API_KEY = apiKey;
    document.getElementById('btn-audit').href = `${SERVER}/audit`;
    const s = document.getElementById('save-status');
    s.textContent = 'Saved';
    setTimeout(() => { s.textContent = ''; }, 1800);
  });
});

document.getElementById('btn-settings-toggle').addEventListener('click', () => {
  const panel = document.getElementById('settings-panel');
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : '';
  document.getElementById('btn-settings-toggle').textContent = visible ? 'Settings' : 'Done';
  document.getElementById('btn-settings-toggle').className = visible ? 'btn secondary' : 'btn secondary active';
});
