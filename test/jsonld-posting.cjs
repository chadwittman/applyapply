const assert = require('node:assert/strict');
const { jsonLdPostingText } = require('../server/jsonld-posting');
// Shaped like careers.docusign.com (iCIMS Jibe): an Angular shell whose only
// copy of the posting is the JobPosting block, with UNAVAILABLE placeholders.
const job = {
  '@context': 'http://schema.org', '@type': 'JobPosting', title: 'Lead Site Reliability Engineer',
  description: '<h2>Company Overview</h2><p>Docusign brings agreements to life for people&rsquo;s businesses across 180 countries.</p><h2>What you&#39;ll do</h2><p>Lead major incidents end to end.</p>',
  responsibilities: '<ul><li><p>Command critical incidents across technology, products and security</p></li><li><p>Run post-incident reviews</p></li></ul>',
  qualifications: '<p><strong>Basic</strong></p><ul><li><p>12+ years of experience in Incident Management or Site Reliability Engineering</p></li></ul>',
  skills: 'UNAVAILABLE',
  hiringOrganization: { '@type': 'Organization', name: 'Docusign' },
  jobLocation: { '@type': 'Place', address: { streetAddress: 'Remote', addressLocality: 'UNAVAILABLE', addressRegion: 'UNAVAILABLE', addressCountry: 'United States' } },
};
const shell = body => `<html ng-app="jibeapply"><head><meta property="og:description" content="careers-home is hiring."><script type="application/ld+json">${body}</script></head><body><div>Skip to Main Content Back to Docusign.com</div></body></html>`;
const text = jsonLdPostingText(shell(JSON.stringify(job)));
assert.match(text, /^Job title: Lead Site Reliability Engineer\nCompany: Docusign\nLocation: Remote, United States\n\n/);
assert.match(text, /people’s businesses/);
assert.match(text, /What you'll do/);
assert.match(text, /Responsibilities:\n- Command critical incidents[^\n]*\n- Run post-incident reviews/);
assert.match(text, /Qualifications:\nBasic\n- 12\+ years/);
assert.ok(!/UNAVAILABLE|<|Skip to Main/.test(text));
// Found inside @graph and arrays, and with a remote location type.
const graph = jsonLdPostingText(shell(JSON.stringify({ '@graph': [{ '@type': 'Organization' }, { ...job, jobLocation: undefined, jobLocationType: 'TELECOMMUTE' }] })));
assert.match(graph, /Location: Remote\n/);
assert.ok(jsonLdPostingText(shell(JSON.stringify([{ '@type': 'WebSite' }, job]))));
// Broken JSON, other types and thin postings fall through to the page text.
assert.equal(jsonLdPostingText(shell('{not json')), null);
assert.equal(jsonLdPostingText(shell(JSON.stringify({ '@type': 'Organization', description: 'x'.repeat(500) }))), null);
assert.equal(jsonLdPostingText(shell(JSON.stringify({ '@type': 'JobPosting', title: 'Engineer', description: 'Apply today!' }))), null);
assert.equal(jsonLdPostingText('<body>no structured data</body>'), null);
assert.ok(jsonLdPostingText(shell(JSON.stringify({ ...job, description: job.description.repeat(400) }))).length <= 12000);
console.log('PASS: JobPosting JSON-LD reads JavaScript-rendered career sites and refuses thin or broken data');
