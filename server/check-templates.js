#!/usr/bin/env node
// Guards against a bug class that has shipped four times.
//
// Pages are built with res.send(`...`), so browser-side JS inside them is first
// evaluated as a template literal by Node. An escape written for the browser is
// consumed there instead: `split('\n')` ships as a literal newline inside a
// string, which is an unterminated string in the browser and takes the whole
// <script> block down with it. `node --check server.js` cannot see it, because
// to Node the page body is just a string.
//
// Anything meant to reach the browser as a backslash escape must be doubled.
//
// Run: node server/check-templates.js [file]
//      node server/check-templates.js --self-test

const fs = require('fs');
const path = require('path');

// Escapes the template literal consumes. \$ and \` are excluded: those are
// deliberate and correct inside a template.
const EATEN = new Set(['n', 't', 'r', 'b', 'f', 'v', '0', "'", '"']);

// Walks a template body tracking which parts are literal text and which are
// ${...} expressions. An earlier version counted braces only, so a `{` inside a
// JS string ran the depth up and everything after it was skipped as though it
// were an expression — which is how the bug this exists to catch got through.
function scanTemplate(body, startLine) {
  const findings = [];
  let line = startLine;
  let depth = 0;           // ${ } nesting; 0 means literal template text
  let i = 0;

  const stack = [];        // what we are inside: str/tmpl/regex/comment
  while (i < body.length) {
    const c = body[i];
    const next = body[i + 1];
    if (c === '\n') { line++; i++; continue; }

    const top = stack[stack.length - 1];

    if (top === 'line-comment') { if (c === '\n') stack.pop(); i++; continue; }
    if (top === 'block-comment') { if (c === '*' && next === '/') { stack.pop(); i += 2; continue; } i++; continue; }

    if (top === 'single' || top === 'double' || top === 'regex') {
      if (c === '\\') { i += 2; continue; }
      const closer = top === 'single' ? "'" : top === 'double' ? '"' : '/';
      if (c === closer) stack.pop();
      i++;
      continue;
    }

    if (top === 'inner-template') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); i++; continue; }
      if (c === '$' && next === '{') { depth++; stack.push('inner-expr'); i += 2; continue; }
      i++;
      continue;
    }

    // Inside a ${ } expression (or a nested one)
    if (depth > 0) {
      if (c === '"') { stack.push('double'); i++; continue; }
      if (c === "'") { stack.push('single'); i++; continue; }
      if (c === '`') { stack.push('inner-template'); i++; continue; }
      if (c === '/' && next === '/') { stack.push('line-comment'); i += 2; continue; }
      if (c === '/' && next === '*') { stack.push('block-comment'); i += 2; continue; }
      if (c === '{') { depth++; i++; continue; }
      if (c === '}') {
        depth--;
        if (stack[stack.length - 1] === 'inner-expr') stack.pop();
        i++;
        continue;
      }
      i++;
      continue;
    }

    // Literal template text — the only place an escape gets consumed.
    if (c === '`') return { findings, end: i, line };  // template actually ends here
    if (c === '$' && next === '{') { depth++; i += 2; continue; }
    if (c === '\\') {
      const esc = next;
      if (esc === '\\') { i += 2; continue; }   // already doubled: survives
      if (EATEN.has(esc)) findings.push({ line, esc: '\\' + esc });
      i += 2;
      continue;
    }
    i++;
  }
  return { findings, end: body.length, line };
}

// Finds each res.send(`...`) by scanning for its matching backtick rather than
// guessing from line shape. A line-based closer regex ended the biggest
// template 400 lines early on `document.querySelector(\`...\`);` — which looks
// exactly like the end of a res.send — so everything after it went unchecked,
// and that is where the escape bug this tool exists to catch was hiding.
function checkFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  const OPEN = 'res.send(`';
  let findings = [];
  let count = 0;
  let idx = 0;
  let line = 1 + (src.slice(0, 0).match(/\n/g) || []).length;
  let cursor = 0;

  while ((idx = src.indexOf(OPEN, cursor)) !== -1) {
    line += (src.slice(cursor, idx).match(/\n/g) || []).length;
    const bodyStart = idx + OPEN.length;
    const res = scanTemplate(src.slice(bodyStart), line);
    findings = findings.concat(res.findings);
    count++;
    cursor = bodyStart + res.end + 1;
    line = res.line;
  }
  return { ranges: new Array(count), findings };
}

function selfTest() {
  const tmp = path.join(require('os').tmpdir(), 'tmpl-selftest.js');
  const cases = [
    // [name, body, shouldFlag]
    ['bare \\n in literal text', "app.get('/x', (q,res) => {\n  res.send(`<script>var a='x'.split('\\n');</script>\n`);\n});", true],
    ['doubled \\\\n is fine', "app.get('/x', (q,res) => {\n  res.send(`<script>var a='x'.split('\\\\n');</script>\n`);\n});", false],
    ['\\n inside ${} is fine', "app.get('/x', (q,res) => {\n  res.send(`<div>${items.join('\\n')}</div>\n`);\n});", false],
    ['brace inside a string must not blind the scanner',
     "app.get('/x', (q,res) => {\n  res.send(`<script>var s='{';var a='y'.split('\\n');</script>\n`);\n});", true],
    ['escaped quote in literal text', "app.get('/x', (q,res) => {\n  res.send(`<script>var s='it\\'s';</script>\n`);\n});", true],
    // The regression that let the real bug through: an escaped inner template
    // ending in `); looks like the end of a res.send, so a line-based closer
    // ended the template early and skipped everything after it.
    ['inner template ending in `); must not end the scan',
     "app.get('/x', (q,res) => {\n  res.send(`<script>\n  var el=document.querySelector(\\`[id^=\"a\"]\\`);\n  var b='y'.split('\\n');\n</script>\n`);\n});", true],
  ];
  let pass = 0;
  for (const [name, body, shouldFlag] of cases) {
    fs.writeFileSync(tmp, body);
    const { findings } = checkFile(tmp);
    const ok = (findings.length > 0) === shouldFlag;
    console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `  (expected ${shouldFlag ? 'flag' : 'clean'}, got ${findings.length} finding(s))`}`);
    if (ok) pass++;
  }
  fs.unlinkSync(tmp);
  console.log(`self-test: ${pass}/${cases.length} passed`);
  return pass === cases.length;
}

if (process.argv.includes('--self-test')) {
  process.exit(selfTest() ? 0 : 1);
}

const file = process.argv[2] || path.join(__dirname, 'server.js');
const { ranges, findings } = checkFile(file);

if (!findings.length) {
  console.log(`✓ ${ranges.length} page templates clean`);
  process.exit(0);
}

console.error(`✗ ${findings.length} escape(s) will be consumed before reaching the browser:\n`);
for (const f of findings) {
  console.error(`  ${file}:${f.line}  ${JSON.stringify(f.esc)} should be ${JSON.stringify('\\' + f.esc)}`);
}
console.error('\nDouble the backslash so the browser receives the escape.');
process.exit(1);
