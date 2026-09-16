const crypto = require('crypto');

function canonicalUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw Object.assign(new Error('A valid job URL is required'), { status: 400 }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw Object.assign(new Error('Use an HTTP or HTTPS job URL without credentials'), { status: 400 });
  }
  url.hash = '';
  const host = url.hostname.toLowerCase();
  if (['boards.greenhouse.io', 'jobs.greenhouse.io'].includes(host)) url.hostname = 'job-boards.greenhouse.io';
  if (['jobs.lever.co', 'jobs.eu.lever.co', 'jobs.ashbyhq.com', 'job-boards.greenhouse.io', 'boards.greenhouse.io', 'jobs.greenhouse.io'].includes(host)) {
    url.pathname = url.pathname.replace(/\/(apply|application)\/?$/, '').replace(/\/$/, '');
  }
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|gh_src$|lever-source$|lever-origin$|source$|ref$|referrer$)/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}

function ownedId(kind, owner, url) {
  if (!owner) throw new Error('An owner is required');
  return `${kind}_${crypto.createHash('sha256').update(JSON.stringify([owner, canonicalUrl(url)])).digest('hex')}`;
}

function requireOwner(owner) {
  if (typeof owner !== 'string' || !owner.trim()) throw new Error('An owner is required');
  return owner;
}

module.exports = { canonicalUrl, ownedId, requireOwner };
