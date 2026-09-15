#!/usr/bin/env node
// Guards against a bug class that has broken this server three times.
//
// Pages are built with res.send(`...`), so the browser-side JS inside them is
// first evaluated as a template literal by Node. An escape written for the
// browser gets consumed there instead: `lines.join('\n')` ships as a literal
// newline inside a string, which is an unterminated string in the browser and
// takes the whole <script> block down with it. It is invisible in review and
// `node --check server.js` cannot see it, because to Node it is just a string.
//
// Anything meant to reach the browser as a backslash escape must be doubled.
// Run: node server/check-templates.js

const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, 'server.js');
const lines = fs.readFileSync(file, 'utf8').split('\n');

// Locate each res.send(`…`) page body.
const ranges = [];
let open = null;
lines.forEach((l, i) => {
  if (open === null && /res\.send\(`/.test(l)) open = i;
  else if (open !== null && /`\s*\);\s*$/.test(l)) { ranges.push([open, i]); open = null; }
});

// Escapes the template literal will consume before the browser ever sees them.
// \$ and \` are excluded: those are deliberate and correct inside a template.
const EATEN = "ntrbfv0'\"";

// Only the literal text of a template is at risk. Inside a ${...} expression
// Node evaluates the escape as ordinary JS, which is what the author intended,
// so those spans must be skipped or the check is all false positives.
const findings = [];
for (const [a, b] of ranges) {
  let depth = 0; // brace depth inside a ${ } expression, 0 = literal text
  for (let i = a; i <= b; i++) {
    const line = lines[i];
    for (let c = 0; c < line.length; c++) {
      if (depth === 0 && line[c] === '$' && line[c + 1] === '{') { depth = 1; c++; continue; }
      if (depth > 0) {
        if (line[c] === '{') depth++;
        else if (line[c] === '}') depth--;
        continue;
      }
      if (line[c] !== '\\') continue;
      // An even run of backslashes is already escaped and survives.
      let n = 0, j = c;
      while (j >= 0 && line[j] === '\\') { n++; j--; }
      if (n % 2 === 1 && EATEN.includes(line[c + 1])) {
        findings.push({ line: i + 1, esc: '\\' + line[c + 1], text: line.trim().slice(0, 110) });
      }
      c++; // skip the escaped char
    }
  }
}

if (!findings.length) {
  console.log(`✓ ${ranges.length} page templates clean`);
  process.exit(0);
}

console.error(`✗ ${findings.length} escape(s) will be consumed before reaching the browser:\n`);
for (const f of findings) {
  console.error(`  ${file}:${f.line}  ${JSON.stringify(f.esc)} should be ${JSON.stringify('\\' + f.esc)}`);
  console.error(`    ${f.text}\n`);
}
process.exit(1);
