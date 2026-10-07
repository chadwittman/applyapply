// Gem's public pages render in JavaScript, but publish the complete posting
// in their description metadata for crawlers. Read that instead of the shell.
function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, key) => {
    if (key[0] !== '#') return named[key.toLowerCase()] || entity;
    const point = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : entity;
  });
}

function gemPostingText(html) {
  const metadata = new Map();
  for (const tag of String(html).match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) || []) {
    const attributes = new Map();
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attributes.set(match[1].toLowerCase(), decodeEntities(match[2] ?? match[3]));
    }
    const key = attributes.get('property') || attributes.get('name');
    if (key) metadata.set(key.toLowerCase(), attributes.get('content') || '');
  }
  const body = metadata.get('description') || metadata.get('og:description') || '';
  // Short social summaries and unavailable-job shells are not a posting.
  if (body.trim().length <= 200 || !/responsibilit|requirements|qualificat|what you.ll do|role summary/i.test(body)) return null;
  const title = metadata.get('og:title') || metadata.get('twitter:title') || '';
  return `${title ? `Job title: ${title}\n\n` : ''}${body}`.slice(0, 12000);
}

module.exports = { gemPostingText, decodeEntities };
