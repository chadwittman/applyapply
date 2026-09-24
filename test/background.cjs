const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
let onMessage,onExternal,onStorage,onClick,onUpdated,onCreated;
const forced=[];
const tabs={};
const opened=[],scripts=[];
let state={apiKey:'alice',mode:'cloud'};
let calls=[];
const noop=()=>{};
const chrome={
  storage:{sync:{get:async()=>({...state}),remove:async()=>{},set:async values=>{state={...state,...values};}},onChanged:{addListener(fn){onStorage=fn;}}},
  runtime:{onMessage:{addListener(fn){onMessage=fn;}},onMessageExternal:{addListener(fn){onExternal=fn;}},onInstalled:{addListener:noop}},
  action:{setBadgeText:noop,setTitle:noop,onClicked:{addListener(fn){onClick=fn;}}},
  tabs:{onUpdated:{addListener(fn){onUpdated=fn;}},onCreated:{addListener(fn){onCreated=fn;}},onRemoved:{addListener:noop},
    create:async tab=>opened.push(tab),get:async id=>tabs[id],sendMessage:async()=>{throw new Error('not injected');}},
  scripting:{executeScript:async options=>{scripts.push(options);return [];}},
};
const extensionDir=process.env.AA_EXTENSION_DIR || require('node:path').join(__dirname,'../extension');
vm.runInNewContext(fs.readFileSync(require('node:path').join(extensionDir,'background.js'),'utf8'),{
  chrome,URL,crypto,console,fetch:async(url,options)=>{calls.push({url,options});return {ok:true,status:200,text:async()=>JSON.stringify({email:'synthetic@test.local'}),json:async()=>({email:'synthetic@test.local'})};},
});
const origin='https://applyapply.xyz';
const send=msg=>new Promise(resolve=>onMessage(msg,{},resolve));
const request=(key,url=origin+'/profile')=>send({type:'SERVER_FETCH',url,options:{headers:{'x-api-key':key}}});
(async()=>{
  assert.equal((await request('alice')).ok,true);
  assert.equal(calls[0].options.headers['x-api-key'],'alice');
  assert.equal((await request('alice','https://evil.invalid/profile')).ok,false);
  assert.equal(calls.length,1);
  state={...state,apiKey:'bob'};await onStorage({apiKey:{newValue:'bob'}},'sync');
  assert.equal((await request('alice')).ok,false);assert.equal(calls.length,1);
  assert.equal((await request('bob')).ok,true);assert.equal(calls[1].options.headers['x-api-key'],'bob');
  const external=await new Promise(resolve=>onExternal({type:'SET_SESSION',token:'valid-test-token'},{url:'https://evil.invalid/auth/success'},resolve));
  assert.equal(external.ok,false);
  const canonical=await new Promise(resolve=>onExternal({type:'SET_SESSION',token:'valid-test-token'},{url:'https://applyapply.xyz/auth/success'},resolve));
  assert.equal(canonical.ok,true);
  await onClick({id:1,url:'https://replit.com/@user/project'});
  assert.equal(opened[0].url,origin+'/pipeline');
  assert.equal(scripts.length,0);
  await onClick({id:2,url:'https://jobs.ashbyhq.com/acme/job-id'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(scripts.length,2);
  assert.ok(scripts[1].files.includes('content.js'));
  chrome.tabs.sendMessage=async(id,message)=>{assert.equal(message.type,'FORCE_INIT');forced.push(id);return {ok:true};};
  await onClick({id:2,url:'https://jobs.ashbyhq.com/acme/job-id'});
  assert.equal(scripts.length,2,'Existing sidebar reopened without duplicate injection');
  const manifest=JSON.parse(fs.readFileSync(require('node:path').join(extensionDir,'manifest.json'),'utf8'));
  assert.equal(manifest.action.default_popup,undefined);
  assert.equal(manifest.content_scripts,undefined);
  assert.ok(!calls.some(call=>call.url.endsWith('/generate')),'Opening never generates');
  // A job opened from applyapply's own pipeline is a decision to work on it.
  // Shipped after store-1.19.3, which registers no onCreated listener, so the
  // frozen replay skips it.
  if (onCreated) {
  // Asking for a second click on the toolbar to say so again is a step that
  // exists for no reason.
  const jobUrl='https://job-boards.greenhouse.io/acme/jobs/1?gh_jid=1';
  tabs[10]={id:10,url:origin+'/pipeline'};
  tabs[11]={id:11,url:jobUrl,openerTabId:10};
  await onCreated(tabs[11]);
  await onUpdated(11,{status:'complete'},tabs[11]);
  await new Promise(r=>setTimeout(r,50));
  assert.ok(forced.includes(11),'the sidebar opens by itself on a job we sent them to');

  // A job reached any other way still waits to be asked.
  tabs[20]={id:20,url:'https://news.ycombinator.com/'};
  tabs[21]={id:21,url:jobUrl.replace('/1?','/2?'),openerTabId:20};
  await onCreated(tabs[21]);
  await onUpdated(21,{status:'complete'},tabs[21]);
  await new Promise(r=>setTimeout(r,50));
  assert.ok(!forced.includes(21),'a job opened from somewhere else still waits to be asked');
  // And an ordinary page load on a job site is still not an invitation.
  tabs[30]={id:30,url:jobUrl.replace('/1?','/3?')};
  await onUpdated(30,{status:'complete'},tabs[30]);
  await new Promise(r=>setTimeout(r,50));
  assert.ok(!forced.includes(30),'landing on a job page by yourself opens nothing');
  console.log('PASS: a job opened from our own pipeline opens the sidebar; anywhere else waits');
  }

  console.log('PASS: background waits for session, rejects stale-account messages and untrusted destinations, accepts canonical sign-in origin');
})().catch(error=>{console.error(error);process.exitCode=1;});
