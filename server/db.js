const { Pool } = require('pg');
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required to start the ApplyApply server');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

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
      career_type TEXT, target_roles TEXT, location_pref TEXT, resume_text TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // profiles already existed before resume_text was added — CREATE TABLE IF
  // NOT EXISTS above is a no-op against it, so add the column explicitly too.
  await q(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS resume_text TEXT`);
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

  await q(`
    CREATE TABLE IF NOT EXISTS decisions (
      id SERIAL PRIMARY KEY,
      job_id TEXT,
      user_email TEXT,
      action TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  if (userEmail) return q(`SELECT * FROM runs WHERE user_email = $1 ORDER BY run_at DESC LIMIT $2`, [userEmail, limit]);
  return q(`SELECT * FROM runs ORDER BY run_at DESC LIMIT $1`, [limit]);
}

async function getRun(id) {
  return q1(`SELECT * FROM runs WHERE id = $1`, [id]);
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

async function insertJob(job) {
  await q(`
    INSERT INTO jobs (id, url, company, role, ats, source, run_id, found_at, status, tier, fit_score, location, notes, user_email)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (url) DO NOTHING
  `, [job.id, job.url, job.company, job.role, job.ats||null, job.source||null, job.run_id||null,
      job.found_at, job.status||'new', job.tier||null, job.fit_score||null,
      job.location||null, job.notes||'', job.user_email||null]);
}

async function upsertJob(job) {
  await q(`
    INSERT INTO jobs (id, url, company, role, ats, source, run_id, found_at, status, tier, fit_score, location, notes, user_email)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (url) DO UPDATE SET
      company    = EXCLUDED.company,
      role       = EXCLUDED.role,
      source     = COALESCE(jobs.source, EXCLUDED.source),
      tier       = EXCLUDED.tier,
      fit_score  = EXCLUDED.fit_score,
      location   = EXCLUDED.location,
      user_email = COALESCE(jobs.user_email, EXCLUDED.user_email),
      updated_at = NOW()
    WHERE jobs.status = 'new'
  `, [job.id, job.url, job.company, job.role, job.ats||null, job.source||null, job.run_id||null,
      job.found_at, job.status||'new', job.tier||null, job.fit_score||null,
      job.location||null, job.notes||'', job.user_email||null]);
}

async function setJobStatus(url, status, extra = {}) {
  await q(`
    UPDATE jobs SET status = $1, applied_at = COALESCE($2, applied_at),
      notes = COALESCE($3, notes), updated_at = NOW(), status_updated_at = NOW()
    WHERE url = $4
  `, [status, extra.applied_at||null, extra.notes||null, url]);
}

async function setKitGenerated(url) {
  await q(`UPDATE jobs SET kit_generated_at = NOW() WHERE url = $1`, [url]);
}

async function getJobByUrl(url) {
  return q1(`SELECT * FROM jobs WHERE url = $1`, [url]);
}

async function getJobs(status = null, limit = 200, userEmail = null) {
  if (status && userEmail)  return q(`SELECT * FROM jobs WHERE status = $1 AND user_email = $2 ORDER BY found_at DESC, fit_score DESC LIMIT $3`, [status, userEmail, limit]);
  if (status)               return q(`SELECT * FROM jobs WHERE status = $1 ORDER BY found_at DESC, fit_score DESC LIMIT $2`, [status, limit]);
  if (userEmail)            return q(`SELECT * FROM jobs WHERE user_email = $1 ORDER BY found_at DESC, fit_score DESC LIMIT $2`, [userEmail, limit]);
  return q(`SELECT * FROM jobs ORDER BY found_at DESC, fit_score DESC LIMIT $1`, [limit]);
}

async function getJobsForRun(runId) {
  return q(`SELECT * FROM jobs WHERE run_id = $1 ORDER BY fit_score DESC`, [runId]);
}

async function getSeenUrls(userEmail = null) {
  const rows = userEmail
    ? await q(`SELECT url FROM jobs WHERE user_email = $1`, [userEmail])
    : await q(`SELECT url FROM jobs`);
  return new Set(rows.map(r => r.url));
}

async function getStatusCounts(userEmail = null) {
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
  'location','work_authorization','salary','current_employer','school','bio','career_type','target_roles','location_pref','resume_text'];

async function getProfile(apiKey) {
  return q1(`SELECT * FROM profiles WHERE api_key = $1`, [apiKey]);
}

async function getProfileByUserEmail(userEmail) {
  return q1(`SELECT * FROM profiles WHERE user_email = $1`, [userEmail]);
}

async function setProfile(key, data, isEmail = false) {
  const vals = PROFILE_FIELDS.map(f => data[f] ?? null);
  if (isEmail) {
    const existing = await q1(`SELECT api_key FROM profiles WHERE user_email = $1`, [key]);
    if (existing) {
      const sets = PROFILE_FIELDS.map((f, i) => `${f} = $${i + 2}`).join(', ');
      await q(`UPDATE profiles SET ${sets}, updated_at = NOW() WHERE user_email = $1`, [key, ...vals]);
    } else {
      const cols = ['api_key', 'user_email', ...PROFILE_FIELDS].join(', ');
      const placeholders = ['api_key', 'user_email', ...PROFILE_FIELDS].map((_, i) => `$${i + 1}`).join(', ');
      await q(`INSERT INTO profiles (${cols}) VALUES (${placeholders})`,
        [`email:${key}`, key, ...vals]);
    }
  } else {
    const cols = ['api_key', ...PROFILE_FIELDS].join(', ');
    const placeholders = ['api_key', ...PROFILE_FIELDS].map((_, i) => `$${i + 1}`).join(', ');
    const updates = PROFILE_FIELDS.map((f, i) => `${f} = $${i + 2}`).join(', ');
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

async function getOrCreateUser(email) {
  await q(`INSERT INTO users (email, credits, created_at) VALUES ($1, 0, $2) ON CONFLICT DO NOTHING`,
    [email, new Date().toISOString()]);
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

async function applyStripePayment(eventId, email, credits) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS stripe_events (
        event_id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        credits INTEGER NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const claimed = await client.query(
      `INSERT INTO stripe_events (event_id, email, credits) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING event_id`,
      [eventId, email, credits]
    );
    if (!claimed.rowCount) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `INSERT INTO users (email, credits, created_at) VALUES ($1, 0, $2) ON CONFLICT DO NOTHING`,
      [email, new Date().toISOString()]
    );
    await client.query(`UPDATE users SET credits = credits + $1 WHERE email = $2`, [credits, email]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ── Magic links ───────────────────────────────────────────────────────────────

async function createMagicLink(email, token, expiresAt) {
  await q(`INSERT INTO magic_links (token, email, expires_at, used) VALUES ($1,$2,$3,0)`, [token, email, expiresAt]);
}

async function getMagicLink(token) {
  return q1(`SELECT * FROM magic_links WHERE token = $1`, [token]);
}

async function useMagicLink(token) {
  await q(`UPDATE magic_links SET used = 1 WHERE token = $1`, [token]);
}

async function getProfiledUsers() {
  const rows = await q(`SELECT DISTINCT user_email FROM profiles WHERE user_email IS NOT NULL AND target_roles IS NOT NULL`);
  return rows.map(r => r.user_email);
}

module.exports = {
  pool,
  initSchema,
  insertRun, getRuns, getRun,
  insertJob, upsertJob, setJobStatus, setKitGenerated, getJobByUrl, getJobs, getJobsForRun, getSeenUrls, getStatusCounts,
  recordDecision, getDecisionSummary,
  getProfile, getProfileByUserEmail, setProfile, getProfiledUsers,
  getUser, getOrCreateUser, addUserCredits, deductUserCredits, applyStripePayment,
  createMagicLink, getMagicLink, useMagicLink,
};
