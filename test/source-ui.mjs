// Real browser, authenticated SSE and persisted run state; synthetic worker events.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../server/package.json',import.meta.url));
const {chromium}=require('playwright-core');
const jwt=require('jsonwebtoken'),db=require('./db');
const owner='source-ui@test.local';
await db.getOrCreateUser(owner);await db.addUserCredits(owner,10);
await db.saveSourceRun({id:'browser-source-run',date:'2026-09-16',sources:1,found:1,excluded:0,duration_ms:10,user_email:owner},[],{
  date:'2026-09-16',sources:[{name:'Synthetic source',rawCount:1,jobs:[{company:'Visible synthetic company',role:'Product Manager',url:'https://jobs.lever.co/fixture/one',outcome:'added'}]}],
});
const op=await db.reserveOperation({userEmail:owner,action:'source',cost:10});
await db.addOperationEvent(op.id,'Saved 1 new leads\n');
const browser=await chromium.launch({headless:true,executablePath:process.env.AA_CHROME || undefined});
const context=await browser.newContext({viewport:{width:1280,height:900}});
await context.addInitScript(token=>localStorage.setItem('aa_session',token),jwt.sign({email:owner},process.env.APPLYAPPLY_JWT_SECRET));
const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
  await page.goto(process.env.APP_ORIGIN+'/sourcing',{waitUntil:'domcontentloaded'});
  await page.locator('#source-results').getByText('Visible synthetic company',{exact:false}).waitFor();
  await page.locator('#live-feed').getByText('Saved 1 new leads',{exact:true}).waitFor();
  await db.addOperationEvent(op.id,'NEW: Second synthetic lead\n');
  await page.locator('#live-feed').getByText('NEW: Second synthetic lead',{exact:true}).waitFor();
  console.log('PASS: authenticated sourcing results and live SSE reach the browser');
  await db.finishOperation(op.id,owner,{refund:true,message:'Synthetic provider failure; credits returned'});
  await page.waitForFunction(()=>document.getElementById('rf-sub').textContent.includes('Synthetic provider failure'));
  assert.equal((await db.getUser(owner)).credits,10);
  await page.waitForFunction(()=>document.getElementById('balance-display').textContent==='10 cr');
  await page.screenshot({path:'/tmp/applyapply-sourcing-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'/tmp/applyapply-sourcing-mobile.png',fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS: durable failure is visible with credits refunded; desktop/mobile screenshots captured');
} finally {await browser.close();await db.pool.end();}
