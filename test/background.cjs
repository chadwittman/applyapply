const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
let onMessage,onExternal,onStorage,onClick;
const opened=[],scripts=[];
let state={apiKey:'alice',mode:'cloud'};
let calls=[];
const noop=()=>{};
const chrome={
  storage:{sync:{get:async()=>({...state}),remove:async()=>{},set:async values=>{state={...state,...values};}},onChanged:{addListener(fn){onStorage=fn;}}},
  runtime:{onMessage:{addListener(fn){onMessage=fn;}},onMessageExternal:{addListener(fn){onExternal=fn;}},onInstalled:{addListener:noop}},
  action:{setBadgeText:noop,setTitle:noop,onClicked:{addListener(fn){onClick=fn;}}},
  tabs:{onUpdated:{addListener:noop},onRemoved:{addListener:noop},create:async tab=>opened.push(tab),sendMessage:async()=>{throw new Error('not injected');}},
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
  chrome.tabs.sendMessage=async(_id,message)=>{assert.equal(message.type,'FORCE_INIT');return {ok:true};};
  await onClick({id:2,url:'https://jobs.ashbyhq.com/acme/job-id'});
  assert.equal(scripts.length,2,'Existing sidebar reopened without duplicate injection');
  const manifest=JSON.parse(fs.readFileSync(require('node:path').join(extensionDir,'manifest.json'),'utf8'));
  assert.equal(manifest.action.default_popup,undefined);
  assert.equal(manifest.content_scripts,undefined);
  assert.ok(!calls.some(call=>call.url.endsWith('/generate')),'Opening never generates');
  console.log('PASS: background waits for session, rejects stale-account messages and untrusted destinations, accepts canonical sign-in origin');
})().catch(error=>{console.error(error);process.exitCode=1;});
