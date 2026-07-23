#!/usr/bin/env node
// Open unreviewed sourced jobs as Chrome tabs
// Usage: node open-new.js [--tier 1] [--limit 10] [--all]

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SOURCED = path.join(__dirname, 'sourced-jobs.json');

const args = process.argv.slice(2);
const tierFilter = args.includes('--tier') ? parseInt(args[args.indexOf('--tier') + 1]) : null;
const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null;
const includeReviewed = args.includes('--all');

const jobs = JSON.parse(fs.readFileSync(SOURCED, 'utf-8'));

let targets = jobs
  .filter(j => includeReviewed ? j.status !== 'applied' : j.status === 'new')
  .filter(j => tierFilter ? j.tier === tierFilter : true)
  .sort((a, b) => (b.fit_score || 0) - (a.fit_score || 0));

if (limit) targets = targets.slice(0, limit);

if (!targets.length) {
  console.log('No matching jobs to open.');
  process.exit(0);
}

console.log(`Opening ${targets.length} tabs:\n`);
for (const j of targets) {
  const salary = j.salary ? `  $${Number(j.salary).toLocaleString()}` : '';
  console.log(`  [${j.fit_score}/10] ${j.company} — ${j.role}${salary}`);
  console.log(`         ${j.url}`);
  execSync(`open -a "Google Chrome" "${j.url}"`);
}
console.log(`\nDone.`);
