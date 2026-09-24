// The voice file is what applyapply may claim about itself. It is read by a
// model when somebody asks something the command list does not cover, so what
// is in it reaches real people.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const voice = fs.readFileSync(path.join(__dirname, '../server/voice.md'), 'utf8');

// The rules it sets for itself, it keeps.
assert.ok(!voice.includes('—'), 'the file that bans em dashes contains none');
for (const claim of ['never do', 'Submit an application', 'Invent a fact', '$10 buys 1,000 credits']) {
  assert.ok(voice.includes(claim), 'the voice file states: ' + claim);
}
// Prices in the file match what the product charges. Read from the source
// rather than an import, because server.js starts a server when required.
const source = fs.readFileSync(path.join(__dirname, '../server/server.js'), 'utf8');
const block = source.match(/const CREDIT_COSTS = \{([\s\S]*?)\}/)[1];
const cost = name => Number(block.match(new RegExp(name + ':\\s*(\\d+)'))[1]);
assert.equal(cost('generate'), 10);
assert.ok(voice.includes(`kit costs ${cost('generate')} of them`), `the kit price in the voice file is ${cost('generate')}`);
assert.ok(voice.includes(`rewrite costs ${cost('resume')}`), `the rewrite price in the voice file is ${cost('resume')}`);
console.log('PASS: the voice file says what the product actually does and charges');
