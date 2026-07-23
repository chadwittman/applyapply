// Universal voice input — injects mic buttons on all textareas when voice mode is enabled.
// Does NOT run on ATS pages (content.js already handles those with richer context).

(async function() {
  const ATS_HOSTS = new Set([
    'jobs.ashbyhq.com', 'job-boards.greenhouse.io', 'jobs.greenhouse.io',
    'boards.greenhouse.io', 'jobs.lever.co', 'instacart.careers',
    'stripe.com', 'jobs.a16z.com',
  ]);
  if (ATS_HOSTS.has(location.hostname)) return;

  let active = false;

  const { voiceMode } = await chrome.storage.sync.get('voiceMode');
  if (voiceMode) boot();

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'VOICE_MODE_ON') boot();
  });

  function isVoiceTarget(el, label) {
    if (el.tagName === 'TEXTAREA') return true;
    if (!label) return false;
    return label.length > 24 || label.includes('?') || /tell|describe|explain|why|what|how|share|experience|background/i.test(label);
  }

  function boot() {
    if (active) return;
    active = true;
    document.querySelectorAll('textarea, input[type=text], input[type=search]').forEach(el => {
      const label = getLabelForTextarea(el);
      if (isVoiceTarget(el, label)) inject(el);
    });
    let debounce;
    new MutationObserver(() => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
      document.querySelectorAll('textarea, input[type=text], input[type=search]').forEach(el => {
        const label = getLabelForTextarea(el);
        if (isVoiceTarget(el, label)) inject(el);
      });
    }, 120);
    }).observe(document.body, { childList: true, subtree: true });
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

  function setVal(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    try { if (setter) setter.call(el, value); else el.value = value; } catch { return; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  let activeBtn = null;
  let activeTa = null;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'VOICE_STARTED') {
      if (activeBtn) { activeBtn.textContent = '⏹'; activeBtn.style.background = '#c00'; }
    }
    if (msg.type === 'VOICE_RESULT') {
      if (activeTa && msg.text) setVal(activeTa, msg.text);
      if (activeBtn) {
        activeBtn.textContent = '✓';
        activeBtn.style.background = '#166534';
        setTimeout(() => { if (activeBtn) { activeBtn.textContent = '🎤'; activeBtn.style.background = '#0a0a0a'; } }, 2000);
      }
      activeBtn = null; activeTa = null;
    }
    if (msg.type === 'VOICE_ERROR') {
      if (activeBtn) { activeBtn.textContent = '🎤'; activeBtn.style.background = '#0a0a0a'; }
      activeBtn = null; activeTa = null;
    }
  });

  function inject(ta) {
    if (ta.dataset.jaaVoice) return;
    ta.dataset.jaaVoice = '1';

    const label = getLabelForTextarea(ta);
    const wrapper = ta.parentElement;
    if (!wrapper) return;
    if (getComputedStyle(wrapper).position === 'static') wrapper.style.position = 'relative';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '🎤';
    btn.title = label ? label.slice(0, 80) : 'Voice input (applyapply)';
    const isInput = ta.tagName === 'INPUT';
    btn.style.cssText = isInput
      ? 'position:absolute;top:50%;right:34px;transform:translateY(-50%);width:26px;height:26px;background:#0a0a0a;color:#fff;border:none;border-radius:50%;font-size:12px;line-height:1;cursor:pointer;z-index:9998;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.25);'
      : 'position:absolute;top:6px;right:6px;width:28px;height:28px;background:#0a0a0a;color:#fff;border:none;border-radius:50%;font-size:13px;line-height:1;cursor:pointer;z-index:9998;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.25);';
    wrapper.appendChild(btn);

    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();

      if (activeBtn === btn) {
        chrome.runtime.sendMessage({ type: 'VOICE_STOP' });
        btn.textContent = '⏳';
        btn.style.background = '#555';
        return;
      }

      if (activeBtn) {
        chrome.runtime.sendMessage({ type: 'VOICE_STOP' });
        activeBtn.textContent = '🎤';
        activeBtn.style.background = '#0a0a0a';
      }

      activeBtn = btn;
      activeTa = ta;
      btn.textContent = '⏳';
      btn.style.background = '#555';

      chrome.runtime.sendMessage({ type: 'VOICE_START', question: label }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          btn.textContent = '🎤';
          btn.style.background = '#0a0a0a';
          activeBtn = null; activeTa = null;
        }
      });
    });
  }
})();
