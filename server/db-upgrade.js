const { canonicalUrl } = require('./posting');

module.exports = async function upgrade(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('applyapply-schema-v2',0))");
    await client.query(`
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS canonical_url TEXT;
      ALTER TABLE kits ADD COLUMN IF NOT EXISTS canonical_url TEXT;
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS detail JSONB;
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'succeeded';
      CREATE TABLE IF NOT EXISTS job_merge_archive (id TEXT PRIMARY KEY, data JSONB NOT NULL, merged_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS kit_versions (kit_id TEXT NOT NULL,user_email TEXT NOT NULL,version INTEGER NOT NULL,data JSONB NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW(),PRIMARY KEY(kit_id,version));
      CREATE TABLE IF NOT EXISTS user_activity (user_email TEXT NOT NULL,url TEXT NOT NULL,kind TEXT NOT NULL,data JSONB NOT NULL,updated_at TIMESTAMPTZ DEFAULT NOW(),PRIMARY KEY(user_email,url,kind));
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,user_email TEXT NOT NULL,action TEXT NOT NULL,request_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,resource_key TEXT NOT NULL,cost INTEGER NOT NULL CHECK(cost>=0),
        status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','refunded')),
        payload JSONB NOT NULL DEFAULT '{}',result JSONB,error TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW(),expires_at TIMESTAMPTZ,
        UNIQUE(user_email,request_key));
      ALTER TABLE operations ADD COLUMN IF NOT EXISTS provider_usage JSONB;
      CREATE UNIQUE INDEX IF NOT EXISTS operations_active_resource ON operations(user_email,action,resource_key) WHERE status IN ('queued','running');
      CREATE INDEX IF NOT EXISTS operations_pending ON operations(status,created_at);
      CREATE TABLE IF NOT EXISTS credit_ledger (id BIGSERIAL PRIMARY KEY,user_email TEXT NOT NULL,operation_id TEXT NOT NULL,kind TEXT NOT NULL,amount INTEGER NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW(),UNIQUE(operation_id,kind));
      CREATE TABLE IF NOT EXISTS operation_events (id BIGSERIAL PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES operations(id),message TEXT NOT NULL,created_at TIMESTAMPTZ DEFAULT NOW());
      CREATE INDEX IF NOT EXISTS operation_events_operation ON operation_events(operation_id,id);
      CREATE TABLE IF NOT EXISTS purchases (id TEXT PRIMARY KEY,user_email TEXT NOT NULL,session_id TEXT UNIQUE,price_id TEXT NOT NULL,currency TEXT NOT NULL,amount INTEGER NOT NULL,credits INTEGER NOT NULL,fulfilled_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT NOW());
    `);
    const rows = (await client.query('SELECT * FROM jobs WHERE canonical_url IS NULL ORDER BY found_at,id')).rows;
    const priority = { applied: 6, rejected: 5, skipped: 4, applying: 3, reviewed: 2, new: 1 };
    for (const row of rows) {
      let url; try { url = canonicalUrl(row.url); } catch { continue; }
      const duplicate = (await client.query('SELECT * FROM jobs WHERE user_email IS NOT DISTINCT FROM $1 AND canonical_url=$2', [row.user_email, url])).rows[0];
      if (!duplicate) { await client.query('UPDATE jobs SET canonical_url=$1 WHERE id=$2', [url, row.id]); continue; }
      // Preserve original records before merging variants. Applied/explicitly
      // dismissed states outrank new so a skipped posting cannot reappear.
      for (const original of [row, duplicate]) await client.query('INSERT INTO job_merge_archive(id,data) VALUES($1,$2) ON CONFLICT DO NOTHING', [original.id, JSON.stringify(original)]);
      const status = (priority[row.status] || 0) > (priority[duplicate.status] || 0) ? row.status : duplicate.status;
      await client.query(`UPDATE jobs SET status=$1,applied_at=GREATEST(applied_at,$2),kit_generated_at=GREATEST(kit_generated_at,$3),notes=$4 WHERE id=$5`,
        [status, row.applied_at, row.kit_generated_at, [...new Set([duplicate.notes,row.notes].filter(Boolean))].join('\n'), duplicate.id]);
      await client.query('UPDATE decisions SET job_id=$1 WHERE job_id=$2', [duplicate.id,row.id]);
      await client.query('DELETE FROM jobs WHERE id=$1', [row.id]);
    }
    for (const kit of (await client.query('SELECT id,url FROM kits WHERE canonical_url IS NULL')).rows) {
      try { await client.query('UPDATE kits SET canonical_url=$1 WHERE id=$2', [canonicalUrl(kit.url),kit.id]); } catch (e) { if (e.status !== 400) throw e; }
    }
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS jobs_owner_posting ON jobs(user_email,canonical_url);
      CREATE INDEX IF NOT EXISTS kits_owner_posting ON kits(user_email,canonical_url)`);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
};
