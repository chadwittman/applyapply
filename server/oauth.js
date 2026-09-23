// OAuth for assistants that install applyapply through their own connector UI
// (claude.ai Integrations, grok.com Connectors, ChatGPT connectors). They
// cannot paste an API key, so they discover this metadata, register
// themselves, send the person here to approve, and exchange the code for a
// token. That token IS an ordinary personal API key: everything downstream is
// unchanged, and the person revokes an assistant in Profile & settings like
// any other key.
//
// MCP auth: RFC 9728 (protected resource metadata), RFC 8414 (authorization
// server metadata), RFC 7591 (dynamic client registration), authorization code
// with PKCE S256. Public clients only, so no client secrets to leak.
const crypto = require('crypto');

const sha256 = value => crypto.createHash('sha256').update(value).digest('base64url');

// Exact match only, and only shapes a real client uses: https, loopback for
// desktop clients, and an app's own scheme. Never a bare "javascript:" or data URL.
function usableRedirect(uri) {
  if (typeof uri !== 'string' || uri.length > 2000 || /\s/.test(uri)) return false;
  let url;
  try { url = new URL(uri); } catch { return false; }
  if (['javascript:', 'data:', 'file:', 'vbscript:'].includes(url.protocol)) return false;
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol); // an installed app's own scheme
}

