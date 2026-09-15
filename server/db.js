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
      enabled BOOLEAN NOT NULL DEFAULT false,
      sources JSONB,
      last_run_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

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

// Insert a pipeline row for a directly-generated kit. jobs has two keys that
// must both stay unique — id (PK) and url — but a statement can only declare
// one ON CONFLICT target. The AI derives id from company+role, so the same role
// reached via two different URLs (an aggregator listing and the company's own
// careers page) produces the same id with a different url, which upsertJob's
// ON CONFLICT (url) does not catch. Resolve the id collision before inserting.
async function ensureJob(job) {
  const byUrl = await q1(`SELECT id FROM jobs WHERE url = $1`, [job.url]);
  if (byUrl) return byUrl.id;

  let id = job.id;
  const taken = await q1(`SELECT url FROM jobs WHERE id = $1`, [id]);
  if (taken) {
    const suffix = require('crypto').createHash('sha1').update(job.url).digest('hex').slice(0, 6);
    id = `${id}-${suffix}`;
  }

  await q(`
    INSERT INTO jobs (id, url, company, role, ats, source, run_id, found_at, status, tier, fit_score, location, notes, user_email)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (url) DO NOTHING
  `, [id, job.url, job.company, job.role, job.ats||null, job.source||null, job.run_id||null,
      job.found_at, job.status||'new', job.tier||null, job.fit_score||null,
      job.location||null, job.notes||'', job.user_email||null]);
  return id;
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

// Partial update: only writes fields actually supplied. Different clients post
// different subsets (the setup page sends everything, the extension popup sends
// 8 contact fields), so an absent field must mean "leave alone" — writing null
// for it let the extension's save silently wipe bio, resume_text, target_roles…
async function setProfile(key, data, isEmail = false) {
  const fields = PROFILE_FIELDS.filter(f => data[f] !== undefined);
  if (!fields.length) return;
  const vals = fields.map(f => data[f]);

  if (isEmail) {
    const existing = await q1(`SELECT api_key FROM profiles WHERE user_email = $1`, [key]);
    if (existing) {
      const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
      await q(`UPDATE profiles SET ${sets}, updated_at = NOW() WHERE user_email = $1`, [key, ...vals]);
    } else {
      const cols = ['api_key', 'user_email', ...fields].join(', ');
      const placeholders = ['api_key', 'user_email', ...fields].map((_, i) => `$${i + 1}`).join(', ');
      await q(`INSERT INTO profiles (${cols}) VALUES (${placeholders})`,
        [`email:${key}`, key, ...vals]);
    }
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

// ── Kits ──────────────────────────────────────────────────────────────────────

async function saveKit(kit) {
  // The same role reached from two URLs (an aggregator listing and the
  // company's own careers page) yields the same AI-derived id. Keep every URL
  // this kit has been seen at, so looking it up from either one still hits
  // instead of quietly regenerating and charging for it twice.
  const prior = await q1(`SELECT data FROM kits WHERE id = $1`, [kit.id]);
  if (prior?.data) {
    const known = new Set([prior.data.url, ...(prior.data.urls || []), ...(kit.urls || [])].filter(Boolean));
    known.delete(kit.url);
    if (known.size) kit = { ...kit, urls: [...known] };
  }
  await q(`
    INSERT INTO kits (id, url, user_email, data)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (id) DO UPDATE SET
      url = EXCLUDED.url, user_email = EXCLUDED.user_email,
      data = EXCLUDED.data, updated_at = NOW()
  `, [kit.id, kit.url || null, kit.user_email || null, JSON.stringify(kit)]);
  return kit;
}

async function getKit(id) {
  const row = await q1(`SELECT data FROM kits WHERE id = $1`, [id]);
  return row ? row.data : null;
}

async function getKits(userEmail = null) {
  const rows = userEmail
    ? await q(`SELECT data FROM kits WHERE user_email = $1 ORDER BY updated_at DESC`, [userEmail])
    : await q(`SELECT data FROM kits ORDER BY updated_at DESC`);
  return rows.map(r => r.data);
}

async function deleteKit(id) {
  await q(`DELETE FROM kits WHERE id = $1`, [id]);
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

// ── Source cache ──────────────────────────────────────────────────────────────

// Role titles decide the Google query, so they are part of the identity of a
// cached result. Normalized so "Head of Product, VP Product" and
// "vp product,  head of product" share one entry.
function roleKeyFor(roleTitles) {
  return String(roleTitles || '')
    .split(',').map(r => r.trim().toLowerCase()).filter(Boolean).sort().join('|');
}

function cacheKeyFor(source, roleTitles, sharedAcrossRoles = false) {
  return sharedAcrossRoles ? `${source}::*` : `${source}::${roleKeyFor(roleTitles)}`;
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

async function setSchedule(userEmail, { hour, minute, enabled, sources }) {
  return q1(`
    INSERT INTO schedules (user_email, hour, minute, enabled, sources, updated_at)
    VALUES ($1,$2,$3,$4,$5,NOW())
    ON CONFLICT (user_email) DO UPDATE SET
      hour = EXCLUDED.hour, minute = EXCLUDED.minute,
      enabled = EXCLUDED.enabled, sources = EXCLUDED.sources, updated_at = NOW()
    RETURNING *
  `, [userEmail, hour, minute, enabled, sources ? JSON.stringify(sources) : null]);
}

// Everything due at this wall-clock minute, skipping anything already run
// within the last 23h so a restart mid-minute can't double-charge.
async function getDueSchedules(hour, minute) {
  return q(`
    SELECT * FROM schedules
    WHERE enabled = true AND hour = $1 AND minute = $2
      AND (last_run_at IS NULL OR last_run_at < NOW() - INTERVAL '23 hours')
  `, [hour, minute]);
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
  await q(`UPDATE magic_links SET used = 1 WHERE token = $1`, [token]);
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
  recordDecision, getDecisionSummary,
  getProfile, getProfileByUserEmail, setProfile, getProfiledUsers,
  saveKit, getKit, getKits, deleteKit, deleteKitsForUser, countKits,
  getEvidence, addEvidenceQuestions, addAnsweredEvidence, setEvidenceAnswer, deleteEvidence,
  getSetting, setSetting,
  getSchedule, setSchedule, getDueSchedules, markScheduleRun, getAllEnabledSchedules,
  roleKeyFor, cacheKeyFor, getCachedSources, putCachedSource,
  getUser, getOrCreateUser, addUserCredits, deductUserCredits, applyStripePayment,
  createMagicLink, getMagicLink, useMagicLink,
};
