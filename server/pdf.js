// Resume and cover-letter PDFs rendered on the server, so a kit link can hand
// a phone real files to attach. Layout follows the extension's resume PDF.
const path = require('path');
const { jsPDF } = require(path.join(__dirname, '../extension/vendor/jspdf.umd.min.js'));

const clean = s => String(s || '').replace(/[–—]/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function page() {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const M = 54, W = doc.internal.pageSize.getWidth() - M * 2, BOTTOM = doc.internal.pageSize.getHeight() - M;
  const state = { y: M + 6 };
  const room = n => { if (state.y + n > BOTTOM) { doc.addPage(); state.y = M; } };
  return { doc, M, W, state, room };
}

function header({ doc, M, W, state }, name, profile) {
  doc.setFont('times', 'bold'); doc.setFontSize(19);
  doc.text(clean(name), M, state.y); state.y += 16;
  const contact = [profile.email, profile.phone, profile.location, profile.linkedin].filter(Boolean).map(clean).join('  ·  ');
  if (contact) {
    doc.setFont('times', 'normal'); doc.setFontSize(9.5);
    for (const line of doc.splitTextToSize(contact, W)) { doc.text(line, M, state.y); state.y += 12; }
  }
  state.y += 10;
}

function resumePdf(resume, profile = {}) {
  const p = page(), { doc, M, W, state, room } = p;
  const name = resume.name || `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'Resume';
  header(p, name, profile);
  if (resume.summary) {
    doc.setFont('times', 'normal'); doc.setFontSize(10.5);
    for (const line of doc.splitTextToSize(clean(resume.summary), W)) { room(14); doc.text(line, M, state.y); state.y += 13; }
    state.y += 8;
  }
  for (const e of resume.experience || []) {
    room(46);
    doc.setFont('times', 'bold'); doc.setFontSize(11.5);
    doc.text(clean(e.company), M, state.y);
    doc.setFont('times', 'normal'); doc.setFontSize(9);
    doc.text(clean(e.dates), M + W, state.y, { align: 'right' });
    state.y += 4;
    doc.setDrawColor(210); doc.line(M, state.y, M + W, state.y); state.y += 12;
    doc.setFont('times', 'italic'); doc.setFontSize(10.5);
    doc.text(clean(e.title), M, state.y); state.y += 14;
    doc.setFont('times', 'normal');
    for (const b of e.bullets || []) {
      doc.splitTextToSize(clean(b), W - 14).forEach((line, i) => {
        room(14);
        if (i === 0) doc.text('•', M + 2, state.y);
        doc.text(line, M + 14, state.y);
        state.y += 13;
      });
      state.y += 2;
    }
    state.y += 8;
  }
  if (resume.skills?.length) {
    room(26);
    doc.setFont('times', 'bold'); doc.setFontSize(10);
    doc.text('SKILLS', M, state.y); state.y += 13;
    doc.setFont('times', 'normal');
    for (const line of doc.splitTextToSize(resume.skills.map(clean).join(' · '), W)) { room(13); doc.text(line, M, state.y); state.y += 12; }
  }
  return { buffer: Buffer.from(doc.output('arraybuffer')), filename: `${slug(name)}-resume-${slug(resume.company || '')}`.replace(/-$/, '') + '.pdf' };
}

function letterPdf(text, profile = {}, company = '') {
  const p = page(), { doc, M, W, state, room } = p;
  const name = `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'Cover letter';
  header(p, name, profile);
  doc.setFont('times', 'normal'); doc.setFontSize(11);
  for (const para of clean(text).split(/\n\s*\n/)) {
    for (const line of doc.splitTextToSize(para.replace(/\n/g, ' '), W)) { room(15); doc.text(line, M, state.y); state.y += 15; }
    state.y += 9;
  }
  return { buffer: Buffer.from(doc.output('arraybuffer')), filename: `${slug(name)}-cover-letter-${slug(company)}`.replace(/-$/, '') + '.pdf' };
}

module.exports = { resumePdf, letterPdf };
