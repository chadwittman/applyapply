// Drive the shipped content script in real Chrome with a simulated extension
// transport. This tests sidebar behavior, not Chrome permission grants.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const jwt = require('jsonwebtoken');
const db = require('./db');
const origin = process.env.APP_ORIGIN;
// A second pass against a frozen release shares this database, so it gets its own accounts.
const run = process.env.AA_EXTENSION_DIR ? '-' + process.pid : '';
const alice = `extension-alice${run}@test.local`, bob = `extension-bob${run}@test.local`;
const token = email => jwt.sign({ email },process.env.APPLYAPPLY_JWT_SECRET);
const url = 'https://jobs.lever.co/fixture/job-one';
for (const email of [alice,bob]) await db.getOrCreateUser(email);
await db.setProfile(alice,{ first_name:'Alice',email:alice,work_authorization:'yes',sponsorship:'no' },true);
await db.setProfile(bob,{ first_name:'Bob',email:bob },true);
await db.saveKit({ id:'extension-kit'+run,user_email:alice,url,company:'<img src=x onerror="window.INJECTED=1">',role:'PM',profile:{first_name:'STALE_IDENTITY'},tailored:{headline:'Draft'},
  tailored_resume:{name:'Alice',summary:'Draft',experience:[],skills:[],coverage:{confidence:'thin',gaps:['Describe a project you led.']}} });
