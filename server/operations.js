const crypto = require('crypto');
const { requireOwner, canonicalUrl, ownedId } = require('./posting');

module.exports = function operations(pool) {
  async function transaction(fn) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
    catch (e) { await c.query('ROLLBACK'); throw e; }
    finally { c.release(); }
  }
  const error = (status, message) => Object.assign(new Error(message), { status });

  async function reserveOperation({ userEmail, action, key = crypto.randomUUID(), resource = key, cost, payload = {}, queued = false }) {
    requireOwner(userEmail);
    if (!Number.isSafeInteger(cost) || cost < 0) throw new Error('Invalid credit cost');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([action,cost,payload])).digest('hex');
    return transaction(async c => {
      const user = (await c.query('SELECT * FROM users WHERE email=$1 FOR UPDATE', [userEmail])).rows[0];
      if (!user) throw error(401, 'Account not found');
      const prior = (await c.query('SELECT * FROM operations WHERE user_email=$1 AND request_key=$2', [userEmail,action + ':' + key])).rows[0];
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw error(409, 'Idempotency key was used for a different request');
        return { ...prior, replay: true };
      }
      const active = (await c.query("SELECT * FROM operations WHERE user_email=$1 AND action=$2 AND resource_key=$3 AND status IN ('queued','running')", [userEmail,action,resource])).rows[0];
      if (active) return { ...active, replay: true };
      const pending = Number((await c.query("SELECT COUNT(*) AS n FROM operations WHERE user_email=$1 AND status IN ('queued','running')", [userEmail])).rows[0].n);
      if (pending >= 4) throw error(429, 'Too many operations in progress');
      if (user.credits < cost) throw error(402, 'Insufficient credits');
      const id = crypto.randomUUID();
      await c.query('UPDATE users SET credits=credits-$1 WHERE email=$2', [cost,userEmail]);
      const op = (await c.query(`INSERT INTO operations(id,user_email,action,request_key,fingerprint,resource_key,cost,status,payload,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()+($10 || ' seconds')::interval) RETURNING *`,
      [id,userEmail,action,action + ':' + key,fingerprint,resource,cost,queued ? 'queued' : 'running',JSON.stringify(payload),queued ? '3600' : '150'])).rows[0];
      await c.query("INSERT INTO credit_ledger(user_email,operation_id,kind,amount) VALUES($1,$2,'reserve',$3)", [userEmail,id,-cost]);
      return op;
    });
  }

  async function finishOperation(id, userEmail, { result = null, refund = false, message = null, providerUsage = null } = {}) {
    return transaction(async c => {
      const op = (await c.query('SELECT * FROM operations WHERE id=$1 AND user_email=$2 FOR UPDATE', [id,requireOwner(userEmail)])).rows[0];
      if (!op) throw error(404, 'Operation not found');
      if (!['running','queued'].includes(op.status)) return op;
      if (!refund && new Date(op.expires_at) <= new Date()) throw error(409, 'Operation lease expired');
      if (refund) {
        await c.query('UPDATE users SET credits=credits+$1 WHERE email=$2', [op.cost,userEmail]);
        await c.query("INSERT INTO credit_ledger(user_email,operation_id,kind,amount) VALUES($1,$2,'refund',$3)", [userEmail,id,op.cost]);
      }
      return (await c.query('UPDATE operations SET status=$1,result=$2,error=$3,provider_usage=$4,updated_at=NOW() WHERE id=$5 RETURNING *',
        [refund ? 'refunded' : 'succeeded',JSON.stringify(result),message,providerUsage ? JSON.stringify(providerUsage) : null,id])).rows[0];
    });
  }

  async function renewOperation(id, userEmail) {
    const { rowCount } = await pool.query("UPDATE operations SET expires_at=NOW()+INTERVAL '150 seconds',updated_at=NOW() WHERE id=$1 AND user_email=$2 AND status='running' AND expires_at>NOW()", [id,requireOwner(userEmail)]);
    return rowCount === 1;
  }

  async function recoverOperations() {
    const { rows } = await pool.query("SELECT id,user_email FROM operations WHERE status IN ('running','queued') AND expires_at<NOW()");
    for (const row of rows) {
      await transaction(async c => {
        const op = (await c.query("SELECT * FROM operations WHERE id=$1 AND status IN ('running','queued') AND expires_at<NOW() FOR UPDATE", [row.id])).rows[0];
        if (!op) return;
        await c.query('UPDATE users SET credits=credits+$1 WHERE email=$2', [op.cost,op.user_email]);
        await c.query("INSERT INTO credit_ledger(user_email,operation_id,kind,amount) VALUES($1,$2,'refund',$3)", [op.user_email,op.id,op.cost]);
        await c.query("UPDATE operations SET status='refunded',error='Work interrupted; credits returned',updated_at=NOW() WHERE id=$1", [op.id]);
      });
    }
  }

  async function claimSourceOperation(limit = 2) {
    return transaction(async c => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('source-worker-capacity',0))");
      const count = Number((await c.query("SELECT COUNT(*) AS n FROM operations WHERE action='source' AND status='running'")).rows[0].n);
      if (count >= limit) return null;
      return (await c.query(`UPDATE operations SET status='running',expires_at=NOW()+INTERVAL '150 seconds',updated_at=NOW()
        WHERE id=(SELECT id FROM operations WHERE action='source' AND status='queued' AND expires_at>NOW() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`)).rows[0] || null;
    });
  }

  async function getOperation(id, userEmail) {
    return (await pool.query('SELECT * FROM operations WHERE id=$1 AND user_email=$2', [id,requireOwner(userEmail)])).rows[0] || null;
  }
  async function latestSourceOperation(userEmail) {
    return (await pool.query("SELECT * FROM operations WHERE user_email=$1 AND action='source' ORDER BY created_at DESC LIMIT 1", [requireOwner(userEmail)])).rows[0] || null;
  }
  async function addOperationEvent(id, message) {
    await pool.query('INSERT INTO operation_events(operation_id,message) VALUES($1,$2)', [id,String(message).slice(0,16000)]);
  }
  async function getOperationEvents(id, userEmail, after = 0) {
    return (await pool.query(`SELECT e.id,e.message FROM operation_events e JOIN operations o ON o.id=e.operation_id
      WHERE o.id=$1 AND o.user_email=$2 AND e.id>$3 ORDER BY e.id LIMIT 1000`, [id,requireOwner(userEmail),after])).rows;
  }

  // failedSources: names of sources that errored in this run. Their share of
  // the reserved credits is returned in the same transaction that commits
  // the run, so a partial run never charges for work it did not do.
  async function saveSourceRun(run, jobs, detail, operationId, failedSources = []) {
    requireOwner(run.user_email);
    return transaction(async c => {
      let op;
      if (operationId) {
        op = (await c.query("SELECT * FROM operations WHERE id=$1 AND user_email=$2 AND status='running' AND expires_at>NOW() FOR UPDATE", [operationId,run.user_email])).rows[0];
        if (!op) throw new Error('Sourcing operation is no longer active');
      }
      if (op && failedSources.length) {
        const names = op.payload?.sources || [];
        const prices = op.payload?.source_credits;
        const failed = failedSources.filter(name => names.includes(name));
        // Operations queued before per-source prices were recorded refund a proportional share.
        const refund = Math.min(op.cost, prices
          ? failed.reduce((n, name) => n + (Number(prices[name]) || 0), 0)
          : Math.floor(op.cost * failed.length / Math.max(names.length, 1)));
        if (refund > 0) {
          await c.query('UPDATE users SET credits=credits+$1 WHERE email=$2', [refund,run.user_email]);
          await c.query("INSERT INTO credit_ledger(user_email,operation_id,kind,amount) VALUES($1,$2,'partial_refund',$3) ON CONFLICT DO NOTHING", [run.user_email,op.id,refund]);
          detail.credits_refunded = refund;
        }
      }
      let added = 0;
      for (const job of jobs) {
        const url = canonicalUrl(job.url);
        const inserted = await c.query(`INSERT INTO jobs(id,url,canonical_url,company,role,ats,source,run_id,found_at,status,tier,fit_score,location,user_email)
          VALUES($1,$2,$2,$3,$4,$5,$6,$7,$8,'new',$9,$10,$11,$12) ON CONFLICT(user_email,canonical_url) DO NOTHING RETURNING id`,
        [ownedId('job',run.user_email,url),url,job.company,job.role,job.ats,job.source,run.id,job.found_at,job.tier,job.fit_score,job.location,run.user_email]);
        added += inserted.rowCount;
        if (!inserted.rowCount) {
          for (const source of detail.sources || []) for (const item of source.jobs || []) {
            if (canonicalUrl(item.url) === url) item.outcome = 'dupe';
          }
        }
      }
      detail.total_added = added;
      await c.query(`INSERT INTO runs(id,date,run_at,sources,found,added,excluded,duration_ms,user_email,detail,outcome)
        VALUES($1,$2,NOW(),$3,$4,$5,$6,$7,$8,$9,'succeeded')`,
      [run.id,run.date,run.sources,run.found,added,run.excluded,run.duration_ms,run.user_email,JSON.stringify(detail)]);
      if (op) await c.query("UPDATE operations SET status='succeeded',result=$1,updated_at=NOW() WHERE id=$2", [JSON.stringify({ run_id:run.id,added }),op.id]);
      return added;
    });
  }

  async function latestRunDetail(userEmail) {
    return (await pool.query('SELECT detail FROM runs WHERE user_email=$1 AND detail IS NOT NULL ORDER BY run_at DESC LIMIT 1', [requireOwner(userEmail)])).rows[0]?.detail || null;
  }
  async function saveActivity(userEmail, url, kind, data) {
    await pool.query(`INSERT INTO user_activity(user_email,url,kind,data) VALUES($1,$2,$3,$4)
      ON CONFLICT(user_email,url,kind) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()`, [requireOwner(userEmail),canonicalUrl(url),kind,JSON.stringify(data)]);
  }
  async function getActivity(userEmail, kind) {
    return (await pool.query('SELECT url,data FROM user_activity WHERE user_email=$1 AND kind=$2 ORDER BY updated_at DESC', [requireOwner(userEmail),kind])).rows.map(r=>({ ...r.data,url:r.url }));
  }

  return { reserveOperation,finishOperation,renewOperation,recoverOperations,claimSourceOperation,getOperation,latestSourceOperation,
    addOperationEvent,getOperationEvents,saveSourceRun,latestRunDetail,saveActivity,getActivity };
};
