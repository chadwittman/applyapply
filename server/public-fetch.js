const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const ipaddr = require('ipaddr.js');
const { canonicalUrl } = require('./posting');

function isPublicAddress(address) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}

async function publicTarget(value) {
  const url = new URL(canonicalUrl(value));
  if (url.port && !['80', '443'].includes(url.port)) throw Object.assign(new Error('Unsupported job URL port'), { status: 400 });
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) {
    throw Object.assign(new Error('Job URLs must resolve to the public internet'), { status: 400 });
  }
  return { url, address: addresses[0] };
}

// Pin the validated address for each request, including redirects. Resolving
// once and then handing the hostname to fetch would allow DNS rebinding.
async function publicFetch(value, { method = 'GET', maxBytes = 2 * 1024 * 1024, timeout = 10000 } = {}) {
  const deadline = Date.now() + timeout;
  let current = value;
  for (let redirects = 0; redirects <= 4; redirects++) {
    let lookupTimer;
    const target = await Promise.race([
      publicTarget(current),
      new Promise((_, reject) => { lookupTimer = setTimeout(() => reject(new Error('Job lookup timed out')), Math.max(1, deadline - Date.now())); lookupTimer.unref(); }),
    ]).finally(() => clearTimeout(lookupTimer));
    const result = await new Promise((resolve, reject) => {
      const client = target.url.protocol === 'https:' ? https : http;
      const req = client.request(target.url, {
        method, headers: { 'User-Agent': 'ApplyApply/1.0', 'Accept-Encoding': 'identity' },
        lookup(_host, options, callback) {
          if (options.all) callback(null, [target.address]);
          else callback(null, target.address.address, target.address.family);
        },
      }, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) req.destroy(new Error('Job page is too large'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      const timer = setTimeout(() => req.destroy(new Error('Job fetch timed out')), Math.max(1, deadline - Date.now()));
      req.once('close', () => clearTimeout(timer));
      req.on('error', reject);
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
      current = new URL(result.headers.location, target.url).href;
      continue;
    }
    return { status: result.status, ok: result.status >= 200 && result.status < 300,
      text: async () => result.body, json: async () => JSON.parse(result.body) };
  }
  throw new Error('Too many job page redirects');
}

module.exports = { publicFetch, publicTarget, isPublicAddress };
