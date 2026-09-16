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
let db, server, origin, worker, modelResult, modelFailure = false, modelCalls = 0, passed = 0;
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
      return modelFailure ? new Response('{}',{status:503}) : Response.json({content:[{type:'text',text:JSON.stringify(modelResult)}]});
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
  console.log(`\n${passed} adversarial regression groups passed. Providers mocked; DB and HTTP real.`);
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  global.fetch=originalFetch;if(worker)await worker.stop();if(server)await new Promise(r=>server.close(r));if(db)await db.pool.end();
  await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(e=>{console.error(e);process.exitCode=1;});await admin.end();
});
