// The real text line. Sendblue sends and receives iMessage (falling back to
// SMS), which is why the experience can carry links that unfurl into cards.
//
// Everything about the conversation itself lives in conversation.js; this file
// only moves messages in and out, and decides which account a number belongs
// to. That decision is the security-sensitive one: the From field of a message
// is not proof of anything, so a number reaches an account only after somebody
// signed in on the web and confirmed it.
const configured = () => Boolean(process.env.SENDBLUE_API_KEY && process.env.SENDBLUE_API_SECRET);

const base = () => String(process.env.SENDBLUE_API_BASE || 'https://api.sendblue.co/api').replace(/\/$/, '');

// E.164, or nothing. A number we cannot normalise is a number we will not
// match against an account.
function normalizePhone(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
  const bare = digits.replace(/\D/g, '');
  if (bare.length === 10) return '+1' + bare;                 // a US number typed without its country code
  if (bare.length === 11 && bare.startsWith('1')) return '+' + bare;
  return null;
}

async function send(to, body, { mediaUrl = null, timeout = 15000 } = {}) {
  const number = normalizePhone(to);
  if (!configured()) throw new Error('Sendblue is not configured');
  if (!number) throw new Error('Not a phone number: ' + to);
  const payload = {
    number,
    content: String(body || '').slice(0, 4000),
    ...(process.env.SENDBLUE_FROM_NUMBER ? { from_number: normalizePhone(process.env.SENDBLUE_FROM_NUMBER) } : {}),
    ...(mediaUrl ? { media_url: mediaUrl } : {}),
  };
  const res = await fetch(base() + '/send-message', {
    method: 'POST',
    headers: {
      'sb-api-key-id': process.env.SENDBLUE_API_KEY,
      'sb-api-secret-key': process.env.SENDBLUE_API_SECRET,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Sendblue ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return { ok: true }; }
}

// Sendblue posts inbound messages as JSON. Field names have varied across
// their API versions, so read the ones that mean the same thing.
function parseInbound(body) {
  const b = body || {};
  const from = normalizePhone(b.from_number ?? b.number ?? b.phone ?? b.fromNumber);
  const content = String(b.content ?? b.message ?? b.body ?? '').trim();
  const media = b.media_url || b.mediaUrl || null;
  const isOutbound = String(b.is_outbound ?? b.isOutbound ?? '').toLowerCase() === 'true' || b.is_outbound === true;
  return { from, content, media, isOutbound };
}

// Carrier rules, and simple decency: these are answered before anything else
// and never cost a credit.
const STOP = /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i;
const START = /^\s*(start|unstop|resume)\s*$/i;
const HELP = /^\s*help\s*$/i;

module.exports = { configured, send, parseInbound, normalizePhone, STOP, START, HELP };