const browser = await chromium.launch({headless:true,executablePath:process.env.AA_CHROME || undefined});
const page = await browser.newPage();
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
let evidenceWrites=0;
const mapCalls=[];
await page.exposeFunction('transport',async msg=>{
  if(msg.type!=='SERVER_FETCH') return {ok:false};
  if(new URL(msg.url).pathname==='/interview/context') evidenceWrites++;
  if(new URL(msg.url).pathname==='/fill/map'){
    mapCalls.push(JSON.parse(msg.options.body).labels);
    return {ok:true,status:200,data:{fields:[{label:'Name as it appears on your government ID',value:'Alice Nguyen'}]}};
  }
  const r=await fetch(msg.url,{method:msg.options.method,headers:msg.options.headers,body:msg.options.body || undefined});
  let data;try{data=await r.json();}catch{data=null;}
  return {ok:r.ok,status:r.status,data};
});
await page.route('https://jobs.lever.co/**',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><body>
  <h1>Product Manager</h1><form>
  <label for="name">First name</label><input id="name" value="User typed this">
  <label for="email">Email</label><input id="email" type="email">
  <label for="full">Full Name</label><input id="full">
  <label for="li">LinkedIn Profile URL</label><input id="li" type="url">
  <label for="site">Personal Website/Portfolio</label><input id="site" type="url">
  <label for="odd">Name as it appears on your government ID</label><input id="odd">
  <fieldset><legend>Do you have 10 years of experience?</legend><label><input type="radio" name="experience" value="yes">Yes</label><label><input type="radio" name="experience" value="no">No</label></fieldset>
  <label><input type="checkbox" id="consent">I agree to all terms</label>
  <label for="auth">Authorized to work?</label><select id="auth"><option value="">Choose</option><option value="yes">Yes</option><option value="no">No</option></select>
  </form></body></html>`}));
await page.goto(url);
await page.evaluate(({origin,key})=>{
  window.__storage={serverUrl:origin,apiKey:key,mode:'cloud',profile:{first_name:'WRONG_CACHED_PERSON'}};
  window.__listeners=[];
  window.__changeSession=async apiKey=>{
    const oldValue=window.__storage.apiKey; window.__storage.apiKey=apiKey;
    await Promise.all(window.__listeners.map(fn=>fn({apiKey:{oldValue,newValue:apiKey}},'sync')));
  };
  window.chrome={storage:{sync:{get(_keys,callback){const result={...window.__storage};if(callback){setTimeout(()=>callback(result),0);return;}return Promise.resolve(result);}},onChanged:{addListener(fn){window.__listeners.push(fn);}}},
    runtime:{onMessage:{addListener(fn){window.__onMessage=fn;}},sendMessage(msg,callback){
      if(msg.type==='GET_IFRAME_QUESTIONS'){callback?.({questions:[]});return;}
      if(msg.type!=='SERVER_FETCH'){callback?.({ok:false});return;}
      window.transport(msg).then(callback).catch(e=>callback?.({ok:false,error:e.message}));
    }}};
}, {origin,key:token(alice)});
try {
  // AA_EXTENSION_DIR runs this suite against a frozen release (see run.sh).
const extensionDir = process.env.AA_EXTENSION_DIR || new URL('../extension/',import.meta.url).pathname;
await page.addScriptTag({content:await readFile(extensionDir.replace(/\/?$/,'/')+'content.js','utf8')});
  await page.waitForSelector('#jaa-root'); await page.waitForTimeout(800);
  assert.deepEqual(errors,[], 'Content script boot errors');
  assert.ok(await page.locator('#jaa-root .sh-company').count(), 'Sidebar rendered');
  assert.equal(await page.locator('#jaa-tab').count(),0,'No collapsed edge tab');
  assert.ok(await page.locator('#jaa-sidebar').evaluate(el=>el.classList.contains('open')));
  await page.screenshot({path:'/tmp/applyapply-sidebar-desktop.png'});
  await page.setViewportSize({width:375,height:812});
  const bounds=await page.locator('#jaa-sidebar').boundingBox();
  assert.ok(bounds.x>=0 && bounds.x+bounds.width<=375,'Sidebar fits narrow viewport');
  await page.screenshot({path:'/tmp/applyapply-sidebar-mobile.png'});
  await page.setViewportSize({width:1280,height:720});
  assert.equal(await page.locator('#name').inputValue(),'User typed this');
  assert.equal(await page.locator('#email').inputValue(),'');
  assert.equal(await page.locator('input[type=radio]:checked').count(),0);
  assert.equal(await page.locator('#consent').isChecked(),false);
  assert.equal(await page.evaluate(()=>window.INJECTED),undefined);
  assert.equal(await page.locator('#jaa-root .sh-company img').count(),0);
  console.log('PASS: cached kit does not auto-fill or execute model HTML');
  await page.evaluate(()=>deterministicFill(currentApp));
  assert.equal(await page.locator('#name').inputValue(),'User typed this');
  assert.equal(await page.locator('#email').inputValue(),alice);
  assert.equal(await page.locator('#auth').inputValue(),'yes');
  assert.equal(await page.locator('input[type=radio]:checked').count(),0);
  assert.equal(await page.locator('#consent').isChecked(),false);
  console.log('PASS: explicit fill preserves existing answers and unknown qualifications');
  // Ashby's standard name field is "Full Name", which matched no rule at all,
  // and a profile with no LinkedIn or portfolio used to look like a fill that
  // silently skipped two fields. Shipped after store-1.19.3, so the frozen
  // release pass does not assert it.
  if (!process.env.AA_EXTENSION_DIR) {
    const det = await page.evaluate(()=>deterministicFill(currentApp));
    assert.equal(await page.locator('#full').inputValue(),'Alice','Full Name fills');
    assert.equal(await page.locator('#li').inputValue(),'','no LinkedIn on this profile');
    assert.deepEqual(det.missing,['LinkedIn URL','portfolio URL'],'the empty profile values are named, not counted as manual');
    console.log('PASS: Full Name fills; profile values a form needs are named');

    // What the rules cannot place goes to the server by label and comes back
    // as a value. A rule list cannot anticipate every wording; this can.
    const mappedCount = await page.evaluate(()=>mappedFill());
    assert.equal(await page.locator('#odd').inputValue(),'Alice Nguyen','an unanticipated label is filled by meaning');
    assert.equal(mappedCount,1);
    assert.ok(mapCalls.length===1,'one request for the whole form');
    assert.ok(mapCalls[0].includes('Name as it appears on your government ID'),'the unplaced label was sent');
    assert.ok(!mapCalls[0].includes('Email'),'a field the rules already filled is not sent');
    console.log('PASS: labels the rules miss are placed by meaning, in one request');
  }
  await page.evaluate(()=>{shadow.getElementById('jaa-sidebar').classList.add('open');});
  await page.locator('#jaa-resume-out .sec-hd').click();
  const answer=page.locator('#jaa-resume-out textarea').first();
  await answer.fill('I led the synthetic project with a team of four.');
  await page.waitForTimeout(1500);
  assert.ok((await db.getEvidence(alice,{answeredOnly:true})).some(x=>x.answer.includes('team of four')));
  console.log('PASS: sidebar autosave persists through real HTTP to Postgres');
  const versionState = await page.evaluate(()=>{
    const out=document.createElement('div'); document.body.appendChild(out);
    const previous={version:1,summary:'Old resume',experience:[],skills:[]};
    renderResume({version:2,summary:'New resume',experience:[],skills:[],resume_history:[previous]},out);
    out.querySelector('.sec-hd').click();
    const picker=out.querySelector('select');picker.value='1';picker.dispatchEvent(new Event('change'));
    const result={open:out.querySelector('.sec-body').style.display!=='none',text:out.querySelector('.prose').textContent};
    out.remove();return result;
  });
  assert.equal(versionState.open,true);assert.match(versionState.text,/Old resume/);
  const before=evidenceWrites;
  await answer.fill('DO_NOT_SAVE_TO_BOB');
  await page.evaluate(key=>window.__changeSession(key),token(bob));
  await page.waitForTimeout(1400);
  assert.equal(evidenceWrites,before);
  assert.deepEqual(await db.getEvidence(bob,{answeredOnly:true}),[]);
  const state=await page.evaluate(()=>({profile:mergeProfile(currentApp?.profile),kit:currentApp}));
  assert.equal(state.profile.first_name,'Bob');assert.equal(state.kit,null);
  await page.evaluate(()=>window.__changeSession(''));
  assert.equal(await page.locator('#jaa-root .sh-company').textContent(),'Not signed in');
  assert.equal((await page.evaluate(()=>mergeProfile(null))).email,'');
  assert.deepEqual(errors,[]);
  console.log('PASS: account switch cancels pending autosave and clears cached identity');
  assert.equal(await page.evaluate(()=>fieldLabelsMatch('Describe a problem you solved using AI','Describe a problem you solved')),false);
  assert.equal(await page.evaluate(()=>fieldLabelsMatch('GitHub URL','GitHub')),true);
  await page.evaluate(()=>dismissSidebar());
  await page.waitForTimeout(900);
  assert.equal(await page.locator('#jaa-root').count(),0);
  assert.equal(await page.locator('[data-jaa-copy]').count(),0);
  assert.equal(await page.evaluate(()=>document.body.style.marginRight),'');
  console.log('PASS: distinct questions stay distinct; dismissal removes sidebar and page artifacts');
  await page.evaluate(()=>window.__onMessage({type:'FORCE_INIT'},{},()=>{}));
  await page.waitForSelector('#jaa-root');
  assert.ok(await page.locator('#jaa-sidebar').evaluate(el=>el.classList.contains('open')));
  assert.equal(await page.locator('a[href$="/setup"]').textContent(),'My account ↗');
  console.log('PASS: toolbar restores dismissed sidebar without generation');
} finally { await browser.close();await db.pool.end(); }
