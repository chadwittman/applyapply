/* global window, document, localStorage, navigator */
// The /imessage test page: a phone-style thread over the real conversation
// engine. Sending posts the text; replies arrive by polling, with typing dots
// while the engine works.
(() => {
  const thread = document.getElementById('thread');
  const bar = document.getElementById('bar');
  const input = document.getElementById('text');
  const sendBtn = document.getElementById('send');
  const resetBtn = document.getElementById('reset');
  const session = (() => { try { return localStorage.getItem('aa_session') || ''; } catch { return ''; } })();
  let lastId = 0, busyUntil = 0, timer = null;

  const headers = extra => ({ Authorization: 'Bearer ' + session, ...extra });
  const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const linkify = s => escapeHtml(s).replace(/https?:\/\/[^\s<]+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);

  function gate(html) { thread.innerHTML = `<div class="gate">${html}</div>`; }
  function toast(msg) {
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t); setTimeout(() => t.remove(), 1200);
  }
  function add(m) {
    const prev = thread.lastElementChild;
    if (prev && prev.dataset.dir && prev.dataset.dir !== m.direction) thread.appendChild(Object.assign(document.createElement('div'), { className: 'gap' }));
    const b = document.createElement('div');
    b.className = 'b ' + (m.direction === 'in' ? 'out' : 'in');
    b.dataset.dir = m.direction;
    b.innerHTML = (m.voice ? '<span class="voice-tag">🎤 voice note</span><br>' : '') + linkify(m.body);
    // Messages unfurls a kit link into a card. Show the same card here, or the
    // test line looks nothing like the thing it is testing.
    const kit = m.body.match(/\/k\/([A-Za-z0-9_-]{8,})/);
    if (kit && m.direction !== 'in') {
      const card = document.createElement('a');
      card.className = 'unfurl';
      card.href = m.body.match(/https?:\/\/[^\s<]*\/k\/[A-Za-z0-9_-]+/)?.[0] || '#';
      card.target = '_blank'; card.rel = 'noopener';
      card.innerHTML = '<img src="/k/' + kit[1] + '/card.png" alt="" loading="lazy">';
      thread.appendChild(card);
    }
    // Tap to copy, standing in for long-press → Copy in Messages.
    b.addEventListener('click', e => { if (e.target.tagName === 'A') return; navigator.clipboard.writeText(m.body).then(() => toast('Copied')); });
    thread.appendChild(b);
  }
  function setTyping(on) {
    let dots = document.getElementById('typing');
    if (on && !dots) { dots = document.createElement('div'); dots.id = 'typing'; dots.className = 'typing'; dots.innerHTML = '<i></i><i></i><i></i>'; thread.appendChild(dots); }
    if (!on && dots) dots.remove();
    if (on) thread.appendChild(dots);
  }

  async function poll() {
    clearTimeout(timer);
    try {
      const r = await fetch('/imessage/messages?after=' + lastId, { headers: headers() });
      if (r.status === 401) return gate('Sign in to use the test line.<br><a href="/login?return=%2Fimessage">Sign in</a>');
      if (r.status === 403) return gate('The text line is in private testing.');
      const d = await r.json();
      setTyping(false);
      const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
      // The greeting shows once, on an empty conversation (it was re-added on every poll).
      if (!lastId && !d.messages.length && !thread.querySelector('.b')) add({ direction: 'out', body: 'Text me a job link and I\'ll write your application kit. Text "help" for everything else.' });
      for (const m of d.messages) { add(m); lastId = m.id; }
      setTyping(d.typing);
      bar.hidden = false; resetBtn.hidden = false;
      if (atBottom || d.messages.length) thread.scrollTop = thread.scrollHeight;
      if (d.typing || d.messages.length) busyUntil = Date.now() + 4000;
    } catch { /* offline: try again on the next tick */ }
    timer = setTimeout(poll, Date.now() < busyUntil ? 700 : 3000);
  }

  let voiceNote = false, voiceSeconds = 0;
  bar.addEventListener('submit', async e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const voice = voiceNote, seconds = voiceSeconds; voiceNote = false; voiceSeconds = 0;
    input.value = ''; sendBtn.disabled = true;
    const r = await fetch('/imessage/send', { method: 'POST', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ text, voice, seconds }) }).catch(() => null);
    sendBtn.disabled = false;
    if (!r || r.status >= 400) { input.value = text; toast('Not sent. Try again.'); return; }
    busyUntil = Date.now() + 4000;
    poll();
  });
  // Tap to talk: the browser transcribes as you speak (as the extension does),
  // and tapping again sends it as a voice note. On the real line, iMessage
  // voice notes arrive as audio and are transcribed on the server instead.
  const mic = document.getElementById('mic');
  let rec = null;
  mic.addEventListener('click', () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('Voice needs Safari or Chrome'); return; }
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US';
    const startedAt = Date.now();
    let said = '';
    rec.onresult = ev => { said = ''; for (let i = 0; i < ev.results.length; i++) said += ev.results[i][0].transcript; input.value = said; };
    rec.onerror = ev => { toast(ev.error === 'not-allowed' ? 'Allow the microphone to talk' : 'Could not hear that'); };
    rec.onend = () => {
      rec = null; mic.classList.remove('on'); mic.textContent = '🎤';
      if (input.value.trim()) { voiceNote = true; voiceSeconds = Math.round((Date.now() - startedAt) / 1000); bar.requestSubmit(); }
    };
    input.value = ''; rec.start(); mic.classList.add('on'); mic.textContent = '■';
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); bar.requestSubmit(); } });
  resetBtn.addEventListener('click', async () => {
    if (!window.confirm('Clear this conversation and your saved kits, so the next job link is written from scratch? Your profile, saved answers and pipeline stay.')) return;
    await fetch('/imessage/reset', { method: 'POST', headers: headers() });
    thread.innerHTML = ''; lastId = 0; poll();
  });

  if (!session) gate('Sign in to use the test line.<br><a href="/login?return=%2Fimessage">Sign in</a>');
  else poll();
})();
