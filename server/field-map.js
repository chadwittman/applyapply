// Which saved profile value belongs in a form field, decided by meaning rather
// than by matching the label against a list of patterns.
//
// The extension's rules fill what they recognise instantly and for free, and
// they are right most of the time. What they cannot do is anticipate wording:
// Ashby labels its name field "Full Name", which matched no rule at all, so
// every Ashby application went out with a blank name until someone noticed.
// Whatever the rules leave empty comes here, where one Jev judgment per field
// picks the profile value that belongs in it, or none.
const { evaluate } = require('./typesafe');

// Identity facts only. A field asking what the candidate wants, when they can
// start, whether they need sponsorship or why they applied is not something to
// answer out of a profile, so those are not offered as choices at all.
const MAPPABLE = [
  ['first_name', 'the first name on its own'],
  ['last_name', 'the last name or family name on its own'],
  ['full_name', 'the full name, first and last together'],
  ['email', 'the email address'],
  ['phone', 'the phone number'],
  ['linkedin', 'the LinkedIn profile address'],
  ['github', 'the GitHub profile address'],
  ['twitter', 'the Twitter or X profile address'],
  ['website', 'a personal website, portfolio or work samples address'],
  ['location', 'where the candidate lives or is based, as a city'],
  ['current_employer', 'the company the candidate works for now or worked for most recently'],
  ['school', 'the university, college or school the candidate attended'],
];

function valuesFor(profile) {
  const at = key => String(profile?.[key] ?? '').trim();
  const full = [at('first_name'), at('last_name')].filter(Boolean).join(' ');
  return MAPPABLE
    .map(([key, is]) => ({ key, is, value: key === 'full_name' ? full : at(key) }))
    .filter(f => f.value);
}

async function mapFields(apiKey, labels, profile, { minConfidence = 0.8 } = {}) {
  const available = valuesFor(profile);
  if (!apiKey || !available.length) return [];
  const clean = [...new Set((Array.isArray(labels) ? labels : [])
    .map(l => String(l ?? '').replace(/\s+/g, ' ').trim())
    .filter(l => l && l.length <= 160))].slice(0, 25);
  if (!clean.length) return [];

  const criteria = Object.fromEntries(available.map((f, i) => [`k${i}`, `The field is asking for ${f.is}`]));
  criteria.none = 'The field is asking for something else, or for something only the candidate can decide, such as pay, availability, eligibility, or why they are applying';

  const questions = Object.fromEntries(clean.map((label, i) => [`f${i}`, {
    type: 'choice',
    instructions: `A job application form has a field labelled "${label}". Which piece of the candidate's saved profile should be typed into it, exactly as saved? Choose none unless the field is plainly asking for that piece.`,
    criteria,
  }]));

  const data = await evaluate(apiKey, { available_profile_pieces: available.map(({ key, is }) => ({ piece: key, holds: is })) }, questions);

  const out = [];
  clean.forEach((label, i) => {
    const answer = data.answers?.[`f${i}`];
    const choice = answer?.choice;
    if (!choice || choice === 'none') return;
    if (!(Number(answer.confidence) >= minConfidence)) return;
    const picked = available[Number(String(choice).slice(1))];
    if (picked) out.push({ label, key: picked.key, value: picked.value, confidence: Number(answer.confidence) });
  });
  return out;
}

module.exports = { mapFields, valuesFor, MAPPABLE };
