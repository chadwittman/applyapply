// What answer engines need: permission to crawl, pages that answer questions,
// and structured data that says plainly what this is and what it costs.
import assert from 'node:assert/strict';
const origin = process.env.APP_ORIGIN;
const get = async path => { const r = await fetch(origin + path); return { status: r.status, text: await r.text() }; };

const robots = await get('/robots.txt');
for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'OAI-SearchBot', 'Google-Extended', 'Bingbot']) {
  assert.match(robots.text, new RegExp('User-agent: ' + bot + '\\nAllow: /'), bot + ' is allowed');
}
assert.match(robots.text, /User-agent: GPTBot[\s\S]*?Disallow: \/setup/, 'Private paths stay private for the engines too');
assert.match(robots.text, /Disallow: \/k\//, 'Private kit links are never crawled');

const sitemap = await get('/sitemap.xml');
for (const path of ['/', '/faq', '/demo', '/agents', '/privacy', '/terms']) {
  assert.ok(sitemap.text.includes(`<loc>${origin}${path}</loc>`), path + ' is in the sitemap');
}

const faq = await get('/faq');
assert.equal(faq.status, 200);
const schema = [...faq.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
const faqPage = schema.find(x => x['@type'] === 'FAQPage');
assert.ok(faqPage, 'FAQ page carries FAQPage data');
assert.ok(faqPage.mainEntity.length >= 8, 'Enough questions to be worth citing');
assert.match(faqPage.mainEntity[0].acceptedAnswer.text, /never submits/i);
assert.ok(faqPage.mainEntity.some(q => /cost/i.test(q.name) && /1,000 credits/.test(q.acceptedAnswer.text)), 'Pricing is stated plainly');

const home = await get('/');
const homeSchema = [...home.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
const app = homeSchema.find(x => x['@type'] === 'SoftwareApplication');
assert.ok(homeSchema.find(x => x['@type'] === 'Organization'), 'Organization data');
assert.equal(app.offers.price, '10.00');
assert.match(app.description, /never submits/i);

const llms = await get('/llms.txt');
for (const fact of ['1,000 credits', 'Greenhouse, Lever, Ashby, Workday', 'never submits', '/openapi.json', 'Pegasus Crypto Holdings']) {
  assert.ok(llms.text.includes(fact), 'llms.txt states: ' + fact);
}
console.log('PASS: answer engines are allowed, the pages answer, and the facts are machine-readable');
