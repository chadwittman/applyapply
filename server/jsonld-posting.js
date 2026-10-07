// Many career sites (iCIMS Jibe, for one: careers.docusign.com) render the
// posting in JavaScript but publish all of it as a schema.org JobPosting for
// search engines. Read that instead of the empty shell.
const { decodeEntities } = require('./gem-posting');

const typographic = { rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c', ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', bull: '\u2022' };
const plain = html => decodeEntities(String(html || '').replace(/&(rsquo|lsquo|rdquo|ldquo|ndash|mdash|hellip|bull);/gi, (_, k) => typographic[k.toLowerCase()])
  .replace(/<\/(p|li|h\d|div|ul|ol)>|<br\s*\/?>/gi, '\n')
  .replace(/<li\b[^>]*>/gi, '- ')
  .replace(/<[^>]+>/g, ' '))
  .replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n+(?=- )/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// Placeholder values some platforms fill unknown fields with.
const known = v => (typeof v === 'string' && v.trim() && !/^(unavailable|n\/a|null|undefined)$/i.test(v.trim())) ? v.trim() : '';

function findPosting(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) { for (const n of node) { const hit = findPosting(n); if (hit) return hit; } return null; }
  const type = [].concat(node['@type'] || []);
  if (type.some(t => /^JobPosting$/i.test(t))) return node;
  return findPosting(node['@graph']);
}

function place(locations) {
  return [].concat(locations || []).map(l => {
    const a = l?.address || {};
    return [a.streetAddress, a.addressLocality, a.addressRegion, a.addressCountry].map(known).filter(Boolean).join(', ');
  }).filter(Boolean).join('; ');
}

function jsonLdPostingText(html) {
  for (const [, raw] of String(html).matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(raw.trim()); } catch { continue; }
    const job = findPosting(data);
    if (!job) continue;
    const sections = [
      plain(job.description),
      known(job.responsibilities) && `Responsibilities:\n${plain(job.responsibilities)}`,
      known(job.qualifications) && `Qualifications:\n${plain(job.qualifications)}`,
      known(job.skills) && `Skills:\n${plain(job.skills)}`,
    ].filter(Boolean);
    const body = sections.join('\n\n');
    if (body.length <= 200) continue;
    const remote = /TELECOMMUTE/i.test(job.jobLocationType || '') ? 'Remote' : '';
    const location = [remote, place(job.jobLocation)].filter(Boolean).join('; ');
    const company = known(job.hiringOrganization?.name);
    return [
      `Job title: ${known(job.title) || 'not stated'}`,
      company && `Company: ${company}`,
      `Location: ${location || 'not stated'}`,
    ].filter(Boolean).join('\n').concat('\n\n', body).slice(0, 12000);
  }
  return null;
}

module.exports = { jsonLdPostingText };
