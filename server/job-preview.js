// Public posting facts only. No account, resume, fit rationale or paid actions.
const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const copy = s => String(s || '').toLowerCase().replace(/[\u2014\u2013]/g, ', ');

function page(job, token, origin) {
  const base = '/j/' + encodeURIComponent(token);
  const url = origin.replace(/\/$/, '') + base;
  const title = copy([job.role || 'explore this role', job.company].filter(Boolean).join(' at '));
  const desc = copy([job.location, 'view the posting. you choose what happens next.'].filter(Boolean).join(' · '));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="same-origin">
<title>${esc(title)} · applyapply</title><meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="applyapply">
<meta property="og:url" content="${esc(url)}"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${esc(url)}/card.png">
<meta property="og:image:type" content="image/png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(title + '. ' + desc)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(url)}/card.png">
<link rel="icon" href="/brand/icon-32.png">
<style>*{box-sizing:border-box}body{margin:0;background:#000;color:#fff;font-family:system-ui,sans-serif}main{max-width:640px;margin:auto;padding:32px 24px 64px}a{color:inherit}.brand{font-weight:700;text-decoration:none}.label{color:#4ade80;margin-top:64px;font-size:14px}h1{font-size:clamp(32px,7vw,48px);letter-spacing:-.04em;line-height:1.1;overflow-wrap:anywhere;margin:18px 0}p{line-height:1.6;color:#aaa}.company{font-size:22px;color:#fff}.button{display:block;text-align:center;border:0;border-radius:14px;background:#fff;color:#000;padding:18px;font:600 17px system-ui;width:100%;cursor:pointer;margin:32px 0 12px}.next{border-top:1px solid #292929;margin-top:40px;padding-top:20px}h2{font-size:18px}button:focus-visible,a:focus-visible{outline:3px solid #4ade80;outline-offset:4px}</style>
</head><body><main><a class="brand" href="/">applyapply</a><p class="label">role to explore</p>
<h1>${esc(copy(job.role || 'explore this role'))}</h1>
${job.company ? `<p class="company">${esc(copy(job.company))}</p>` : ''}
${job.location ? `<p>${esc(copy(job.location))}</p>` : ''}
<form action="${base}/open" method="post"><button class="button" type="submit">view original posting ↗</button></form>
<p>check the original posting for current details and availability.</p>
<section class="next"><h2>want an application for this role?</h2><p>reply to this role in messages with “write it”. a tailored resume, cover letter and answers cost 10 credits.</p>
<p>opening this page is free. nothing is written or submitted here. you review and send the application yourself.</p></section>
</main></body></html>`;
}

module.exports = { page };
