// Link preview images.
//
// A kit link sent over iMessage is the whole product for someone on a phone,
// and Messages renders it as a card. Shipping one static image for every link
// wastes that: the card can say which job it is and what is waiting, before
// the person taps anything. So each kit gets its own image, drawn as SVG and
// rasterised here.
//
// Fonts are bundled rather than taken from the system, because the container
// this runs in has none, and missing fonts render as nothing at all.
const path = require('path');
const fs = require('fs');

const FONT_DIR = path.join(__dirname, 'assets');
const FONTS = ['Inter-Regular.ttf', 'Inter-Bold.ttf'].map(f => path.join(FONT_DIR, f)).filter(f => fs.existsSync(f));

let Resvg = null;
try { ({ Resvg } = require('@resvg/resvg-js')); } catch { /* rendering is optional; the static card stands in */ }

const available = () => Boolean(Resvg && FONTS.length);

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Inter at a given size, measured roughly by character width. Good enough to
// decide where a line breaks; nothing here needs typesetting.
const widthOf = (text, size) => String(text).length * size * 0.54;

function wrap(text, size, maxWidth, maxLines) {
  const limit = Math.max(2, Math.floor(maxWidth / (size * 0.54)));
  const words = String(text || '').split(/\s+/).filter(Boolean).map(w => w.length > limit ? w.slice(0, limit - 1) + '…' : w);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? line + ' ' + word : word;
    if (widthOf(next, size) > maxWidth && line) { lines.push(line); line = word; } else { line = next; }
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (!lines.length) return [];
  // Anything that did not fit is signalled on the last line rather than
  // silently dropped.
  const used = lines.join(' ').split(/\s+/).length;
  if (used < words.length) lines[lines.length - 1] = lines[lines.length - 1].replace(/[,.;:]?$/, '') + '…';
  return lines;
}

function kitSvg({ company, role, location, match, fit, pieces = [], badge = 'application ready' }) {
  const W = 1200, H = 630;
  const roleLines = wrap(String(role || 'your application kit').toLowerCase().replace(/[\u2014\u2013]/g, ', '), 68, 900, 2);
  const roleY = 250 - (roleLines.length - 1) * 40;
  const pct = match != null && match !== '' && Number.isFinite(Number(match)) ? Math.round(Number(match)) : null;
  const companyLine = String(company || '').toLowerCase().replace(/[\u2014\u2013]/g, ', ');
  const locationLine = String(location || '').toLowerCase().replace(/[\u2014\u2013]/g, ', ');
  const fitNumber = fit != null && fit !== '' && Number.isFinite(Number(fit)) ? Math.max(0, Math.min(10, Number(fit))) : null;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#000000"/>
  <rect x="0" y="0" width="${W}" height="6" fill="#ffffff"/>
  <text x="72" y="104" font-family="Inter" font-weight="700" font-size="30" fill="#ffffff" letter-spacing="-0.5">applyapply</text>
  <text x="1128" y="103" text-anchor="end" font-family="Inter" font-weight="700" font-size="24" fill="#4ade80">${esc(badge)}</text>
  ${roleLines.map((l, i) => `<text x="72" y="${roleY + i * 80}" font-family="Inter" font-weight="700" font-size="68" fill="#ffffff" letter-spacing="-2">${esc(l)}</text>`).join('\n  ')}
  <text x="72" y="${roleY + roleLines.length * 80 + 20}" font-family="Inter" font-weight="700" font-size="38" fill="#ffffff">${esc(wrap(companyLine, 38, 1000, 1)[0] || '')}</text>
  <text x="72" y="${roleY + roleLines.length * 80 + 64}" font-family="Inter" font-size="28" fill="#9a9a9a">${esc(wrap(locationLine, 28, 1000, 1)[0] || '')}</text>
  ${fitNumber !== null ? `<text x="${W - 72}" y="432" text-anchor="end" font-family="Inter" font-weight="700" font-size="28" fill="#4ade80">fit ${fitNumber}/10</text>` : ''}
  ${pct !== null ? `<text x="72" y="432" font-family="Inter" font-size="26" fill="#4ade80">${pct}% resume coverage</text>` : ''}
  <line x1="72" y1="486" x2="${W - 72}" y2="486" stroke="#1e1e1e" stroke-width="2"/>
  <text x="72" y="546" font-family="Inter" font-size="30" fill="#e5e5e5">${esc(pieces.slice(0, 4).join('   ·   ').slice(0, 74).toLowerCase())}</text>
</svg>`;
}

function render(svg) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
    font: { loadSystemFonts: false, fontFiles: FONTS, defaultFontFamily: 'Inter' },
  });
  return resvg.render().asPng();
}

// What is waiting in the kit, named rather than counted.
function piecesFor(kit) {
  const t = kit?.tailored || {};
  const answered = (t.qa || []).filter(q => q.a).length;
  return [
    kit?.tailored_resume ? 'Tailored resume' : null,
    t.cover_note ? 'Cover note' : null,
    answered ? `${answered} answer${answered === 1 ? '' : 's'}` : null,
    kit?.tailored_resume ? 'PDFs' : null,
  ].filter(Boolean);
}

function kitCard(kit) {
  if (!available()) return null;
  const score = kit?.tailored_resume?.jev_match?.score;
  return render(kitSvg({
    company: kit?.company, role: kit?.role,
    location: kit?.tailored?.location || '',
    match: score != null && score !== '' && Number.isFinite(Number(score)) ? (Number(score) / 5) * 100 : null,
    pieces: piecesFor(kit),
  }));
}

function jobCard(job) {
  return available() ? render(kitSvg({ ...job, role: job.role || 'explore this role', badge: 'role to explore',
    fit: job.fit_score,
    pieces: ['view posting', 'you choose what happens next'] })) : null;
}

// Attach the same useful card directly, independent of automatic link unfurling.
// Only these explicit message kinds may expose their existing share-token image.
module.exports = { kitCard, jobCard, kitSvg, render, available, wrap, piecesFor };
