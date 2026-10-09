import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const db = require('./db');
const {chromium} = require('playwright-core');
const origin = process.env.APP_ORIGIN;
const index = await fetch(origin+'/jobs').then(r=>r.text());
assert.match(index,/<img src="\/brand\/icon-64\.png"/);assert.doesNotMatch(index,/\$\{LOGO\}/);
assert.match(index,/\/jobs\/founding-engineer/);assert.match(index,/\/jobs\/founding-growth/);
assert.doesNotMatch(index,/id="application"/);
for (const slug of ['founding-engineer','founding-growth']) {
  const page = await fetch(origin+'/jobs/'+slug).then(r=>r.text());
  assert.match(page,/name="resume"/);assert.match(page,/name="work_authorization"/);
  assert.doesNotMatch(page,/name="role"|jobs@applyapply/);
}
assert.equal((await fetch(origin+'/jobs/unknown')).status,404);
const pdf=Buffer.from('%PDF-1.4\nresume test fixture\n%%EOF');
const valid={first_name:'Test',last_name:'Candidate',email:'candidate@example.com',location:'Austin, TX',work_authorization:'yes',sponsorship:'no',note:'I built a browser extension and a job board.'};
function form(fields=valid,bytes=pdf,filename='resume.pdf'){
  const body=new FormData();for(const [k,v] of Object.entries(fields))body.set(k,v);
  if(bytes)body.set('resume',new Blob([bytes]),filename);return body;
}
const submit=(body,slug='founding-engineer')=>fetch(origin+'/jobs/'+slug+'/apply',{method:'POST',body});
assert.equal((await submit(form(valid,null))).status,400);
assert.equal((await submit(form({...valid,portfolio:'javascript:alert(1)'}))).status,400);
assert.equal((await submit(form(valid,Buffer.from('not a pdf')))).status,400);
assert.equal((await submit(form(valid,Buffer.alloc(5*1024*1024+1)))).status,400);
assert.equal((await submit(form())).status,200);
assert.equal((await submit(form(),'founding-growth')).status,200);
const rows=(await db.pool.query('SELECT * FROM hiring_applications ORDER BY id')).rows;
assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.role),['engineer','growth']);
assert.deepEqual(rows[0].resume_bytes,pdf);
assert.equal((await fetch(origin+'/admin/job-applications')).status,403);
const resumeUrl=origin+'/admin/job-applications/'+rows[0].id+'/resume';
assert.equal((await fetch(resumeUrl)).status,403);
const downloaded=await fetch(resumeUrl,{headers:{'x-admin-secret':'e2e-admin'}});
assert.equal(downloaded.status,200);assert.match(downloaded.headers.get('content-disposition'),/attachment/);
assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),pdf);
const browser=await chromium.launch({headless:true,executablePath:process.env.AA_CHROME});
const page=await browser.newPage({viewport:{width:390,height:844}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(origin+'/jobs/founding-growth');
for(const [k,v] of Object.entries(valid)){
 if(['sponsorship','work_authorization'].includes(k))await page.selectOption('[name="'+k+'"]',v);
 else await page.fill('[name="'+k+'"]',v);
}
await page.setInputFiles('[name="resume"]',{name:'resume.pdf',mimeType:'application/pdf',buffer:pdf});
await page.click('button[type="submit"]');
await page.waitForSelector('#application-done',{state:'visible'});
assert.equal(await page.locator('#application').isVisible(),false);
assert.equal(await page.locator('#application-done').isVisible(),true);
assert.match(await page.locator('#application-done').textContent(),/application submitted[\s\S]*candidate@example\.com/);
assert.equal(await page.locator('.topbar img[src="/brand/icon-64.png"]').count(),1);
assert.deepEqual(errors,[]);
assert.equal((await db.pool.query('SELECT count(*) FROM hiring_applications')).rows[0].count,'3');
await browser.close();await db.pool.end();
console.log('PASS: separate roles, multipart validation, resume limits and storage, protected downloads, and real-browser submission');
