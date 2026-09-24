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
  const words = String(text || '').split(/\s+/).filter(Boolean);
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

function kitSvg({ company, role, location, match, pieces = [] }) {
  const W = 1200, H = 630;
  const roleLines = wrap(role || 'Your application kit', 68, 900, 2);
  const roleY = 250 - (roleLines.length - 1) * 40;
  const pct = Number.isFinite(Number(match)) ? Math.round(Number(match)) : null;
  const sub = [company, location].filter(Boolean).join('  ·  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#000000"/>
  <rect x="0" y="0" width="${W}" height="6" fill="#ffffff"/>
  <text x="72" y="104" font-family="Inter" font-weight="700" font-size="30" fill="#ffffff" letter-spacing="-0.5">applyapply</text>
  ${pct !== null ? `<g>
    <rect x="${W - 72 - 196}" y="72" width="196" height="46" rx="23" fill="#0d1a0d" stroke="#2a3a2a"/>
    <text x="${W - 72 - 98}" y="103" text-anchor="middle" font-family="Inter" font-weight="700" font-size="22" fill="#4ade80">${pct}% match</text>
  </g>` : ''}
  ${roleLines.map((l, i) => `<text x="72" y="${roleY + i * 80}" font-family="Inter" font-weight="700" font-size="68" fill="#ffffff" letter-spacing="-2">${esc(l)}</text>`).join('\n  ')}
  <text x="72" y="${roleY + roleLines.length * 80 + 18}" font-family="Inter" font-size="34" fill="#9a9a9a">${esc(sub.slice(0, 64))}</text>
  <line x1="72" y1="486" x2="${W - 72}" y2="486" stroke="#1e1e1e" stroke-width="2"/>
  <text x="72" y="546" font-family="Inter" font-size="30" fill="#e5e5e5">${esc(pieces.slice(0, 4).join('   ·   ').slice(0, 74))}</text>
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
    match: Number.isFinite(Number(score)) ? (Number(score) / 5) * 100 : null,
    pieces: piecesFor(kit),
  }));
}

module.exports = { kitCard, kitSvg, render, available, wrap, piecesFor };
