// How interesting a job looks to one person.
//
// Function and level say whether a role is the right shape. They cannot say
// that somebody who spent six years on consumer marketplaces will care about
// this one and not that one. Jev reads the pair and scores it.
//
// Scoring eleven thousand rows on every page view would be slow and wasteful,
// so this runs on a slice: the rows a person is most likely to look at, capped
// per visit, and every score is kept. A page fills in over a few visits and is
// instant after that.
const { evaluate } = require('./typesafe');

const LEVELS = [
  'Not for them: a different profession, or a level they would not take',
  'Weak: the right field, but little reason for this person over anybody else',
  'Plausible: the shape fits and nothing argues against it',
  'Good: their background lines up with what this role needs',
  'Strong: this reads as a role they are unusually well suited to',
];

const PER_VISIT = 24;

function personFor(profile) {
  const bits = [
    profile?.target_functions ? `Looking for: ${profile.target_functions}` : '',
    profile?.target_seniority ? `At level: ${profile.target_seniority}` : '',
    profile?.target_roles ? `Titles they named: ${profile.target_roles}` : '',
    profile?.location_pref === 'remote' ? 'Wants remote work' : profile?.location ? `Based in ${profile.location}` : '',
    (profile?.bio || '').slice(0, 1200),
    (profile?.resume_text || '').slice(0, 1800),
  ].filter(Boolean);
  return bits.join('\n\n');
}

// Returns [{ url, score }] for what it managed to score. Never throws: an
// unscored page is a page in a plainer order, not an error.
async function scoreJobs(apiKey, profile, jobs, { cap = PER_VISIT } = {}) {
  const person = personFor(profile);
  const batch = (jobs || []).slice(0, cap);
  if (!apiKey || !batch.length || person.length < 40) return [];
  const questions = Object.fromEntries(batch.map((j, i) => [`j${i}`, {
    type: 'score',
    instructions: `How interesting is this job to this person? Role: "${j.role}" at ${j.company}${j.location ? `, ${j.location}` : ''}. Judge it against who they are and what they are looking for, not against how good the job is in general.`,
    criteria: LEVELS,
  }]));
  try {
    const data = await evaluate(apiKey, { person }, questions);
    const out = [];
    batch.forEach((j, i) => {
      const answer = data.answers?.[`j${i}`];
      const score = Number(answer?.score);
      if (Number.isFinite(score)) out.push({ url: j.url, score });
    });
    return out;
  } catch (e) {
    console.error('[interest]', e.message);
    return [];
  }
}

module.exports = { scoreJobs, personFor, PER_VISIT, LEVELS };
