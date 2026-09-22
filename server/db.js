const { Pool } = require('pg');
const { canonicalUrl, ownedId, requireOwner } = require('./posting');
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to start the ApplyApply server');
}

// Railway's Postgres requires TLS; a local Postgres typically refuses it
// outright, which made it impossible to run the server against a scratch
// database. DATABASE_SSL=off opts out for local development and tests.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'off' ? false : { rejectUnauthorized: false },
});

async function q(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function q1(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

// ── Schema ────────────────────────────────────────────────────────────────────
// Idempotent: safe to run on every boot against a fresh or existing database.

async function initSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY,
      credits INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS profiles (
      api_key TEXT PRIMARY KEY,
      user_email TEXT,
      first_name TEXT, last_name TEXT, email TEXT, phone TEXT,
      linkedin TEXT, github TEXT, twitter TEXT, website TEXT,
      location TEXT, work_authorization TEXT, salary TEXT,
      current_employer TEXT, school TEXT, bio TEXT,
      career_type TEXT, target_roles TEXT, location_pref TEXT, search_mode TEXT DEFAULT 'active', resume_text TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // profiles already existed before resume_text was added — CREATE TABLE IF
  // NOT EXISTS above is a no-op against it, so add the column explicitly too.
  await q(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS resume_text TEXT`);
  await q(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS sponsorship TEXT`);
  await q(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS search_mode TEXT NOT NULL DEFAULT 'active'`);
  await q(`CREATE INDEX IF NOT EXISTS idx_profiles_user_email ON profiles (user_email)`);

  await q(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      date TEXT,
      run_at TIMESTAMPTZ,
      sources INTEGER DEFAULT 0,
      found INTEGER DEFAULT 0,
      added INTEGER DEFAULT 0,
      excluded INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      user_email TEXT
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      url TEXT UNIQUE NOT NULL,
      company TEXT, role TEXT, ats TEXT, source TEXT, run_id TEXT,
      found_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'new',
      tier INTEGER, fit_score INTEGER, location TEXT, notes TEXT,
      user_email TEXT,
      applied_at TIMESTAMPTZ,
      kit_generated_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ,
      status_updated_at TIMESTAMPTZ
    )
  `);

  // A job URL was UNIQUE across the whole table, which silently made the
  // product single-user: the first account to source a posting owned the only
  // row for it, and every later account's run reported the job as added while
  // inserting nothing. Uniqueness belongs per user, not per install.
  // COALESCE keeps legacy rows with a null owner in one bucket, since NULL
  // never equals NULL in a unique constraint.
  await q(`ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_url_key`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS jobs_owner_url_idx
           ON jobs (COALESCE(user_email, ''), url)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_jobs_user_email ON jobs (user_email)`);

  await q(`
    CREATE TABLE IF NOT EXISTS decisions (
      id SERIAL PRIMARY KEY,
      job_id TEXT,
      user_email TEXT,
      action TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Generated apply kits. Previously flat JSON files on the container's local
  // disk, which Railway wipes on every deploy — taking paid-for kits with it.
  await q(`
    CREATE TABLE IF NOT EXISTS kits (
      id TEXT PRIMARY KEY,
      url TEXT,
      user_email TEXT,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await q(`CREATE INDEX IF NOT EXISTS idx_kits_user_email ON kits (user_email)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_kits_url ON kits (url)`);

  // Evidence gathered by interviewing the candidate about work their resume
  // doesn't show. A resume is written for the role you had, so applying across
  // a boundary (CEO -> PM) leaves the relevant experience unstated. Tailoring
  // may only reuse what already exists, so this is the one honest way to add
  // real material rather than letting the model invent it.
  await q(`
    CREATE TABLE IF NOT EXISTS evidence (
      id SERIAL PRIMARY KEY,
      user_email TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT,
      theme TEXT,
      job_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await q(`CREATE INDEX IF NOT EXISTS idx_evidence_user ON evidence (user_email)`);

  // Small key/value store for settings that must outlive a deploy. The sourcing
  // schedule lived in logs/schedule.json on the ephemeral disk, so every deploy
  // reset it to disabled and silently stopped the nightly run.
  await q(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Per-user sourcing schedule. Each user picks their own time and sources,
  // and pays their own credits for the run.
  await q(`
    CREATE TABLE IF NOT EXISTS schedules (
      user_email TEXT PRIMARY KEY,
      hour INTEGER NOT NULL DEFAULT 6,
      minute INTEGER NOT NULL DEFAULT 0,
      frequency TEXT NOT NULL DEFAULT 'daily',
      enabled BOOLEAN NOT NULL DEFAULT false,
      sources JSONB,
      last_run_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await q(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS frequency TEXT NOT NULL DEFAULT 'daily'`);
  await q(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS lookback_hours INTEGER NOT NULL DEFAULT 24`);
  // How many of each run's best new matches get a kit written right away.
  await q(`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS auto_kits INTEGER NOT NULL DEFAULT 0`);

  // Shared source results. Board scrapes return the same jobs for everyone, and
  // the Google sources vary only by role titles — so the key is source + role
  // set. One fetch serves every user who wants that combination.
  await q(`
    CREATE TABLE IF NOT EXISTS source_cache (
      cache_key TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      role_key TEXT NOT NULL DEFAULT '',
      payload JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await q(`CREATE INDEX IF NOT EXISTS idx_source_cache_fetched ON source_cache (fetched_at)`);

  // Our own ledger of public listings. A shared ingest adds each source's new
  // jobs every few hours, so user runs read from here instead of re-browsing
  // the boards. Nothing in it belongs to a user.
  await q(`
    CREATE TABLE IF NOT EXISTS listings (
      url TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      company TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      location TEXT NOT NULL DEFAULT '',
      remote BOOLEAN,
      posted_at TIMESTAMPTZ,
      posted_precision TEXT,
      salary JSONB,
      snippet TEXT NOT NULL DEFAULT '',
      first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await q(`CREATE INDEX IF NOT EXISTS idx_listings_source_posted ON listings (source, COALESCE(posted_at, first_seen) DESC)`);
  // The candidate's resume split into roles and bullets, verbatim, keyed by a
  // hash of the resume text so a new upload rebuilds it.
  await q(`
    CREATE TABLE IF NOT EXISTS resume_structures (
      user_email TEXT PRIMARY KEY,
      source_hash TEXT NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // "Make this better" notes from people, and postings we could not read.
  await q(`
    CREATE TABLE IF NOT EXISTS feedback (
      id BIGSERIAL PRIMARY KEY,
      user_email TEXT,
      kind TEXT NOT NULL DEFAULT 'idea',
      message TEXT NOT NULL,
      context JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Private, expiring links to one kit (/k/<token>), sent to the kit's owner
  // by text so their phone can open the kit without signing in.
  await q(`
    CREATE TABLE IF NOT EXISTS kit_shares (
      token TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
      kit_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await q(`CREATE INDEX IF NOT EXISTS idx_kit_shares_kit ON kit_shares (user_email, kit_id)`);

  // Text-message conversations (the /imessage test line now, Sendblue later).
  await q(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGSERIAL PRIMARY KEY,
      user_email TEXT NOT NULL,
      direction TEXT NOT NULL,
      body TEXT NOT NULL,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await q(`CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages (user_email, id)`);

  // Personal API keys for agents. Only a SHA-256 of the key is stored.
  await q(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    )
  `);
  await q(`CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_email)`);
  await q(`
    CREATE TABLE IF NOT EXISTS ingest_state (
      source TEXT PRIMARY KEY,
      last_ok_at TIMESTAMPTZ,
      last_full_at TIMESTAMPTZ,
      last_attempt_at TIMESTAMPTZ,
      last_count INTEGER,
      last_error TEXT
    )
  `);

  // The uploaded PDF itself, kept out of profiles so a SELECT * on a profile
  // does not drag several megabytes along with it.
  await q(`
    CREATE TABLE IF NOT EXISTS resume_files (
      user_email TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      mime TEXT NOT NULL DEFAULT 'application/pdf',
      bytes BYTEA NOT NULL,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS magic_links (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    )
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS stripe_events (
      event_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      credits INTEGER NOT NULL,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await require('./db-upgrade')(pool);
}

// ── Runs ──────────────────────────────────────────────────────────────────────

async function insertRun(run) {
  await q(`
    INSERT INTO runs (id, date, run_at, sources, found, added, excluded, duration_ms, user_email)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (id) DO UPDATE SET
      found = EXCLUDED.found, added = EXCLUDED.added, excluded = EXCLUDED.excluded,
      duration_ms = EXCLUDED.duration_ms
  `, [run.id, run.date, run.run_at, run.sources||0, run.found||0, run.added||0, run.excluded||0, run.duration_ms||0, run.user_email||null]);
}

async function getRuns(limit = 30, userEmail = null) {
  return q(`SELECT * FROM runs WHERE user_email = $1 ORDER BY run_at DESC LIMIT $2`, [requireOwner(userEmail), limit]);
}

async function getRun(id, userEmail) {
  return q1(`SELECT * FROM runs WHERE id = $1 AND user_email = $2`, [id, requireOwner(userEmail)]);
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

// jobs.id is a readable slug derived from company + role + date, so two users
// who source the same posting on the same day produce the same id and collide
// on the primary key. Qualify it by owner. Rows with no owner keep the bare id
// so existing ids are unchanged.
async function insertJob(job) {
  job = { ...job, url: canonicalUrl(job.url) };
  requireOwner(job.user_email);
  await q(`
    INSERT INTO jobs (id, url, company, role, ats, source, run_id, found_at, status, tier, fit_score, location, notes, user_email, canonical_url)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$2)
    ON CONFLICT (user_email, canonical_url) DO NOTHING
  `, [ownedId('job', job.user_email, job.url), job.url, job.company, job.role, job.ats||null, job.source||null, job.run_id||null,
      job.found_at, job.status||'new', job.tier||null, job.fit_score||null,
      job.location||null, job.notes||'', job.user_email||null]);
}

async function upsertJob(job) {
  job = { ...job, url: canonicalUrl(job.url) };
  requireOwner(job.user_email);
  await q(`
    INSERT INTO jobs (id, url, company, role, ats, source, run_id, found_at, status, tier, fit_score, location, notes, user_email, canonical_url)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$2)
    ON CONFLICT (user_email, canonical_url) DO UPDATE SET
      company    = EXCLUDED.company,
      role       = EXCLUDED.role,
      source     = COALESCE(jobs.source, EXCLUDED.source),
      tier       = EXCLUDED.tier,
      fit_score  = EXCLUDED.fit_score,
      location   = EXCLUDED.location,
      updated_at = NOW()
    WHERE jobs.status = 'new'
  `, [ownedId('job', job.user_email, job.url), job.url, job.company, job.role, job.ats||null, job.source||null, job.run_id||null,
      job.found_at, job.status||'new', job.tier||null, job.fit_score||null,
      job.location||null, job.notes||'', job.user_email||null]);
}

// A direct kit and a sourced posting share the same owner-scoped identity.
async function ensureJob(job) {
  await insertJob(job);
  return (await getJobByUrl(job.url, job.user_email)).id;
}

async function setJobStatus(url, status, extra = {}, userEmail = null) {
  // q returns rows, so RETURNING is how this reports whether anything matched.
  const rows = await q(`
    UPDATE jobs SET status = $1, applied_at = COALESCE($2, applied_at),
      notes = COALESCE($3, notes), updated_at = NOW(), status_updated_at = NOW()
    WHERE canonical_url = $4 AND user_email = $5
    RETURNING id
  `, [status, extra.applied_at||null, extra.notes||null, canonicalUrl(url), requireOwner(userEmail)]);
  return rows.length;
}

async function setKitGenerated(url, userEmail = null) {
  await q(`UPDATE jobs SET kit_generated_at = NOW()
           WHERE canonical_url = $1 AND user_email = $2`,
          [canonicalUrl(url), requireOwner(userEmail)]);
}

async function getJobByUrl(url, userEmail = null) {
  return q1(`SELECT * FROM jobs WHERE canonical_url = $1 AND user_email = $2`, [canonicalUrl(url), requireOwner(userEmail)]);
}

async function getJobs(status = null, limit = 200, userEmail = null) {
  requireOwner(userEmail);
  if (status) return q('SELECT * FROM jobs WHERE status=$1 AND user_email=$2 ORDER BY found_at DESC,fit_score DESC LIMIT $3', [status,userEmail,limit]);
  return q('SELECT * FROM jobs WHERE user_email=$1 ORDER BY found_at DESC,fit_score DESC LIMIT $2', [userEmail,limit]);
}

async function getJobsForRun(runId, userEmail) {
  return q(`SELECT * FROM jobs WHERE run_id = $1 AND user_email = $2 ORDER BY fit_score DESC`, [runId, requireOwner(userEmail)]);
}

async function getSeenUrls(userEmail) {
  const rows = await q('SELECT canonical_url FROM jobs WHERE user_email=$1 AND canonical_url IS NOT NULL', [requireOwner(userEmail)]);
  return new Set(rows.map(r => r.canonical_url));
}

// What the user actually wants to know: how much ground we covered, over what
// window, and how much of it is still theirs to work through.
async function getCoverage(userEmail) {
  const runs = await q(
    `SELECT COUNT(*)::int AS runs, COALESCE(SUM(found),0)::int AS scanned,
            COALESCE(SUM(added),0)::int AS added, MAX(run_at) AS last_run,
            MIN(run_at) AS first_run
     FROM runs WHERE user_email = $1 AND run_at > NOW() - INTERVAL '30 days'`,
    [userEmail]
  );
  const companies = await q1(
    `SELECT COUNT(DISTINCT company)::int AS n FROM jobs WHERE user_email = $1`, [userEmail]
  );
  return { ...(runs[0] || {}), companies: companies?.n || 0 };
}

async function getStatusCounts(userEmail = null) {
  requireOwner(userEmail);
  const rows = userEmail
    ? await q(`SELECT status, COUNT(*) as n FROM jobs WHERE user_email = $1 GROUP BY status`, [userEmail])
    : await q(`SELECT status, COUNT(*) as n FROM jobs GROUP BY status`);
  const out = { new: 0, reviewed: 0, applying: 0, applied: 0, skipped: 0, rejected: 0 };
  for (const r of rows) out[r.status] = (out[r.status] || 0) + Number(r.n);
  return out;
}

// ── Decisions (preference signals) ───────────────────────────────────────────

async function recordDecision(jobId, userEmail, action) {
  await q(`INSERT INTO decisions (job_id, user_email, action) VALUES ($1,$2,$3)`, [jobId||null, userEmail, action]);
}

async function getDecisionSummary(userEmail) {
  return q(`
    SELECT j.source, j.tier, j.fit_score, d.action, COUNT(*) as n
    FROM decisions d
    LEFT JOIN jobs j ON j.id = d.job_id
    WHERE d.user_email = $1
    GROUP BY j.source, j.tier, j.fit_score, d.action
    ORDER BY n DESC
  `, [userEmail]);
}

// ── Profiles ──────────────────────────────────────────────────────────────────

const PROFILE_FIELDS = ['first_name','last_name','email','phone','linkedin','github','twitter','website',
  'location','work_authorization','sponsorship','salary','current_employer','school','bio','career_type','target_roles','location_pref','search_mode','resume_text'];

async function getProfile(apiKey) {
  return q1(`SELECT * FROM profiles WHERE api_key = $1`, [apiKey]);
}

async function getProfileByUserEmail(userEmail) {
  return q1(`SELECT * FROM profiles WHERE user_email = $1`, [userEmail]);
}

// Partial update: only writes fields actually supplied. Different clients post
// different subsets (the setup page sends everything, the extension popup sends
// 8 contact fields), so an absent field must mean "leave alone" — writing null
// for it let the extension's save silently wipe bio, resume_text, target_roles…
async function setProfile(key, data, isEmail = false) {
  const fields = PROFILE_FIELDS.filter(f => data[f] !== undefined);
  if (!fields.length) return;
  const vals = fields.map(f => data[f]);

  if (isEmail) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['profile:' + key]);
      const existing = (await client.query('SELECT api_key FROM profiles WHERE user_email=$1', [key])).rows[0];
      const cols = ['api_key', 'user_email', ...fields].join(', ');
      const placeholders = ['api_key', 'user_email', ...fields].map((_, i) => '$' + (i + 1)).join(', ');
      const updates = fields.map(f => f + ' = EXCLUDED.' + f).join(', ');
      await client.query('INSERT INTO profiles (' + cols + ') VALUES (' + placeholders + ') ON CONFLICT (api_key) DO UPDATE SET ' + updates + ', updated_at=NOW()', [existing?.api_key || 'email:' + key,key,...vals]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } else {
    const cols = ['api_key', ...fields].join(', ');
    const placeholders = ['api_key', ...fields].map((_, i) => `$${i + 1}`).join(', ');
    const updates = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    await q(`
      INSERT INTO profiles (${cols}) VALUES (${placeholders})
      ON CONFLICT (api_key) DO UPDATE SET ${updates}, updated_at = NOW()
    `, [key, ...vals]);
  }
}

// ── Users ─────────────────────────────────────────────────────────────────────

async function getUser(email) {
  return q1(`SELECT * FROM users WHERE email = $1`, [email]);
}

// New accounts get enough credits to try a couple of kits (and so store
// reviewers can test generation). Granted once per address, via the ledger.
function starterCredits() {
  const n = Number(process.env.STARTER_CREDITS ?? 30);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

async function getOrCreateUser(email) {
  const grant = starterCredits();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = await client.query(`INSERT INTO users (email, credits, created_at) VALUES ($1, 0, $2) ON CONFLICT DO NOTHING RETURNING email`,
      [email, new Date().toISOString()]);
    // The ledger survives account deletion, so deleting and re-creating an
    // account does not earn a second grant.
    if (created.rowCount && grant) {
      const granted = await client.query(`INSERT INTO credit_ledger (user_email, operation_id, kind, amount) VALUES ($1, $2, 'starter', $3) ON CONFLICT DO NOTHING RETURNING id`,
        [email, 'starter:' + email, grant]);
      if (granted.rowCount) await client.query(`UPDATE users SET credits = $1 WHERE email = $2`, [grant, email]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
  return q1(`SELECT * FROM users WHERE email = $1`, [email]);
}

async function addUserCredits(email, amount) {
  await q(`UPDATE users SET credits = credits + $1 WHERE email = $2`, [amount, email]);
}

async function deductUserCredits(email, amount) {
  return q1(`
    UPDATE users
    SET credits = credits - $1
    WHERE email = $2 AND credits >= $1
    RETURNING credits
  `, [amount, email]);
}

// A small charge outside the operations flow (a long voice note, say), with a
// ledger line so it shows in the account export. Returns false if short.
async function chargeCredits(userEmail, amount, kind) {
  const owner = requireOwner(userEmail);
  if (!Number.isInteger(amount) || amount <= 0) return true;
  const row = await deductUserCredits(owner, amount);
  if (!row) return false;
  await q(`INSERT INTO credit_ledger (user_email, operation_id, kind, amount) VALUES ($1,$2,$3,$4)`,
    [owner, kind + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 8), kind, -amount]);
  return true;
}

async function countVoiceNotesToday(userEmail) {
  const row = await q1(`SELECT COUNT(*)::int AS n FROM chat_messages WHERE user_email=$1 AND direction='in' AND (meta->>'voice')::boolean AND created_at > NOW() - INTERVAL '24 hours'`, [requireOwner(userEmail)]);
  return row?.n || 0;
}

// ── Kits ──────────────────────────────────────────────────────────────────────

async function saveKit(kit) {
  requireOwner(kit.user_email);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['kit:' + kit.id]);
    const prior = (await client.query('SELECT * FROM kits WHERE id=$1 FOR UPDATE', [kit.id])).rows[0];
    if (prior && prior.user_email !== kit.user_email) throw new Error('Kit ownership cannot change');
    if (prior && kit.version != null && kit.version !== prior.data.version) throw Object.assign(new Error('Kit changed during this request; reload before retrying'), { status: 409 });
    const version = (prior?.data?.version || 0) + 1;
    kit = { ...kit, url: canonicalUrl(kit.url), version };
    delete kit.urls;
    if (prior) await client.query(`INSERT INTO kit_versions (kit_id,user_email,version,data)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [kit.id, kit.user_email, prior.data.version || 0, JSON.stringify(prior.data)]);
    await client.query(`INSERT INTO kits (id,url,user_email,data,canonical_url) VALUES ($1,$2,$3,$4,$2)
      ON CONFLICT (id) DO UPDATE SET url=EXCLUDED.url, canonical_url=EXCLUDED.canonical_url,
      data=EXCLUDED.data, updated_at=NOW() WHERE kits.user_email=EXCLUDED.user_email`,
    [kit.id, kit.url, kit.user_email, JSON.stringify(kit)]);
    await client.query('COMMIT');
    return kit;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function getKit(id, userEmail) {
  const row = await q1(`SELECT data FROM kits WHERE id = $1 AND user_email=$2`, [id, requireOwner(userEmail)]);
  return row ? row.data : null;
}

async function findKit(url, userEmail) {
  const row = await q1(`SELECT data FROM kits WHERE user_email=$1 AND canonical_url=$2 ORDER BY updated_at DESC LIMIT 1`,
    [requireOwner(userEmail), canonicalUrl(url)]);
  return row?.data || null;
}

async function getKitVersions(id, userEmail) {
  return q(`SELECT version,data,created_at FROM kit_versions WHERE kit_id=$1 AND user_email=$2 ORDER BY version DESC`, [id, requireOwner(userEmail)]);
}

async function getKits(userEmail) {
  const rows = await q('SELECT data FROM kits WHERE user_email=$1 ORDER BY updated_at DESC', [requireOwner(userEmail)]);
  return rows.map(r => r.data);
}

async function deleteKit(id, userEmail) {
  await q(`DELETE FROM kits WHERE id = $1 AND user_email=$2`, [id, requireOwner(userEmail)]);
}

async function deleteKitsForUser(userEmail) {
  const rows = await q(`DELETE FROM kits WHERE user_email = $1 RETURNING id`, [userEmail]);
  return rows.length;
}

async function countKits() {
  const row = await q1(`SELECT COUNT(*)::int AS n FROM kits`);
  return row?.n || 0;
}

// ── Evidence (interview answers) ──────────────────────────────────────────────

async function getEvidence(userEmail, { answeredOnly = false } = {}) {
  const sql = answeredOnly
    ? `SELECT * FROM evidence WHERE user_email = $1 AND answer IS NOT NULL AND answer <> '' ORDER BY created_at`
    : `SELECT * FROM evidence WHERE user_email = $1 ORDER BY created_at`;
  return q(sql, [userEmail]);
}

async function addEvidenceQuestions(userEmail, items) {
  for (const it of items) {
    // Same question twice adds nothing — the point is to fill gaps, not re-ask.
    const dupe = await q1(
      `SELECT id FROM evidence WHERE user_email = $1 AND lower(question) = lower($2)`,
      [userEmail, it.question]
    );
    if (dupe) continue;
    await q(
      `INSERT INTO evidence (user_email, question, theme, job_url) VALUES ($1,$2,$3,$4)`,
      [userEmail, it.question, it.theme || null, it.job_url || null]
    );
  }
  return getEvidence(userEmail);
}

// Context the user volunteers against a named gap, rather than against a
// question we generated. Same store, so it feeds generation identically.
async function addAnsweredEvidence(userEmail, question, answer, theme = null) {
  const existing = await q1(
    `SELECT id FROM evidence WHERE user_email = $1 AND lower(question) = lower($2)`,
    [userEmail, question]
  );
  if (existing) {
    return q1(`UPDATE evidence SET answer = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [existing.id, answer]);
  }
  return q1(
    `INSERT INTO evidence (user_email, question, answer, theme) VALUES ($1,$2,$3,$4) RETURNING *`,
    [userEmail, question, answer, theme]
  );
}

async function setEvidenceAnswer(userEmail, id, answer) {
  return q1(
    `UPDATE evidence SET answer = $3, updated_at = NOW()
     WHERE id = $1 AND user_email = $2 RETURNING *`,
    [id, userEmail, answer]
  );
}

async function deleteEvidence(userEmail, id) {
  await q(`DELETE FROM evidence WHERE id = $1 AND user_email = $2`, [id, userEmail]);
}

// ── Resume file ───────────────────────────────────────────────────────────────

async function saveResumeFile(userEmail, filename, mime, buffer) {
  await q(`
    INSERT INTO resume_files (user_email, filename, mime, bytes, uploaded_at)
    VALUES ($1,$2,$3,$4,NOW())
    ON CONFLICT (user_email) DO UPDATE SET
      filename = EXCLUDED.filename, mime = EXCLUDED.mime,
      bytes = EXCLUDED.bytes, uploaded_at = NOW()
  `, [userEmail, filename, mime, buffer]);
}

async function getResumeFile(userEmail) {
  return q1(`SELECT filename, mime, bytes, uploaded_at FROM resume_files WHERE user_email = $1`, [userEmail]);
}

async function getResumeFileMeta(userEmail) {
  return q1(`SELECT filename, uploaded_at, octet_length(bytes) AS size FROM resume_files WHERE user_email = $1`, [userEmail]);
}

// ── Source cache ──────────────────────────────────────────────────────────────

// Role titles decide the Google query, so they are part of the identity of a
// cached result. Normalized so "Head of Product, VP Product" and
// "vp product,  head of product" share one entry.
function roleKeyFor(roleTitles) {
  return String(roleTitles || '')
    .split(',').map(r => r.trim().toLowerCase()).filter(Boolean).sort().join('|');
}

// The search window is part of the identity too: a last-24-hours fetch must
// never be served to an all-listings run, or the reverse.
function cacheKeyFor(source, roleTitles, sharedAcrossRoles = false, locationPref = 'remote', lookbackHours = 24) {
  const windowKey = lookbackHours === 24 ? 'w24' : 'all';
  return sharedAcrossRoles ? `v3::${source}::*::${windowKey}` : `v3::${source}::${roleKeyFor(roleTitles)}::${locationPref}::${windowKey}`;
}

async function getCachedSources(keys, maxAgeHours = 20) {
  if (!keys.length) return {};
  const rows = await q(
    `SELECT cache_key, payload FROM source_cache
     WHERE cache_key = ANY($1) AND fetched_at > NOW() - ($2 || ' hours')::interval`,
    [keys, String(maxAgeHours)]
  );
  return Object.fromEntries(rows.map(r => [r.cache_key, r.payload]));
}

// ── Resume structure cache ────────────────────────────────────────────────────

async function getResumeStructure(userEmail) {
  return q1(`SELECT source_hash, data FROM resume_structures WHERE user_email=$1`, [requireOwner(userEmail)]);
}
async function saveResumeStructure(userEmail, sourceHash, data) {
  await q(`INSERT INTO resume_structures (user_email, source_hash, data) VALUES ($1,$2,$3)
    ON CONFLICT (user_email) DO UPDATE SET source_hash=EXCLUDED.source_hash, data=EXCLUDED.data, created_at=NOW()`,
  [requireOwner(userEmail), sourceHash, JSON.stringify(data)]);
}

async function addFeedback({ userEmail = null, kind = 'idea', message, context = null }) {
  return q1(`INSERT INTO feedback (user_email, kind, message, context) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
    [userEmail, kind, String(message).slice(0, 8000), context ? JSON.stringify(context) : null]);
}

// One report per thing per day is enough to act on.
async function feedbackSeenToday(kind, fingerprint) {
  const row = await q1(`SELECT 1 FROM feedback WHERE kind=$1 AND context->>'fingerprint'=$2 AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`, [kind, fingerprint]);
  return !!row;
}

// ── Kit links ─────────────────────────────────────────────────────────────────

// One live link per kit: reuse it while it has at least a week left.
async function kitShareToken(userEmail, kitId, days = 30) {
  const owner = requireOwner(userEmail);
  const live = await q1(`SELECT token FROM kit_shares WHERE user_email=$1 AND kit_id=$2 AND expires_at > NOW() + INTERVAL '7 days' ORDER BY expires_at DESC LIMIT 1`, [owner, kitId]);
  if (live) return live.token;
  const token = require('crypto').randomBytes(12).toString('base64url');
  await q(`INSERT INTO kit_shares (token, user_email, kit_id, expires_at) VALUES ($1,$2,$3,NOW() + ($4 || ' days')::interval)`, [token, owner, kitId, String(days)]);
  return token;
}
async function kitForShare(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(token)) return null;
  const share = await q1(`SELECT user_email, kit_id, expires_at FROM kit_shares WHERE token=$1 AND expires_at > NOW()`, [token]);
  if (!share) return null;
  const kit = await getKit(share.kit_id, share.user_email);
  return kit ? { kit, owner: share.user_email, expires_at: share.expires_at } : null;
}

// ── Chat messages ─────────────────────────────────────────────────────────────

async function addChatMessage(userEmail, direction, body, meta = null) {
  return q1(`INSERT INTO chat_messages (user_email, direction, body, meta) VALUES ($1,$2,$3,$4) RETURNING id`,
    [requireOwner(userEmail), direction, String(body).slice(0, 8000), meta ? JSON.stringify(meta) : null]);
}
async function getChatMessages(userEmail, afterId = 0) {
  return q(`SELECT id, direction, body, created_at, COALESCE((meta->>'voice')::boolean, false) AS voice FROM chat_messages WHERE user_email=$1 AND id>$2 ORDER BY id LIMIT 500`, [requireOwner(userEmail), Number(afterId) || 0]);
}
async function lastChatMeta(userEmail, kind) {
  return q1(`SELECT id, meta FROM chat_messages WHERE user_email=$1 AND direction='out' AND meta->>'kind'=$2 ORDER BY id DESC LIMIT 1`, [requireOwner(userEmail), kind]);
}
// The most recent message we sent that asked for something specific.
async function lastChatPrompt(userEmail, kinds) {
  return q1(`SELECT id, meta FROM chat_messages WHERE user_email=$1 AND direction='out' AND meta->>'kind' = ANY($2) ORDER BY id DESC LIMIT 1`, [requireOwner(userEmail), kinds]);
}
// Claim a question or offer so two messages arriving together can't both act
// on it. Returns false if someone already claimed it.
async function claimChatPrompt(id) {
  const row = await q1(`UPDATE chat_messages SET meta = jsonb_set(COALESCE(meta,'{}'::jsonb), '{done}', 'true')
    WHERE id = $1 AND COALESCE(meta->>'done','') <> 'true' RETURNING id`, [id]);
  return !!row;
}

async function updateChatMeta(id, meta) {
  await q(`UPDATE chat_messages SET meta=$2 WHERE id=$1`, [id, JSON.stringify(meta)]);
}
async function hasChatHistory(userEmail) {
  return !!(await q1(`SELECT 1 FROM chat_messages WHERE user_email=$1 LIMIT 1`, [requireOwner(userEmail)]));
}
async function clearChat(userEmail) {
  await q(`DELETE FROM chat_messages WHERE user_email=$1`, [requireOwner(userEmail)]);
}

// Reset for the test line: the conversation and the kits behind it, so the next
// job link is written from scratch. Profile, saved answers and pipeline stay.
async function resetTestKits(userEmail) {
  const owner = requireOwner(userEmail);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM kit_versions WHERE kit_id IN (SELECT id FROM kits WHERE user_email=$1)`, [owner]);
    const kits = await client.query(`DELETE FROM kits WHERE user_email=$1 RETURNING id`, [owner]);
    await client.query(`DELETE FROM kit_shares WHERE user_email=$1`, [owner]);
    await client.query(`DELETE FROM chat_messages WHERE user_email=$1`, [owner]);
    await client.query(`UPDATE jobs SET kit_generated_at=NULL WHERE user_email=$1`, [owner]);
    await client.query('COMMIT');
    return kits.rowCount;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
}

// ── API keys ──────────────────────────────────────────────────────────────────

const hashKey = key => require('crypto').createHash('sha256').update(key).digest('hex');

async function createApiKey(userEmail, name) {
  requireOwner(userEmail);
  const crypto = require('crypto');
  const key = 'aa_live_' + crypto.randomBytes(24).toString('base64url');
  const id = 'key_' + crypto.randomBytes(8).toString('hex');
  const active = await q1(`SELECT COUNT(*)::int AS n FROM api_keys WHERE user_email=$1 AND revoked_at IS NULL`, [userEmail]);
  if (active.n >= 10) throw Object.assign(new Error('Revoke a key before creating another (limit 10)'), { status: 400 });
  await q(`INSERT INTO api_keys (id, user_email, name, key_hash, prefix) VALUES ($1,$2,$3,$4,$5)`,
    [id, userEmail, String(name || 'Agent').slice(0, 80), hashKey(key), key.slice(0, 12)]);
  return { id, key };
}

async function listApiKeys(userEmail) {
  return q(`SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE user_email=$1 AND revoked_at IS NULL ORDER BY created_at DESC`, [requireOwner(userEmail)]);
}

async function revokeApiKey(userEmail, id) {
  const rows = await q(`UPDATE api_keys SET revoked_at=NOW() WHERE id=$1 AND user_email=$2 AND revoked_at IS NULL RETURNING id`, [id, requireOwner(userEmail)]);
  return rows.length > 0;
}

async function emailForApiKey(key) {
  if (typeof key !== 'string' || !key.startsWith('aa_live_') || key.length > 100) return null;
  const row = await q1(`UPDATE api_keys SET last_used_at=NOW() WHERE key_hash=$1 AND revoked_at IS NULL RETURNING user_email`, [hashKey(key)]);
  return row?.user_email || null;
}

// ── Listings ledger ───────────────────────────────────────────────────────────

// Board stamps that are exactly midnight UTC are dates, not times.
function postedPrecision(postedAt) {
  if (!postedAt) return null;
  return /T00:00:00(\.0+)?(Z|\+00:?00)$/.test(postedAt) ? 'day' : 'exact';
}

async function upsertListings(source, jobs) {
  let added = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const j of jobs) {
      let url;
      try { url = canonicalUrl(j.url); } catch { continue; }
      const posted = j.posted_at && Number.isFinite(Date.parse(j.posted_at)) ? new Date(j.posted_at).toISOString() : null;
      const r = await client.query(`
        INSERT INTO listings (url, source, company, role, location, remote, posted_at, posted_precision, salary, snippet)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (url) DO UPDATE SET last_seen = NOW(), role = EXCLUDED.role, company = EXCLUDED.company,
          location = EXCLUDED.location, remote = EXCLUDED.remote, salary = COALESCE(EXCLUDED.salary, listings.salary),
          posted_at = COALESCE(listings.posted_at, EXCLUDED.posted_at), posted_precision = COALESCE(listings.posted_precision, EXCLUDED.posted_precision)
        RETURNING (xmax = 0) AS inserted`,
      [url, source, String(j.company || '').slice(0, 250), String(j.role).slice(0, 250), String(j.location || '').slice(0, 250),
        typeof j.remote === 'boolean' ? j.remote : null, posted, j.posted_precision || postedPrecision(j.posted_at),
        j.salary ? JSON.stringify(j.salary) : null, String(j.snippet || '').slice(0, 1200)]);
      if (r.rows[0]?.inserted) added++;
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
  return added;
}

// lookbackHours 24: listings posted in the window (or, with no posting date,
// first seen in it). 0, "all currently listed": posted in the last 45 days, or
// still on the board at its last weekly full refresh (seen in the last 8
// days), however long ago it was first posted.
const CURRENT_POSTED_DAYS = 45, CURRENT_SEEN_DAYS = 8;
async function getListings(sources, lookbackHours) {
  if (lookbackHours !== 24) {
    return q(`
      SELECT * FROM listings
      WHERE source = ANY($1) AND (COALESCE(posted_at, first_seen) >= NOW() - ($2 || ' days')::interval OR last_seen >= NOW() - ($3 || ' days')::interval)
      ORDER BY COALESCE(posted_at, first_seen) DESC`, [sources, String(CURRENT_POSTED_DAYS), String(CURRENT_SEEN_DAYS)]);
  }
  // Date-only stamps count from the start of the day the window opens.
  return q(`
    SELECT * FROM listings
    WHERE source = ANY($1) AND (
      (posted_precision = 'day' AND posted_at >= date_trunc('day', (NOW() - INTERVAL '24 hours') AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
      OR (posted_precision IS DISTINCT FROM 'day' AND COALESCE(posted_at, first_seen) >= NOW() - INTERVAL '24 hours'))
    ORDER BY COALESCE(posted_at, first_seen) DESC`, [sources]);
}

async function countListings(sources) {
  const rows = await q(`SELECT source, COUNT(*)::int AS n FROM listings WHERE source = ANY($1) AND last_seen > NOW() - INTERVAL '45 days' GROUP BY source`, [sources]);
  return Object.fromEntries(rows.map(r => [r.source, r.n]));
}

async function getIngestState(sources) {
  const rows = await q(`SELECT * FROM ingest_state WHERE source = ANY($1)`, [sources]);
  return Object.fromEntries(rows.map(r => [r.source, r]));
}

async function recordIngest(source, { ok, count = null, error = null, full = false }) {
  await q(`
    INSERT INTO ingest_state (source, last_ok_at, last_full_at, last_attempt_at, last_count, last_error)
    VALUES ($1, CASE WHEN $2 THEN NOW() END, CASE WHEN $2 AND $5 THEN NOW() END, NOW(), $3, $4)
    ON CONFLICT (source) DO UPDATE SET last_attempt_at = NOW(),
      last_ok_at = CASE WHEN $2 THEN NOW() ELSE ingest_state.last_ok_at END,
      last_full_at = CASE WHEN $2 AND $5 THEN NOW() ELSE ingest_state.last_full_at END,
      last_count = COALESCE($3, ingest_state.last_count), last_error = $4`, [source, ok, count, error, full]);
}

// The database lives on a small volume, and the ledger adds thousands of rows
// a day, so every ingest prunes what no run can use any more: listings that
// "all currently listed" can no longer return (same rule as getListings),
// stale shared cache, and run progress logs older than 30 days (run results
// are kept).
async function pruneStorage() {
  const counts = {};
  counts.listings = (await q(`DELETE FROM listings WHERE COALESCE(posted_at, first_seen) < NOW() - ($1 || ' days')::interval AND last_seen < NOW() - ($2 || ' days')::interval RETURNING 1`,
    [String(CURRENT_POSTED_DAYS), String(CURRENT_SEEN_DAYS)])).length;
  counts.source_cache = (await q(`DELETE FROM source_cache WHERE fetched_at < NOW() - INTERVAL '3 days' RETURNING 1`)).length;
  counts.operation_events = (await q(`DELETE FROM operation_events WHERE created_at < NOW() - INTERVAL '30 days' RETURNING 1`)).length;
  return counts;
}

async function storageStats() {
  const [size] = await q(`SELECT pg_database_size(current_database())::bigint AS bytes`);
  const tables = await q(`SELECT relname AS table, pg_total_relation_size(relid)::bigint AS bytes, n_live_tup::bigint AS rows
    FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 15`);
  return { database_bytes: Number(size.bytes), tables: tables.map(t => ({ table: t.table, bytes: Number(t.bytes), rows: Number(t.rows) })) };
}

// One ingest per source at a time across every server process and run.
async function withIngestLock(source, fn) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', ['ingest:' + source]);
    try { return await fn(); }
    finally { await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', ['ingest:' + source]).catch(() => {}); }
  } finally { client.release(); }
}

async function putCachedSource(cacheKey, source, roleKey, payload) {
  await q(`
    INSERT INTO source_cache (cache_key, source, role_key, payload, fetched_at)
    VALUES ($1,$2,$3,$4,NOW())
    ON CONFLICT (cache_key) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = NOW()
  `, [cacheKey, source, roleKey, JSON.stringify(payload)]);
}

// ── Schedules ─────────────────────────────────────────────────────────────────

async function getSchedule(userEmail) {
  return q1(`SELECT * FROM schedules WHERE user_email = $1`, [userEmail]);
}

// alreadyPassedToday stamps last_run_at so that saving a schedule for a time
// that has already gone by does not read as a missed run and fire immediately,
// charging credits the user never asked to spend today.
async function setSchedule(userEmail, { hour, minute, frequency = 'daily', enabled, sources, lookback_hours = 24, auto_kits }, alreadyPassedToday = false) {
  const cadence = frequency === 'weekdays' ? 'weekdays' : 'daily';
  const lookback = Number(lookback_hours) === 0 ? 0 : 24;
  // Older clients do not send auto_kits; leave the saved value alone then.
  const kits = auto_kits === undefined ? null : Math.max(0, Math.min(5, Number(auto_kits) || 0));
  return q1(`
    INSERT INTO schedules (user_email, hour, minute, frequency, enabled, sources, lookback_hours, last_run_at, auto_kits, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,0),NOW())
    ON CONFLICT (user_email) DO UPDATE SET
      hour = EXCLUDED.hour, minute = EXCLUDED.minute,
      frequency = EXCLUDED.frequency,
      enabled = EXCLUDED.enabled, sources = EXCLUDED.sources,
      lookback_hours = EXCLUDED.lookback_hours,
      last_run_at = COALESCE(EXCLUDED.last_run_at, schedules.last_run_at),
      auto_kits = COALESCE($9, schedules.auto_kits),
      updated_at = NOW()
    RETURNING *
  `, [userEmail, hour, minute, cadence, enabled, sources ? JSON.stringify(sources) : null,
      lookback, alreadyPassedToday ? new Date() : null, kits]);
}

async function getAccountExport(userEmail) {
  const owner = requireOwner(userEmail);
  const profile = await getProfileByUserEmail(owner);
  if (profile) delete profile.api_key;
  return {
    profile,
    jobs: await q('SELECT * FROM jobs WHERE user_email=$1 ORDER BY found_at DESC', [owner]),
    kits: await q('SELECT id,url,data,created_at,updated_at FROM kits WHERE user_email=$1 ORDER BY updated_at DESC', [owner]),
    evidence: await q('SELECT question,answer,theme,job_url,created_at,updated_at FROM evidence WHERE user_email=$1 ORDER BY updated_at DESC', [owner]),
    schedules: await q('SELECT hour,minute,frequency,enabled,sources,lookback_hours,auto_kits,last_run_at,updated_at FROM schedules WHERE user_email=$1', [owner]),
    runs: await q('SELECT id,date,run_at,sources,found,added,excluded,detail FROM runs WHERE user_email=$1 ORDER BY run_at DESC', [owner]),
    credit_history: await q('SELECT kind,amount,operation_id,created_at FROM credit_ledger WHERE user_email=$1 ORDER BY created_at DESC', [owner]),
    api_keys: await q('SELECT name,prefix,created_at,last_used_at,revoked_at FROM api_keys WHERE user_email=$1 ORDER BY created_at DESC', [owner]),
    resume_structure: (await q1('SELECT data,created_at FROM resume_structures WHERE user_email=$1', [owner])) || null,
    text_messages: await q('SELECT direction,body,created_at FROM chat_messages WHERE user_email=$1 ORDER BY id', [owner]),
  };
}

async function deleteAccount(userEmail) {
  const owner = requireOwner(userEmail);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM operation_events WHERE operation_id IN (SELECT id FROM operations WHERE user_email=$1)', [owner]);
    for (const table of ['user_activity','decisions','evidence','resume_files','schedules','runs','jobs','kits','profiles','purchases','api_keys','resume_structures','chat_messages','kit_shares']) {
      await client.query(`DELETE FROM ${table} WHERE user_email=$1`, [owner]);
    }
    // Feedback stays so the product can be fixed, but stops being theirs.
    await client.query(`UPDATE feedback SET user_email=NULL WHERE user_email=$1`, [owner]);
    // magic_links keys on `email`; listing it above made every deletion fail.
    await client.query('DELETE FROM magic_links WHERE email=$1', [owner]);
    await client.query('DELETE FROM stripe_events WHERE email=$1', [owner]);
    await client.query('DELETE FROM operations WHERE user_email=$1', [owner]);
    await client.query(`DELETE FROM job_merge_archive WHERE data->>'user_email'=$1`, [owner]);
    await client.query('DELETE FROM users WHERE email=$1', [owner]);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// Use a dated occurrence, not a 23-hour heuristic. The occurrence is also the
// scheduler's idempotency key, including catch-up across local midnight.
async function getDueSchedules(_hour, _minute, now = new Date()) {
  return q(`
    WITH today AS (
      SELECT s.*, date_trunc('day', $1::timestamptz AT TIME ZONE $2)
        + make_interval(hours => hour, mins => minute) AS wall_due
      FROM schedules s WHERE enabled=true
    ), due AS (
      SELECT *, (CASE WHEN wall_due > ($1::timestamptz AT TIME ZONE $2)
        THEN wall_due - INTERVAL '1 day' ELSE wall_due END) AT TIME ZONE $2 AS due_at
      FROM today
    )
    SELECT * FROM due WHERE due_at <= $1 AND due_at > $1::timestamptz - INTERVAL '3 hours'
      AND (frequency = 'daily' OR EXTRACT(ISODOW FROM due_at AT TIME ZONE $2) BETWEEN 1 AND 5)
      AND (last_run_at IS NULL OR last_run_at < due_at)
  `, [now,process.env.SCHEDULE_TZ || 'America/Chicago']);
}

async function getAllEnabledSchedules() {
  return q(`SELECT * FROM schedules WHERE enabled = true`);
}

async function markScheduleRun(userEmail) {
  await q(`UPDATE schedules SET last_run_at = NOW() WHERE user_email = $1`, [userEmail]);
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function getSetting(key, fallback = null) {
  const row = await q1(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  return row ? row.value : fallback;
}

async function setSetting(key, value) {
  await q(`
    INSERT INTO app_settings (key, value) VALUES ($1,$2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `, [key, JSON.stringify(value)]);
  return value;
}

// ── Magic links ───────────────────────────────────────────────────────────────

async function createMagicLink(email, token, expiresAt) {
  await q(`INSERT INTO magic_links (token, email, expires_at, used) VALUES ($1,$2,$3,0)`, [token, email, expiresAt]);
}

async function getMagicLink(token) {
  return q1(`SELECT * FROM magic_links WHERE token = $1`, [token]);
}

async function useMagicLink(token) {
  return q1(`UPDATE magic_links SET used = 1 WHERE token = $1 AND used=0 AND expires_at>NOW() RETURNING *`, [token]);
}

async function getProfiledUsers() {
  const rows = await q(`SELECT DISTINCT user_email FROM profiles WHERE user_email IS NOT NULL AND target_roles IS NOT NULL`);
  return rows.map(r => r.user_email);
}

module.exports = {
  pool,
  initSchema,
  PROFILE_FIELDS,
  insertRun, getRuns, getRun,
  insertJob, upsertJob, ensureJob, setJobStatus, setKitGenerated, getJobByUrl, getJobs, getJobsForRun, getSeenUrls, getStatusCounts,
  recordDecision, getDecisionSummary, getCoverage,
  getProfile, getProfileByUserEmail, setProfile, getProfiledUsers,
  starterCredits, saveKit, getKit, findKit, getKitVersions, getKits, deleteKit, deleteKitsForUser, countKits,
  saveResumeFile, getResumeFile, getResumeFileMeta,
  getEvidence, addEvidenceQuestions, addAnsweredEvidence, setEvidenceAnswer, deleteEvidence,
  getSetting, setSetting,
  getSchedule, setSchedule, getDueSchedules, markScheduleRun, getAllEnabledSchedules,
  getAccountExport, deleteAccount,
  roleKeyFor, cacheKeyFor, getCachedSources, putCachedSource,
  upsertListings, getListings, countListings, getIngestState, recordIngest, withIngestLock,
  createApiKey, listApiKeys, revokeApiKey, emailForApiKey, getResumeStructure, saveResumeStructure, pruneStorage, storageStats,
  kitShareToken, kitForShare, addFeedback, feedbackSeenToday,
  resetTestKits, addChatMessage, getChatMessages, lastChatMeta, lastChatPrompt, claimChatPrompt, updateChatMeta, hasChatHistory, clearChat,
  getUser, getOrCreateUser, addUserCredits, deductUserCredits, chargeCredits, countVoiceNotesToday,
  createMagicLink, getMagicLink, useMagicLink,
};
Object.assign(module.exports, require('./operations')(pool), require('./payments')(pool));