module.exports = function mountOauth(app, { db, origin, limiter, escapeHtml, scriptJSON, page, requireSession }) {
  const SCOPE = 'applyapply';
  const meta = {
    resource: {
      resource: origin + '/mcp',
      authorization_servers: [origin],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_documentation: origin + '/agents',
    },
    server: {
      issuer: origin,
      authorization_endpoint: origin + '/oauth/authorize',
      token_endpoint: origin + '/oauth/token',
      registration_endpoint: origin + '/oauth/register',
      revocation_endpoint: origin + '/oauth/revoke',
      scopes_supported: [SCOPE],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      service_documentation: origin + '/agents',
    },
  };
  const serveMeta = body => (req, res) => { res.setHeader('Cache-Control', 'public, max-age=3600'); res.json(body); };
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) app.get(path, serveMeta(meta.resource));
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp']) app.get(path, serveMeta(meta.server));

  // Any assistant may register itself; approval is what grants access.
  app.post('/oauth/register', limiter, async (req, res) => {
    const uris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris.slice(0, 10) : [];
    if (!uris.length || !uris.every(usableRedirect)) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'Send one or more https (or loopback) redirect URIs.' });
    }
    const name = req.body?.client_name || req.body?.software_id || 'An assistant';
    const { clientId } = await db.registerOauthClient(name, uris);
    res.status(201).json({ client_id: clientId, client_name: String(name).slice(0, 120), redirect_uris: uris,
      grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none',
      client_id_issued_at: Math.floor(Date.now() / 1000) });
  });

  // The person approves in their browser. Same decision as /connect: what the
  // assistant may do, stated before they agree.
  app.get('/oauth/authorize', limiter, async (req, res) => {
    const { client_id: clientId, redirect_uri: redirectUri, state = '', code_challenge: challenge, code_challenge_method: method, response_type: responseType } = req.query;
    const client = await db.getOauthClient(clientId).catch(() => null);
    const fail = why => res.status(400).type('html').send(`<meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:-apple-system,sans-serif;background:#000;color:#fff;padding:32px;line-height:1.6">${escapeHtml(why)}</body>`);
    if (!client) return fail('That assistant is not registered with applyapply. Ask it to connect again.');
    if (!client.redirect_uris.includes(String(redirectUri))) return fail('That assistant sent a return address applyapply does not recognise, so the request was refused.');
    // Everything below is safe to bounce back to the registered address.
    const back = (params) => {
      const url = new URL(String(redirectUri));
      for (const [k, v] of Object.entries({ ...params, ...(state ? { state } : {}) })) url.searchParams.set(k, v);
      return url.href;
    };
    if (responseType !== 'code') return res.redirect(back({ error: 'unsupported_response_type' }));
    if (!challenge || method !== 'S256') return res.redirect(back({ error: 'invalid_request', error_description: 'PKCE with S256 is required' }));

    page(res, {
      title: 'Connect ' + client.name + ' — applyapply',
      desc: 'Approve an assistant to use your applyapply account.',
      path: '/oauth/authorize',
      body: `<h1>Connect ${escapeHtml(client.name)}</h1>
<p><b>${escapeHtml(client.name)}</b> wants to use your applyapply account: search current job listings, run job searches, write and rewrite application kits, and manage your pipeline. Those actions spend your credits.</p>
<p>It cannot buy credits, create other keys, export or delete your account, and it cannot submit an application: you review and send those yourself.</p>
<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:22px">
  <button id="approve" style="padding:13px 24px;background:#fff;color:#000;border:0;border-radius:8px;font-size:16px;font-weight:700;cursor:pointer;font-family:inherit">Approve ${escapeHtml(client.name)}</button>
  <button id="deny" style="padding:13px 24px;background:none;color:#fff;border:1px solid #333;border-radius:8px;font-size:16px;cursor:pointer;font-family:inherit">Not now</button>
</div>
<div id="st" style="margin-top:12px;min-height:22px;font-size:15px"></div>
<script>
var REQ=${scriptJSON({ client_id: String(clientId), redirect_uri: String(redirectUri), state: String(state), code_challenge: String(challenge) })};
var DENIED=${scriptJSON(back({ error: 'access_denied' }))};
document.getElementById('deny').addEventListener('click',function(){location.href=DENIED;});
document.getElementById('approve').addEventListener('click',function(){
  var st=document.getElementById('st'),key='';
  try{key=localStorage.getItem('aa_session')||'';}catch(e){}
  if(!key){location.href='/login?return='+encodeURIComponent(location.pathname+location.search);return;}
  this.disabled=true;st.textContent='Connecting';
  fetch('/oauth/approve',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key},body:JSON.stringify(REQ)})
    .then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d};});})
    .then(function(x){if(!x.ok)throw new Error(x.d.error_description||x.d.error||'Could not connect');location.href=x.d.redirect_to;})
    .catch(function(e){st.textContent=e.message;document.getElementById('approve').disabled=false;});
});
</script>`,
    });
  });

  app.post('/oauth/approve', limiter, async (req, res) => {
    const email = requireSession(req, res); if (!email) return;
    const { client_id: clientId, redirect_uri: redirectUri, state = '', code_challenge: challenge } = req.body || {};
    const client = await db.getOauthClient(clientId).catch(() => null);
    if (!client || !client.redirect_uris.includes(String(redirectUri))) return res.status(400).json({ error: 'invalid_request', error_description: 'Unknown assistant or return address' });
    if (!challenge) return res.status(400).json({ error: 'invalid_request', error_description: 'Missing PKCE challenge' });
    // The key exists from here, so the person can revoke it even if the
    // assistant never comes back for it.
    const { key } = await db.createApiKey(email, client.name);
    const code = await db.createOauthCode({ clientId: client.client_id, userEmail: email, redirectUri: String(redirectUri), codeChallenge: String(challenge), apiKey: key });
    const url = new URL(String(redirectUri));
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', String(state));
    res.json({ redirect_to: url.href });
  });

  app.post('/oauth/token', limiter, async (req, res) => {
    const body = req.body || {};
    if (body.grant_type !== 'authorization_code') return res.status(400).json({ error: 'unsupported_grant_type' });
    const row = await db.peekOauthCode(body.code);
    if (!row) return res.status(400).json({ error: 'invalid_grant', error_description: 'That code has expired or was already used' });
    if (row.client_id !== body.client_id || row.redirect_uri !== body.redirect_uri) return res.status(400).json({ error: 'invalid_grant', error_description: 'Code was issued to a different client or return address' });
    if (!body.code_verifier || sha256(String(body.code_verifier)) !== row.code_challenge) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
    if (!await db.spendOauthCode(row.code)) return res.status(400).json({ error: 'invalid_grant', error_description: 'That code was already used' });
    // Personal API keys do not expire; the person revokes them when done.
    res.setHeader('Cache-Control', 'no-store');
    res.json({ access_token: row.api_key, token_type: 'Bearer', scope: SCOPE });
  });

  app.post('/oauth/revoke', limiter, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const token = String(req.body?.token || '');
    const email = await db.emailForApiKey(token).catch(() => null);
    if (email) {
      const keys = await db.listApiKeys(email).catch(() => []);
      const mine = keys.find(k => token.startsWith(k.prefix));
      if (mine) await db.revokeApiKey(email, mine.id).catch(() => {});
    }
    res.status(200).end(); // RFC 7009: success either way
  });

  return { usableRedirect };
};
