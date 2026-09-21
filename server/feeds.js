// Public job feeds that need no browser. Each fetcher returns listings in one
// shape: { url, company, role, location, remote, posted_at, salary, snippet }.
// posted_at is an ISO timestamp from the feed itself, so windows are exact.
//
// Terms: Himalayas and We Work Remotely ask that jobs link back to them, which
// they do (each url is the listing on their site). Remotive's public API was
// tried and dropped: it now returns only a handful of jobs (2026-09-21).
const UA = 'applyapply.xyz job ingest (+https://applyapply.xyz/support)';
const DAY = 86400000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function getJSON(url) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
    if (r.status === 429 && attempt < 4) { await sleep(Number(r.headers.get('retry-after')) * 1000 || 5000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}`);
    return r.json();
  }
}
async function getText(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}`);
  return r.text();
}
const iso = value => { const t = typeof value === 'number' ? value * 1000 : Date.parse(value); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const text = html => String(html || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/g, '/').replace(/\s+/g, ' ').trim();

// Himalayas pages newest first, 20 at a time; stop at the window or a cap.
async function himalayas(since) {
  const out = [];
  for (let offset = 0; offset < 1200; offset += 20) {
    if (offset) await sleep(1500); // Himalayas rate-limits quick paging
    const d = await getJSON(`https://himalayas.app/jobs/api?limit=20&offset=${offset}`);
    const jobs = d.jobs || [];
    for (const j of jobs) out.push({
      url: j.applicationLink || j.guid, company: j.companyName, role: j.title,
      location: (j.locationRestrictions || []).join(', ') || 'Remote', remote: true, posted_at: iso(j.pubDate),
      salary: j.minSalary ? { min: j.minSalary, max: j.maxSalary, currency: j.currency, period: j.salaryPeriod } : null,
      snippet: text(j.excerpt || j.description).slice(0, 600),
    });
    const oldest = Math.min(...jobs.map(j => (j.pubDate || 0) * 1000));
    if (jobs.length < 20 || (since && oldest < since)) break;
  }
  return out;
}

async function weWorkRemotely() {
  const xml = await getText('https://weworkremotely.com/remote-jobs.rss');
  const tag = (item, name) => text((item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)) || [])[1]).replace(/^<!\[CDATA\[|\]\]>$/g, '');
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => {
    const title = tag(item, 'title');
    const split = title.indexOf(': ');
    return { url: tag(item, 'link'), company: split > 0 ? title.slice(0, split) : '', role: split > 0 ? title.slice(split + 2) : title,
      location: tag(item, 'region') || 'Remote', remote: true, posted_at: iso(tag(item, 'pubDate')), salary: null, snippet: tag(item, 'description').slice(0, 600) };
  });
}

// Hacker News "Who is hiring": one comment per company, usually headed
// "Company | Role | Location | REMOTE | ...". The comment is the listing.
async function hackerNews() {
  const threads = await getJSON('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=6');
  const thread = (threads.hits || []).find(h => /who is hiring/i.test(h.title || ''));
  if (!thread) throw new Error('No current Who is hiring thread');
  const tree = await getJSON(`https://hn.algolia.com/api/v1/items/${thread.objectID}`);
  return (tree.children || []).filter(c => c.text && c.author).map(c => {
    const body = text(c.text);
    const head = body.split(/\s{2,}|\. /)[0].slice(0, 300);
    const parts = head.split('|').map(p => p.trim()).filter(Boolean);
    const role = parts.slice(1).find(p => /engineer|product|manager|head|director|lead|designer|developer|scientist|growth|marketing|sales|founding|\bvp\b|chief|analyst|operations|\bpm\b/i.test(p)) || parts[1] || head;
    return { url: `https://news.ycombinator.com/item?id=${c.id}`, company: (parts[0] || '').slice(0, 120), role: role.slice(0, 250),
      location: parts.find(p => /remote|onsite|hybrid|,/i.test(p)) || '', remote: /remote/i.test(head), posted_at: iso(c.created_at_i), salary: null, snippet: body.slice(0, 1200) };
  });
}

const FEEDS = {
  'Himalayas': { fetch: himalayas },
  'We Work Remotely': { fetch: weWorkRemotely },
  'Hacker News: Who is hiring': { fetch: hackerNews },
};

async function fetchFeed(name, { lookbackHours = 0 } = {}) {
  const feed = FEEDS[name];
  if (!feed) throw new Error('Unknown feed ' + name);
  const since = lookbackHours ? Date.now() - lookbackHours * 3600000 : Date.now() - 45 * DAY;
  const jobs = (await feed.fetch(since)).filter(j => j.url?.startsWith('http') && j.role);
  return jobs.filter(j => !j.posted_at || Date.parse(j.posted_at) >= since);
}

module.exports = { FEEDS, fetchFeed };
