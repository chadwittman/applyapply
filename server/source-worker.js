const path = require('path');
const { spawn } = require('child_process');

module.exports = function sourceWorker(db, launch = spawn, notify = async () => {}) {
  const active = new Map();
  let timer, ticking = false, stopped = false;
  async function tick() {
    if (ticking || stopped) return;
    ticking = true;
    try {
      await db.recoverOperations();
      let op;
      while (!stopped && (op = await db.claimSourceOperation(2))) run(op);
    } catch (e) { console.error('[source worker]',e.message); }
    finally { ticking = false; }
  }
  function run(op) {
    const env = {};
    for (const name of ['PATH','NODE_ENV','DATABASE_URL','DATABASE_SSL','ANTHROPIC_API_KEY','HYPERBROWSER_API_KEY','TYPESAFE_API_KEY','JAA_JEV','JAA_JEV_MAX_REVIEWS','SOURCE_CACHE_HOURS']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    Object.assign(env,{ JAA_USER_EMAIL:op.user_email,JAA_OPERATION_ID:op.id,JAA_ENABLED_SOURCES:JSON.stringify(op.payload.sources),JAA_LOOKBACK_HOURS:String(op.payload.lookback_hours ?? 24),JAA_RUN_TRIGGER:op.payload.trigger || 'manual',
      ...(op.payload.roles?.length ? { JAA_TARGET_ROLES:op.payload.roles.join(', ') } : {}) });
    let child;
    try { child = launch(process.execPath,[path.join(__dirname,'../source.js')],{ env,cwd:path.join(__dirname,'..'),stdio:['ignore','pipe','pipe'] }); }
    catch (e) { db.finishOperation(op.id,op.user_email,{refund:true,message:'Sourcing could not start'}).catch(console.error); return; }
    active.set(op.id,child);
    let finished = false;
    const deadline = setTimeout(() => child.kill('SIGKILL'),20 * 60 * 1000);
    deadline.unref();
    const heartbeat = setInterval(async()=>{
      try { if (!await db.renewOperation(op.id,op.user_email)) child.kill('SIGTERM'); }
      catch { child.kill('SIGTERM'); }
    },30000);
    heartbeat.unref();
    let writes = Promise.resolve();
    const record = data => { writes = writes.then(()=>db.addOperationEvent(op.id,data.toString())).catch(e=>console.error('[source events]',e.message)); };
    child.stdout.on('data',record); child.stderr.on('data',record);
    async function end(code) {
      if (finished) return;
      finished = true; clearInterval(heartbeat); clearTimeout(deadline); active.delete(op.id);
      await writes;
      try {
        let current = await db.getOperation(op.id,op.user_email);
        if (current?.status === 'running') current = await db.finishOperation(op.id,op.user_email,{refund:true,message:code === 0 ? 'Sourcing produced no committed result' : 'Sourcing failed; credits returned'});
        if (current) await notify(current);
      } catch (e) { console.error('[source finalization]',e.message); }
      void tick();
    }
    child.once('error',()=>void end(1)); child.once('close',code=>void end(code));
  }
  return {
    start() { stopped=false; timer=setInterval(()=>void tick(),2000); timer.unref(); void tick(); },
    async stop() {
      stopped=true; clearInterval(timer);
      const waits=[...active.values()].map(child=>new Promise(resolve=>{ child.once('close',resolve); child.kill('SIGTERM'); }));
      await Promise.all(waits);
    },
    tick,
  };
};
