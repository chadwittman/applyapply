const SERVER = 'http://localhost:3747';

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

fetch(`${SERVER}/health`).then(r => {
  if (r.ok) { dot.className = 'dot ok'; statusText.textContent = 'ready'; }
  else throw new Error();
}).catch(() => {
  dot.className = 'dot err';
  statusText.textContent = 'server offline';
  document.getElementById('btn-apply').disabled = true;
});

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
// The audit link opens http://localhost:3747/audit directly (it's an <a> tag).
// When clicked, also kick off a sourcing run if one isn't already active.
document.getElementById('btn-audit').addEventListener('click', async () => {
  try {
    const status = await fetch(`${SERVER}/source/status`).then(r => r.json());
    if (!status.active) {
      await fetch(`${SERVER}/source/run`, { method: 'POST' });
    }
  } catch {}
  // The href opens the audit page — let the default <a> behavior handle it
});

// ── Settings ──────────────────────────────────────────────────────────────────
const PROFILE_FIELDS = [
  'first_name', 'last_name', 'email', 'phone',
  'linkedin', 'location', 'work_authorization', 'salary',
];

chrome.storage.sync.get(['apiKey', 'profile'], ({ apiKey, profile }) => {
  if (apiKey) document.getElementById('apiKey').value = apiKey;
  if (profile) {
    for (const field of PROFILE_FIELDS) {
      const el = document.querySelector(`[data-field="${field}"]`);
      if (el && profile[field]) el.value = profile[field];
    }
  }
});

document.getElementById('toggleKey').addEventListener('click', () => {
  const input = document.getElementById('apiKey');
  input.type = input.type === 'password' ? 'text' : 'password';
});

document.getElementById('saveSettings').addEventListener('click', () => {
  const apiKey = document.getElementById('apiKey').value.trim();
  const profile = {};
  for (const field of PROFILE_FIELDS) {
    const el = document.querySelector(`[data-field="${field}"]`);
    if (el?.value.trim()) profile[field] = el.value.trim();
  }
  chrome.storage.sync.set({ apiKey, profile }, () => {
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
});
