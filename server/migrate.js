#!/usr/bin/env node
// One-time migration: sourced-jobs.json + applied-log.json + source-runs.json → jobs.db
const fs = require('fs');
const path = require('path');
const { getDb, insertRun, upsertJob, setJobStatus } = require('./db');

const BASE = path.join(__dirname, '..');
const LOGS = path.join(BASE, 'logs');

function readJSON(p, fallback = []) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return fallback; }
}

const db = getDb();
let runCount = 0, jobCount = 0, appliedCount = 0;

// ── Import runs ───────────────────────────────────────────────────────────────
const runs = readJSON(path.join(LOGS, 'source-runs.json'));
for (let i = 0; i < runs.length; i++) {
  const r = runs[i];
  const id = `${r.date}-${String(i).padStart(3, '0')}`;
  insertRun({
    id,
    date: r.date,
    run_at: r.date + 'T00:00:00.000Z',
    sources: 0,
    found: r.new_leads || 0,
    added: r.new_leads || 0,
    excluded: r.excluded || 0,
    duration_ms: 0,
  });
  runCount++;
}
console.log(`Imported ${runCount} runs`);

// ── Import sourced jobs ───────────────────────────────────────────────────────
const applied = readJSON(path.join(BASE, 'applied-log.json'));
const appliedUrls = new Set(applied.map(a => a.url));

const jobs = readJSON(path.join(BASE, 'sourced-jobs.json'));
const usedIds = new Set();
for (const j of jobs) {
  let slug = (j.id || `${j.company}-${j.role}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (usedIds.has(slug)) slug = slug + '-' + Buffer.from(j.url).toString('base64').slice(0, 6);
  usedIds.add(slug);
  upsertJob({
    id: slug,
    url: j.url,
    company: j.company,
    role: j.role,
    ats: j.ats || null,
    source: j.source || null,
    run_id: null,
    found_at: j.sourced_date || new Date().toISOString().slice(0, 10),
    status: appliedUrls.has(j.url) ? 'applied' : (j.status || 'new'),
    tier: j.tier || null,
    fit_score: j.fit_score || null,
    location: j.location || null,
    notes: j.notes || '',
  });
  jobCount++;
}
console.log(`Imported ${jobCount} sourced jobs`);

// ── Import applied jobs not already in sourced ────────────────────────────────
const existing = new Set(db.prepare('SELECT url FROM jobs').all().map(r => r.url));
for (const a of applied) {
  if (existing.has(a.url)) {
    // Already imported — just make sure status is applied
    setJobStatus(a.url, 'applied', { applied_at: a.applied_at });
    appliedCount++;
    continue;
  }
  const slug = (a.appId || `${a.company}-${a.role}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  upsertJob({
    id: slug,
    url: a.url,
    company: a.company,
    role: a.role,
    ats: null,
    source: null,
    run_id: null,
    found_at: a.applied_at || new Date().toISOString().slice(0, 10),
    status: 'applied',
    tier: null,
    fit_score: null,
    location: null,
    notes: '',
  });
  setJobStatus(a.url, 'applied', { applied_at: a.applied_at });
  appliedCount++;
}
console.log(`Applied status set for ${appliedCount} jobs`);

// ── Summary ───────────────────────────────────────────────────────────────────
const counts = db.prepare('SELECT status, COUNT(*) as n FROM jobs GROUP BY status').all();
console.log('\nDB status counts:');
for (const c of counts) console.log(`  ${c.status}: ${c.n}`);
console.log(`\nTotal jobs in DB: ${db.prepare('SELECT COUNT(*) as n FROM jobs').get().n}`);
