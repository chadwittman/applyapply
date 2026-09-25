const ZONES = { eastern: 'America/New_York', central: 'America/Chicago', mountain: 'America/Denver', pacific: 'America/Los_Angeles', utc: 'UTC' };

function parseUpdates(text) {
  const m = String(text).trim().match(/^(?:updates\s+)?(daily|weekdays|weekly)(?: updates)? at (\d{1,2})(am|pm)?\s+([a-z_/]+)$/i);
  if (!m) return null;
  let hour = Number(m[2]);
  if (m[3]) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (m[3].toLowerCase() === 'pm' ? 12 : 0);
  }
  const timezone = ZONES[m[4].toLowerCase()] || m[4];
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); } catch { return null; }
  if (hour < 8 || hour > 20) return null;
  return { enabled: true, frequency: m[1].toLowerCase(), hour, timezone };
}

function digestWindow(settings, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: settings.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(now).map(x => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const due = settings.enabled && Number(p.hour) === settings.hour && settings.last_sent !== date
    && (settings.frequency !== 'weekdays' || !['Sat', 'Sun'].includes(p.weekday))
    && (settings.frequency !== 'weekly' || p.weekday === 'Mon');
  return due ? date : null;
}

module.exports = { parseUpdates, digestWindow };
