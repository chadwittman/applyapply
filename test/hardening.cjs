// Real isolated Postgres + HTTP; synthetic accounts and mocked providers.
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const requireServer = createRequire(path.resolve(__dirname, '../server/package.json'));
const { Pool } = requireServer('pg');
const jwt = requireServer('jsonwebtoken');
const database = `aa_security_${process.pid}_${Date.now()}`;
const connection = `postgresql://${encodeURIComponent(process.env.PGUSER || os.userInfo().username)}@127.0.0.1:5432/`;
const admin = new Pool({ connectionString: connection + 'postgres', ssl: false });
const originalFetch = global.fetch;
let db, server, origin, worker, modelResult, modelFailure = false, resumeFailure = false, modelCalls = 0, passed = 0;
const token = email => jwt.sign({ email }, 'audit-secret-local-only');
async function check(name, fn) { await fn(); console.log(`PASS: ${name}`); passed++; }
async function call(method, route, email, body, key) {
  const r = await originalFetch(origin + route, { method, headers: {
    ...(email ? { 'x-api-key': token(email) } : {}), ...(body ? { 'content-type': 'application/json' } : {}),
    ...(key ? { 'Idempotency-Key': key } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
async function balance(email, credits) {
  await db.getOrCreateUser(email);
  await db.pool.query('UPDATE users SET credits=$1 WHERE email=$2', [credits,email]);
}
async function waitFor(fn) {
  for (let i=0;i<100;i++) { if (await fn()) return; await new Promise(r=>setTimeout(r,20)); }
  throw new Error('Timed out waiting for state');
}
async function main() {
  await admin.query(`CREATE DATABASE "${database}"`);
  Object.assign(process.env, {
    DATABASE_URL:connection+database,DATABASE_SSL:'off',NODE_ENV:'test',
    APPLYAPPLY_JWT_SECRET:'audit-secret-local-only',ALLOW_LOCAL_BYPASS:'false',
    ANTHROPIC_API_KEY:'audit-fake-key',OPENROUTER_API_KEY:'',RESEND_API_KEY:'',
    STRIPE_SECRET_KEY:'sk_test_audit_fake',STRIPE_WEBHOOK_SECRET:'whsec_audit_fake',
    HYPERBROWSER_API_KEY:'',APP_ORIGIN:'http://127.0.0.1',SCHEDULE_TZ:'America/Chicago',
    JAA_USER_EMAIL:'',JAA_PREFETCH_ONLY:'',JAA_TARGET_ROLES:'',JAA_ENABLED_SOURCES:'',
  });
  db=requireServer('./db'); await db.initSchema();
  global.fetch=async (url,options)=>{
    if(new URL(url).hostname==='api.anthropic.com') {
      modelCalls++; assert.match(JSON.parse(options.body).system,/untrusted/);
      await new Promise(r=>setTimeout(r,30));
      const resume = JSON.stringify(JSON.parse(options.body).messages).includes('ORIGINAL RESUME');
      return modelFailure || resume && resumeFailure ? new Response('{}',{status:503}) : Response.json({content:[{type:'text',text:JSON.stringify(resume ? {summary:'Test resume',experience:[],skills:[],coverage:{confidence:'thin'}} : modelResult)}]});
    }
    throw new Error('Test blocked external fetch: '+url);
  };
  server=requireServer('./server').app.listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r)); origin='http://127.0.0.1:'+server.address().port;
  const alice='alice@audit.invalid',bob='bob@audit.invalid';
  await balance(alice,200); await balance(bob,200);
  const url='https://jobs.lever.co/audit/posting-1';
  const base={id:'model-slug',company:'Audit',role:'PM',url,profile:{first_name:'Invented'},tailored:{headline:'Draft'}};
  modelResult=base;
  for(const email of [alice,bob]) await db.upsertJob({...base,user_email:email,found_at:new Date().toISOString()});
  let kitA,kitB;
  await check('Empty enabled schedules are rejected without saving; malformed time rejected',async()=>{
    const result=await call('POST','/schedule',alice,{hour:8,minute:0,enabled:true,sources:[]});
    assert.equal(result.status,400);
    assert.equal(await db.getSchedule(alice),null);
    assert.equal((await call('POST','/schedule',alice,{hour:'NaN',minute:0,enabled:true})).status,400);
  });
  await check('Selective matches require role fit and confirmed target pay',async()=>{
    const {selectiveMatch}=requireServer('./search-preferences');
    assert.equal(selectiveMatch(9,'Competitive compensation','200000'),false);
    assert.equal(selectiveMatch(9,'Annual base salary: $100,000 - $150,000 USD','200000'),false);
    assert.equal(selectiveMatch(9,'Annual base salary: $180k - $220k USD','200000'),true);
    assert.equal(selectiveMatch(4,'Annual base salary: $180k - $220k USD','200000'),false);
    assert.equal(selectiveMatch(9,'Annual base salary: $180k - $220k CAD','200000'),false);
    assert.equal(selectiveMatch(9,'Annual base salary: $180k - $220k USD',''),false);
  });
  await check('Generation isolates kit ownership, identity and job status',async()=>{
    kitA=await call('POST','/generate',alice,{url,description:'Synthetic posting'});
    assert.equal(kitA.status,200,JSON.stringify(kitA.data));
    assert.equal((await db.getJobByUrl(url,bob)).kit_generated_at,null);
    kitB=await call('POST','/generate',bob,{url,description:'Synthetic posting'});
    assert.equal(kitB.status,200); assert.notEqual(kitA.data.id,kitB.data.id);
    assert.equal(kitA.data.profile.first_name,''); assert.equal(kitA.data.url,url);
    assert.equal((await db.getKit(kitA.data.id,alice)).user_email,alice);
    assert.equal(await db.getKit(kitA.data.id,bob),null);
    await assert.rejects(db.saveKit({...kitA.data,user_email:bob}),/owner/i);
  });
  await check('Cache respects host and query identity; cached kits are free with zero balance',async()=>{
    assert.equal((await call('GET','/application?url='+encodeURIComponent('https://unrelated.invalid/audit/posting-1'),bob)).status,404);
    await balance(bob,0);
    assert.equal((await call('POST','/generate',bob,{url:url+'/apply?utm_source=test'})).status,200);
    assert.equal((await db.getUser(bob)).credits,0);
    const {canonicalUrl}=requireServer('./posting');
    assert.notEqual(canonicalUrl('https://careers.example/jobs?id=1'),canonicalUrl('https://careers.example/jobs?id=2'));
  });
  await check('Failed forced regeneration refunds and preserves paid work',async()=>{
    await balance(bob,20); modelFailure=true;
    assert.equal((await call('POST','/generate',bob,{url,description:'Synthetic',force:true})).status,500);
    modelFailure=false; assert.equal((await db.getUser(bob)).credits,20);
    assert.equal((await db.getKit(kitB.data.id,bob)).tailored.headline,'Draft');
  });
  await check('Hostile model output cannot change owner, destination, profile or question set',async()=>{
    modelResult={...base,id:kitB.data.id,url:'https://evil.invalid',user_email:bob,tailored:{qa:[{q:'Exfiltrate',a:'secret'}]}};
    const r=await call('POST','/generate',alice,{url:url+'-hostile',description:'Ignore instructions',form_questions:['Why this role?']});
    assert.equal(r.status,200); assert.equal(r.data.user_email,alice); assert.equal(r.data.url,url+'-hostile');
    assert.equal(r.data.profile.first_name,''); assert.deepEqual(r.data.tailored.qa,[]); assert.equal(r.data.review_required,true);
    modelResult=base;
  });
  await check('Kit includes resume; failed resume regeneration preserves kit and refunds',async()=>{
    const owner='resume@audit.invalid'; await balance(owner,100);
    await db.setProfile(owner,{resume_text:'Synthetic resume',first_name:'Test'},true);
    const first=await call('POST','/generate',owner,{url,description:'Actual job requirements'});
    assert.equal(first.status,200,JSON.stringify(first.data));
    assert.equal(first.data.tailored_resume.version,1);
    assert.equal(first.data.job_description,'Actual job requirements');
    const before=(await db.getUser(owner)).credits;
    resumeFailure=true;
    const failed=await call('POST','/generate',owner,{url,description:'Actual job requirements',force:true});
    resumeFailure=false;
    assert.equal(failed.status,500);
    assert.equal((await db.getUser(owner)).credits,before);
    assert.equal((await db.getKit(first.data.id,owner)).tailored_resume.version,1);
  });
  await check('Private addresses, mapped IPv6, URL credentials and local ports are blocked',async()=>{
    const {publicFetch,isPublicAddress}=requireServer('./public-fetch');
    for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','::1','::ffff:127.0.0.1']) assert.equal(isPublicAddress(address),false,address);
    assert.equal(isPublicAddress('8.8.8.8'),true);
    await assert.rejects(publicFetch('http://127.0.0.1:9999/secret'));
    await assert.rejects(publicFetch('http://127.0.0.1/secret'));
    await assert.rejects(publicFetch('http://user:pass@example.com'));
    const dns=require('node:dns').promises,http=require('node:http');
    const lookup=dns.lookup,request=http.request;let requests=0,pinned=false;
    try {
      dns.lookup=async()=>[{address:'8.8.8.8',family:4}];
      http.request=(_url,options,respond)=>{
        requests++;
        // DNS changes after validation; the transport must keep the pinned IP.
        dns.lookup=async()=>[{address:'127.0.0.1',family:4}];
        options.lookup('public.example',{},(_err,address)=>{assert.equal(address,'8.8.8.8');pinned=true;});
        const req=new EventEmitter();req.destroy=e=>req.emit('error',e);
        req.end=()=>{
          const response=new PassThrough();response.statusCode=302;response.headers={location:'http://private.example/secret'};
          respond(response);response.end();req.emit('close');
        };
        return req;
      };
      await assert.rejects(publicFetch('http://public.example/job'),/public internet/);
      assert.equal(requests,1);assert.equal(pinned,true);
    } finally {dns.lookup=lookup;http.request=request;}
  });
  await check('Auth success rejects script injection',async()=>{
    const marker='</script><script>globalThis.BAD=1</script>';
    for(const suffix of ['', '&session='+encodeURIComponent(token(alice))]) {
      const r=await call('GET','/auth/success?ext='+encodeURIComponent(marker)+suffix);
      assert.ok(r.status>=400); assert.ok(!String(r.data).includes(marker));
    }
  });
  await check('Audit feedback, run detail, public HTML and fragments are owner-scoped',async()=>{
    await db.saveActivity(alice,url,'feedback',{feedback:'correct',note:'ALICE_PRIVATE_NOTE'});
    await db.saveSourceRun({id:'private-run',date:'2026-09-16',user_email:alice,found:1,excluded:0,duration_ms:1,sources:1},[],{sources:[{name:'ALICE_PRIVATE_SOURCE',jobs:[]}]});
    for(const route of ['/audit/data','/audit/feedback','/sourcing','/sourcing?fragment=1']) assert.ok(!JSON.stringify((await call('GET',route,bob)).data).includes('ALICE_PRIVATE'));
    assert.ok(!(await call('GET','/sourcing')).data.includes('ALICE_PRIVATE'));
    assert.equal((await call('GET','/sourcing?fragment=1')).status,401);
    assert.ok((await call('GET','/sourcing?fragment=1',alice)).data.html.includes('ALICE_PRIVATE_SOURCE'));
  });
  await check('32 concurrent reservations cannot overspend; 16 refunds credit once',async()=>{
    const owner='reserve@audit.invalid'; await balance(owner,10);
    const results=await Promise.allSettled(Array.from({length:32},(_,i)=>db.reserveOperation({userEmail:owner,action:'generate',key:String(i),cost:10})));
    const won=results.filter(r=>r.status==='fulfilled'); assert.equal(won.length,1);
    assert.equal((await db.getUser(owner)).credits,0);
    await Promise.all(Array.from({length:16},()=>db.finishOperation(won[0].value.id,owner,{refund:true})));
    assert.equal((await db.getUser(owner)).credits,10);
  });
  await check('Concurrent HTTP generation and retry charge for one model call',async()=>{
    const owner='race@audit.invalid'; await balance(owner,10); const before=modelCalls;
    const body={url:url+'-race',description:'Synthetic'};
    const r=await Promise.all([call('POST','/generate',owner,body,'same'),call('POST','/generate',owner,body,'same')]);
    assert.ok(r.some(x=>x.status===200)); assert.ok(r.every(x=>[200,409].includes(x.status)));
    assert.equal(modelCalls-before,1); assert.equal((await db.getUser(owner)).credits,0);
    assert.equal((await call('POST','/generate',owner,body,'same')).status,200);
  });
  await check('Expired work refunds once and rejects stale commits and heartbeats',async()=>{
    const owner='expired@audit.invalid'; await balance(owner,20);
    const op=await db.reserveOperation({userEmail:owner,action:'source',cost:20});
    await db.pool.query("UPDATE operations SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[op.id]);
    assert.equal(await db.renewOperation(op.id,owner),false);
    await assert.rejects(db.saveSourceRun({id:'late',user_email:owner},[],{},op.id));
    await Promise.all([db.recoverOperations(),db.recoverOperations()]);
    assert.equal((await db.getUser(owner)).credits,20); assert.equal((await db.getOperation(op.id,owner)).status,'refunded');
    assert.equal(await db.getOperation(op.id,alice),null);
  });
  await check('Manual sourcing shares one durable reservation; a failed child refunds',async()=>{
    const owner='worker@audit.invalid';const source=(await call('GET','/source/catalog')).data[0]; await balance(owner,source.credits);
    const r=await Promise.all([call('POST','/source/run',owner,{sources:[source.name]}),call('POST','/source/run',owner,{sources:[source.name]})]);
    assert.equal(r[0].status,200);assert.equal(r[1].status,200);assert.equal(r[0].data.operation_id,r[1].data.operation_id);
    const children=[];
    worker=requireServer('./source-worker')(db,()=>{
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.kill=()=>child.emit('close',1);children.push(child);return child;
    });
    await worker.tick();assert.equal(children.length,1);
    children[0].stdout.write('PRIVATE_WORKER_LOG\n');children[0].emit('close',1);
    await waitFor(async()=> (await db.getUser(owner)).credits===source.credits);
    assert.equal((await call('GET','/source/status',owner)).data.outcome,'refunded');
    assert.deepEqual(await db.getOperationEvents(r[0].data.operation_id,alice),[]);
    assert.match((await db.getOperationEvents(r[0].data.operation_id,owner))[0].message,/PRIVATE_WORKER_LOG/);
    await worker.stop();worker=null;
  });
  await check('Dated schedule catches up across midnight without repeating',async()=>{
    const owner='schedule@audit.invalid';await db.setSchedule(owner,{hour:23,minute:30,enabled:true,sources:[]});
    const now=new Date('2026-09-17T05:30:00Z');
    const row=(await db.getDueSchedules(null,null,now)).find(r=>r.user_email===owner);
    assert.ok(row);assert.equal(row.due_at.toISOString(),'2026-09-17T04:30:00.000Z');
    await db.pool.query('UPDATE schedules SET last_run_at=$1 WHERE user_email=$2',[now,owner]);
    assert.ok(!(await db.getDueSchedules(null,null,now)).some(r=>r.user_email===owner));
  });
  await check('URL variants merge safely, migration archives originals, distinct jobs survive',async()=>{
    const owner='variants@audit.invalid';await db.upsertJob({...base,user_email:owner,status:'skipped'});
    await db.insertJob({...base,url:url+'/apply?utm_source=x',user_email:owner});
    assert.equal((await db.getJobs(null,200,owner)).length,1);assert.equal((await db.getJobByUrl(url+'/apply',owner)).status,'skipped');
    await db.upsertJob({...base,url:url+'-another',user_email:owner});assert.equal((await db.getJobs(null,200,owner)).length,2);
    await db.pool.query('INSERT INTO jobs(id,url,company,role,status,user_email) VALUES($1,$2,$3,$4,$5,$6)',['legacy-variant',url+'/apply','Audit','PM','applied',owner]);
    await db.initSchema();assert.equal((await db.getJobs(null,200,owner)).length,2);assert.equal((await db.getJobByUrl(url,owner)).status,'applied');
    assert.equal((await db.pool.query('SELECT * FROM job_merge_archive WHERE id=$1',['legacy-variant'])).rowCount,1);
  });
  await check('Kit revisions retain owner-scoped history',async()=>{
    await db.saveKit({...kitA.data,tailored:{headline:'Revised'}});
    assert.ok(JSON.stringify(await db.getKitVersions(kitA.data.id,alice)).includes('Draft'));
    assert.deepEqual(await db.getKitVersions(kitA.data.id,bob),[]);
  });
  await check('Signed unpaid Stripe sessions grant nothing; concurrent paid events credit once',async()=>{
    const stripe=requireServer('stripe')('sk_test_audit_fake'),owner='payer@audit.invalid';
    const p=await db.createPurchase(owner,{id:'price_test',currency:'usd',unit_amount:1000,active:true});
    const session={id:'cs_test_one',mode:'payment',customer_email:owner,amount_total:1000,payment_status:'unpaid',currency:'usd',metadata:{purchase_id:p.id}};
    await db.bindPurchase(p.id,session.id);
    async function webhook(id,s) {
      const payload=JSON.stringify({id,type:'checkout.session.completed',data:{object:s}});
      const signature=stripe.webhooks.generateTestHeaderString({payload,secret:process.env.STRIPE_WEBHOOK_SECRET});
      const r=await originalFetch(origin+'/webhook/stripe',{method:'POST',headers:{'content-type':'application/json','stripe-signature':signature},body:payload});
      return {status:r.status,data:await r.json()};
    }
    assert.equal((await webhook('evt_unpaid',session)).status,200);assert.equal(await db.getUser(owner),null);
    const paid={...session,payment_status:'paid'};
    assert.ok((await Promise.all([webhook('evt_one',paid),webhook('evt_two',paid)])).every(x=>x.status===200));
    assert.equal((await db.getUser(owner)).credits,1000);assert.equal((await webhook('evt_one',paid)).data.duplicate,true);
    for(const change of [{currency:'eur'},{amount_total:1},{customer_email:alice}]) await assert.rejects(db.fulfillPurchase('evt_wrong',{...paid,...change}),/match/);
  });
  await check('Unknown eligibility stays unanswered; model mappings cannot invent it',async()=>{
    const content=fs.readFileSync(path.resolve(__dirname,'../extension/content.js'),'utf8');
    const source=content.slice(content.indexOf('function binaryAnswerForLabel('),content.indexOf('\nfunction chooseGreenhouseCombobox('));
    const binary=new Function(source+';return binaryAnswerForLabel;')();
    assert.equal(binary('10 years experience?',{}),null);assert.equal(binary('Require visa sponsorship?',{}),null);
    assert.equal(binary('Require visa sponsorship?',{sponsorship:'yes'}),'Yes');assert.equal(binary('Authorized to work?',{work_authorization:'no'}),'No');
    const {mappingsOutput}=requireServer('./ai-output');
    assert.deepEqual(mappingsOutput({mappings:[{label:'10 years experience?',type:'radio',value:'Yes'}]},[{label:'10 years experience?'}],{}).mappings,[]);
  });
  await check('Duplicate schedule dispatch reserves one operation and one charge',async()=>{
    const owner='schedule-race@audit.invalid',source=(await call('GET','/source/catalog')).data[0];
    await balance(owner,source.credits*2);
    const row={user_email:owner,hour:8,minute:0,due_at:new Date(),sources:[source.name]};
    const {runScheduledSourcing}=requireServer('./server');
    const ops=await Promise.all([runScheduledSourcing(row),runScheduledSourcing(row)]);
    assert.equal(ops[0].id,ops[1].id);assert.equal((await db.getUser(owner)).credits,source.credits);
    await db.finishOperation(ops[0].id,owner,{refund:true});
  });
  await check('PDF upload validates bytes and preserves original extracted text',async()=>{
    const {jsPDF}=require('../extension/vendor/jspdf.umd.min.js');
    const pdf=new jsPDF();pdf.text('Synthetic resume for the upload regression.',10,10);
    const form=new FormData();form.set('resume',new Blob([pdf.output('arraybuffer')],{type:'application/pdf'}),'resume.pdf');
    modelResult={first_name:'Alice',text:'MODEL_MUST_NOT_REPLACE_SOURCE',work_authorization:'yes'};
    const r=await originalFetch(origin+'/resume/parse',{method:'POST',headers:{'x-api-key':token(alice)},body:form});
    const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));
    assert.match(data.text,/Synthetic resume/);assert.equal(data.work_authorization,undefined);
    assert.ok(await db.getResumeFile(alice));
    const bad=new FormData();bad.set('resume',new Blob(['not a PDF'],{type:'application/pdf'}),'fake.pdf');
    assert.equal((await originalFetch(origin+'/resume/parse',{method:'POST',headers:{'x-api-key':token(alice)},body:bad})).status,400);
    modelResult=base;
  });
  await check('Google cache retains scored jobs; provider failure rejects; valid zero-result runs commit',async()=>{
    const owner='cache@audit.invalid',name='Lever jobs (Google)';await balance(owner,10);
    Object.assign(process.env,{JAA_USER_EMAIL:owner,JAA_TARGET_ROLES:'Product Manager',JAA_ENABLED_SOURCES:JSON.stringify([name])});
    const source=require('../source');
    const key=db.cacheKeyFor(name,'Product Manager',false,'remote');
    await db.putCachedSource(key,name,'product manager',{rawCount:1,allScanned:[{url,role:'Product Manager',fit_score:0}],jobs:[{company:'Audit',role:'Product Manager',url,fit_score:8}]});
    const cached=await source.runBrowserSources('fake',null);
    assert.equal(cached[0].jobs[0].fit_score,8);assert.equal(cached[0].fromCache,true);
    await db.pool.query('DELETE FROM source_cache');
    await assert.rejects(source.runBrowserSources('fake',null),/not configured/);
    await db.putCachedSource(key,name,'product manager',{rawCount:0,allScanned:[],jobs:[]});
    const op=await db.reserveOperation({userEmail:owner,action:'source',cost:10});process.env.JAA_OPERATION_ID=op.id;
    await source.main();assert.equal((await db.getOperation(op.id,owner)).status,'succeeded');
    assert.equal((await db.getRuns(1,owner))[0].added,0);
    delete process.env.JAA_OPERATION_ID;
  });
  await check('New accounts get the starter grant once, recorded in the ledger',async()=>{
    const fresh='starter@audit.invalid',prior=process.env.STARTER_CREDITS;process.env.STARTER_CREDITS='30';
    try{
      await Promise.all([db.getOrCreateUser(fresh),db.getOrCreateUser(fresh)]);await db.getOrCreateUser(fresh);
      assert.equal((await db.getUser(fresh)).credits,30);
      const {rows}=await db.pool.query("SELECT amount FROM credit_ledger WHERE user_email=$1 AND kind='starter'",[fresh]);
      assert.deepEqual(rows.map(r=>r.amount),[30]);
      await db.deleteAccount(fresh);assert.equal(await db.getUser(fresh),null,'Account deletion removes the user');
      await db.getOrCreateUser(fresh);
      assert.equal((await db.getUser(fresh)).credits,0,'Re-created account gets no second grant');
    }finally{process.env.STARTER_CREDITS=prior;}
  });
  await check('A partly failed run refunds only the failed sources, once',async()=>{
    const owner='partial@audit.invalid';await balance(owner,20);
    const op=await db.reserveOperation({userEmail:owner,action:'source',cost:12,payload:{sources:['A','B'],source_credits:{A:5,B:7}}});
    await db.saveSourceRun({id:'partial-run',date:'2026-09-21',sources:2,found:0,excluded:0,duration_ms:1,user_email:owner},[],{sources:[]},op.id,['B','not-in-run']);
    assert.equal((await db.getUser(owner)).credits,15);
    assert.equal((await db.getOperation(op.id,owner)).status,'succeeded');
    const {rows}=await db.pool.query("SELECT amount FROM credit_ledger WHERE operation_id=$1 AND kind='partial_refund'",[op.id]);
    assert.deepEqual(rows.map(r=>r.amount),[7]);
    const catalog=await (await originalFetch(origin+'/source/catalog')).json();
    assert.ok(catalog.length && catalog.every(s=>!s.retired),'Retired sources are not offered');
  });
  await check('Listings ledger serves the window, honors day-only stamps, and re-ingest does not duplicate',async()=>{
    const source=require('../source');
    const hoursAgo=h=>new Date(Date.now()-h*3600000).toISOString();
    const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10)+'T00:00:00Z';
    const feed=[{url:'https://ledger.test/new-pm',company:'New',role:'Product Manager',posted_at:hoursAgo(3)},
      {url:'https://ledger.test/old-pm',company:'Old',role:'Product Manager',posted_at:hoursAgo(72)},
      {url:'https://ledger.test/new-eng',company:'New',role:'Backend Engineer',posted_at:hoursAgo(2)}];
    assert.equal(await db.upsertListings('We Work Remotely',feed),3);
    assert.equal(await db.upsertListings('We Work Remotely',feed),0,'Re-ingest adds nothing');
    await db.upsertListings('Sequoia job board',[{url:'https://ledger.test/seq-pm',company:'Seq',role:'Product Manager',posted_at:yesterday}]);
    for (const name of ['We Work Remotely','Sequoia job board']) await db.recordIngest(name,{ok:true,count:1,full:true});
    const [wwr,seq]=await source.ledgerResults(['We Work Remotely','Sequoia job board']);
    assert.deepEqual(wwr.allScanned.map(j=>j.url).sort(),['https://ledger.test/new-eng','https://ledger.test/new-pm']);
    assert.deepEqual(wwr.jobs.map(j=>j.url),['https://ledger.test/new-pm']);
    assert.equal(wwr.windowPrecision,'exact');assert.equal(wwr.rawCount,3);
    assert.deepEqual(seq.jobs.map(j=>j.url),['https://ledger.test/seq-pm']);assert.equal(seq.windowPrecision,'day');
  });
  await check('Role matching is word-based and rejects other functions',async()=>{
    const {roleMatcher}=require('../server/roles');
    const m=roleMatcher('Head of Product, Director of Product, VP of Product, Senior Product Manager, Group Product Manager, Founding PM, Head of Growth');
    for (const t of ['Director, Product Management','Sr. Product Manager, Payments','Vice President of Product','VP, Product','Senior Growth Product Manager, AI-Native','Senior SWE, AI Automation Engr, Senior PM','Founding Product Manager','Group PM, Platform']) assert.ok(m.test(t),t);
    for (const t of ['Senior Product Marketing Manager, Instacart+','Senior Manager, Product Design - Product Platform','Head of Growth Marketing','Director, Product Partnerships','Senior Software Engineer']) assert.ok(!m.test(t),t);
    assert.equal(roleMatcher('').test('Product Manager'),false);
  });
  await check('Agents can use MCP with an API key; keys cannot manage the account; revoked keys stop',async()=>{
    const owner='agent@audit.invalid';await balance(owner,25);
    await db.setProfile(owner,{email:owner,target_roles:'Product Manager'},true);
    const {id,key}=await db.createApiKey(owner,'Test agent');
    assert.match(key,/^aa_live_/);
    const rpc=async(body,k=key)=>{const r=await originalFetch(origin+'/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+k},body:JSON.stringify(body)});return {status:r.status,data:await r.json().catch(()=>null)};};
    const init=await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}}});
    assert.equal(init.data.result.protocolVersion,'2025-06-18');assert.equal(init.data.result.serverInfo.name,'applyapply');
    assert.equal((await originalFetch(origin+'/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})})).status,202);
    const tools=(await rpc({jsonrpc:'2.0',id:2,method:'tools/list'})).data.result.tools.map(t=>t.name);
    for (const t of ['search_listings','generate_application_kit','start_sourcing_run','get_account']) assert.ok(tools.includes(t),t);
    const account=JSON.parse((await rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'get_account',arguments:{}}})).data.result.content[0].text);
    assert.equal(account.email,owner);
    const search=JSON.parse((await rpc({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'search_listings',arguments:{window:'last_24_hours'}}})).data.result.content[0].text);
    assert.ok(search.listings.some(l=>l.url==='https://ledger.test/new-pm'),'Ledger listing found through MCP');
    const missing=(await rpc({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'get_application_kit',arguments:{url:'https://jobs.lever.co/none/none'}}})).data.result;
    assert.equal(missing.isError,true);
    assert.equal((await rpc({jsonrpc:'2.0',id:6,method:'tools/list'},'aa_live_notarealkey')).status,401);
    for (const [method,path] of [['GET','/api-keys'],['POST','/account/delete'],['GET','/account/export']]) {
      assert.equal((await originalFetch(origin+path,{method,headers:{'content-type':'application/json',authorization:'Bearer '+key},body:method==='POST'?'{}':undefined})).status,403,path);
    }
    assert.equal(await db.revokeApiKey(owner,id),true);
    assert.equal((await rpc({jsonrpc:'2.0',id:7,method:'tools/list'})).status,401,'Revoked key rejected');
    assert.equal((await rpc({jsonrpc:'2.0',id:8,method:'tools/list'},'')).status,401,'No key rejected');
  });
  await check('Search window is part of the cache key and honors date-only board stamps',async()=>{
    assert.notEqual(db.cacheKeyFor('Sequoia job board','',true,'remote',24),db.cacheKeyFor('Sequoia job board','',true,'remote',0));
    assert.notEqual(db.cacheKeyFor('Lever jobs (Google)','PM',false,'remote',24),db.cacheKeyFor('Lever jobs (Google)','PM',false,'remote',0));
    const source=require('../source');
    const now=Date.parse('2026-09-21T15:00:00Z');
    assert.equal(source.postedInWindow('2026-09-20T00:00:00Z',now),true);
    assert.equal(source.postedInWindow('2026-09-19T00:00:00Z',now),false);
    assert.equal(source.postedInWindow('2026-09-20T16:00:00Z',now),true);
    assert.equal(source.postedInWindow('2026-09-20T14:00:00Z',now),false);
    assert.equal(source.postedInWindow(null,now),true);
    assert.equal(source.windowPrecision({apiMode:{}},[{posted_at:'2026-09-20T16:00:00Z'}]),'exact');
    assert.equal(source.windowPrecision({apiMode:{}},[{posted_at:'2026-09-20T16:00:00Z'},{posted_at:'2026-09-20T00:00:00Z'}]),'day');
    assert.equal(source.windowPrecision({apiMode:{}},[{posted_at:null},{posted_at:'2026-09-20T16:00:00Z'}]),'partial');
    assert.equal(source.windowPrecision({googleSearch:true},[]),'search_date');
  });
  console.log(`\n${passed} adversarial regression groups passed. Providers mocked; DB and HTTP real.`);
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  global.fetch=originalFetch;if(worker)await worker.stop();if(server)await new Promise(r=>server.close(r));if(db)await db.pool.end();
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(e=>{console.error(e);process.exitCode=1;});await admin.end();
});
