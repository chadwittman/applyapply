// Isolated local UI preview. No external credentials, payments or workers.
const os=require('node:os');
const crypto=require('node:crypto');
const {createRequire}=require('node:module');
const requireServer=createRequire(require('node:path').resolve(__dirname,'../server/package.json'));
const {Pool}=requireServer('pg');
const name='aa_preview_'+process.pid+'_'+Date.now();
const connection='postgresql://'+encodeURIComponent(process.env.PGUSER || os.userInfo().username)+'@127.0.0.1:5432/';
const admin=new Pool({connectionString:connection+'postgres',ssl:false});
const port=Number(process.env.AA_PREVIEW_PORT || 5100);
let db,server,closing=false;
async function close() {
  if(closing)return;closing=true;
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  if(db)await db.pool.end();
  await admin.query('DROP DATABASE IF EXISTS "'+name+'"');await admin.end();
}
(async()=>{
  await admin.query('CREATE DATABASE "'+name+'"');
  Object.assign(process.env,{DATABASE_URL:connection+name,DATABASE_SSL:'off',NODE_ENV:'test',
    APP_ORIGIN:'http://localhost:'+port,APPLYAPPLY_JWT_SECRET:crypto.randomBytes(32).toString('hex'),
    ANTHROPIC_API_KEY:'',OPENROUTER_API_KEY:'',HYPERBROWSER_API_KEY:'',RESEND_API_KEY:'',
    STRIPE_SECRET_KEY:'',STRIPE_WEBHOOK_SECRET:'',ALLOW_LOCAL_BYPASS:'false'});
  db=requireServer('./db');await db.initSchema();
  const email='preview@applyapply.test';await db.getOrCreateUser(email);await db.addUserCredits(email,100);
  await db.setProfile(email,{first_name:'Preview',last_name:'Candidate',email,target_roles:'Product Manager',location:'Chicago, IL',location_pref:'remote'},true);
  const job={company:'Example Company',role:'Product Manager',url:'https://jobs.lever.co/example/synthetic-preview',fit_score:8,location:'Remote',outcome:'added'};
  await db.saveSourceRun({id:'preview-run',date:new Date().toISOString().slice(0,10),sources:1,found:1,excluded:0,duration_ms:500,user_email:email},[{...job,source:'Synthetic preview',found_at:new Date().toISOString()}],{date:'Local preview',sources:[{name:'Synthetic preview',rawCount:1,jobs:[job]}]});
  const token=crypto.randomBytes(32).toString('hex');await db.createMagicLink(email,token,new Date(Date.now()+86400000).toISOString());
  server=requireServer('./server').app.listen(port,'127.0.0.1');
  server.on('error',async e=>{console.error(e.message);await close();process.exitCode=1;});
  server.on('listening',()=>{
    console.log('Preview: http://localhost:'+port);
    console.log('One-time sign-in: http://localhost:'+port+'/auth/verify?token='+token);
    console.log('Synthetic local data only. AI, Stripe, email and sourcing workers are disabled.');
  });
})().catch(async e=>{console.error(e);await close();process.exitCode=1;});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>close().then(()=>process.exit(0)));
