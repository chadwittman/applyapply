const CLOUD_URL = 'https://applyapply.xyz';
let SERVER = CLOUD_URL;
let API_KEY = '';

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && (changes.apiKey || changes.serverUrl)) window.location.reload();
});

function setMode() {
  SERVER = CLOUD_URL;
  document.getElementById('btn-audit').href = `${SERVER}/sourcing`;
  checkHealth();
}

const PROFILE_FIELDS = [
  'first_name', 'last_name', 'email', 'phone',
  'linkedin', 'location', 'work_authorization', 'sponsorship', 'salary',
  'search_mode',
];

function apiFetch(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (API_KEY) headers['x-api-key'] = API_KEY;
  return fetch(`${SERVER}${path}`, { ...opts, headers });
}

function isJwt(token) {
  return token && token.startsWith('eyJ');
}

function setAuthState(signedIn, email) {
  document.getElementById('auth-signed-in').style.display = signedIn ? '' : 'none';
  document.getElementById('auth-signed-out').style.display = signedIn ? 'none' : '';
  if (signedIn && email) document.getElementById('auth-email').textContent = email;
  if (signedIn) {
    apiFetch('/auth/me').then(r => r.json()).then(d => {
      const el = document.getElementById('auth-credits');
      if (el && d.credits != null) el.textContent = d.credits + ' cr';
    }).catch(() => {});
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

chrome.storage.sync.get(['apiKey', 'profile', 'userEmail', 'alwaysRegenerate'], ({ apiKey, profile, userEmail, alwaysRegenerate }) => {
  API_KEY = apiKey || '';
  setMode();
  const regenerate = document.getElementById('always-regenerate');
  if (regenerate) {
    regenerate.checked = alwaysRegenerate === true;
    regenerate.addEventListener('change', () => chrome.storage.sync.set({ alwaysRegenerate: regenerate.checked }));
  }

  if (API_KEY) {
    if (isJwt(API_KEY)) {
      // Decode email from JWT payload (no verification needed — just display)
      try {
        const payload = JSON.parse(atob(API_KEY.split('.')[1]));
        setAuthState(true, payload.email || userEmail || '');
      } catch {
        setAuthState(true, userEmail || '');
      }
    } else {
      // Legacy API key — show as signed in with email if we have it
      setAuthState(true, userEmail || '');
    }
    apiFetch('/profile').then(r=>r.ok?r.json():null).then(profile=>{
      if (!profile) return;
      for (const field of PROFILE_FIELDS) {
        const el=document.querySelector('[data-field="'+field+'"]');
        if (el) el.value=profile[field] || '';
      }
    }).catch(()=>{});
    if (profile) {
      for (const field of PROFILE_FIELDS) {
        const el = document.querySelector(`[data-field="${field}"]`);
        if (el && profile[field]) el.value = profile[field];
      }
    }
  } else {
    setAuthState(false);
  }

  document.getElementById('btn-audit').href = `${SERVER}/sourcing`;
  checkHealth();
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
          chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { window.__JAA_FORCE = true; } }, () => {
            if (chrome.runtime.lastError) { applyNote.textContent = 'Cannot run on this page'; applyNote.className = 'note err'; return; }
            chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['vendor/jspdf.umd.min.js', 'content.js'] }, () => {
              if (chrome.runtime.lastError) { applyNote.textContent = 'Cannot run on this page'; applyNote.className = 'note err'; return; }
              setTimeout(doGenerate, 600);
            });
          });
        } else {
        setTimeout(doGenerate, 200);
      }
    });
  });
});

// ── Source & audit ────────────────────────────────────────────────────────────

// Opens the sourcing page so the run can be configured and priced first.
// This used to POST /source/run directly, which started a full run — every
// default source, no confirmation — and now that runs cost credits that spent
// them on a single click from a button labelled "Find new jobs".


// ── Settings toggle ───────────────────────────────────────────────────────────

document.getElementById('btn-settings-toggle').addEventListener('click', () => {
  const panel = document.getElementById('settings-panel');
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : '';
  document.getElementById('btn-settings-toggle').textContent = visible ? 'Settings' : 'Done';
  document.getElementById('btn-settings-toggle').className = visible ? 'btn secondary' : 'btn secondary active';
});

// ── Sign in ───────────────────────────────────────────────────────────────────

document.getElementById('btn-signin').addEventListener('click', () => {
  const extId = chrome.runtime.id;
  chrome.tabs.create({ url: `${SERVER}/login?ext=${extId}` });
});

// ── Sign out ──────────────────────────────────────────────────────────────────

document.getElementById('btn-signout').addEventListener('click', () => {
  chrome.storage.sync.remove(['apiKey', 'userEmail', 'profile'], () => {
    API_KEY = '';
    setAuthState(false);
    for (const field of PROFILE_FIELDS) {
      const el = document.querySelector(`[data-field="${field}"]`);
      if (el) el.value = '';
    }
  });
});

// ── Save profile ──────────────────────────────────────────────────────────────

document.getElementById('saveSettings').addEventListener('click', async () => {
  const profile = {};
  for (const field of PROFILE_FIELDS) {
    const el = document.querySelector(`[data-field="${field}"]`);
    if (el) profile[field] = el.value.trim();
  }
  chrome.storage.sync.set({ profile }, () => {});
  const s = document.getElementById('save-status');
  if (API_KEY) {
    try {
      const response = await apiFetch('/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(profile),
      });
      if (!response.ok) throw new Error('Save failed');
      s.textContent = 'Saved';
    } catch {
      s.textContent = 'Saved locally';
    }
  } else {
    s.textContent = 'Saved locally';
  }
  setTimeout(() => { s.textContent = ''; }, 2000);
});

document.getElementById('btn-setup').addEventListener('click', () => {
  chrome.tabs.create({ url: `${SERVER}/setup` });
});
