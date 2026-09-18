const API = 'https://api.typesafe.ai/v1/systemone';

async function evaluate(apiKey, state, questions) {
  if (!apiKey) throw new Error('TypeSafe API key is not configured');
  const response = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'jev-latest', state, questions }),
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.text();
  let data;
  try { data = JSON.parse(body); } catch { data = null; }
  if (!response.ok) throw new Error(`TypeSafe API error ${response.status}: ${body.slice(0, 240)}`);
  if (!data?.answers || typeof data.answers !== 'object') throw new Error('TypeSafe returned no typed answers');
  return data;
}

async function evaluateResumeMatch(apiKey, appData, resume) {
  const data = await evaluate(apiKey, {
    job: {
      company: String(appData?.company || '').slice(0, 250),
      role: String(appData?.role || '').slice(0, 250),
      why_role: String(appData?.tailored?.why_role || '').slice(0, 3500),
    },
    tailored_resume: {
      summary: String(resume?.summary || '').slice(0, 2000),
      experience: (Array.isArray(resume?.experience) ? resume.experience : []).slice(0, 20).map(e => ({
        company: String(e?.company || '').slice(0, 200),
        title: String(e?.title || '').slice(0, 200),
        dates: String(e?.dates || '').slice(0, 100),
        bullets: (Array.isArray(e?.bullets) ? e.bullets : []).slice(0, 8).map(b => String(b).slice(0, 500)),
      })),
      skills: (Array.isArray(resume?.skills) ? resume.skills : []).slice(0, 60).map(s => String(s).slice(0, 120)),
    },
  }, {
    match: {
      type: 'score',
      instructions: 'How well does this tailored resume support this specific application? Judge only the evidence visible in the resume against the role context. Do not reward generic seniority alone. A strong match has concrete, relevant responsibilities and outcomes.',
      criteria: [
        'Weak: the resume does not provide credible evidence for the role',
        'Limited: some adjacent experience, but the central requirements are mostly unsupported',
        'Solid: credible overlap with relevant responsibilities, though important gaps remain',
        'Strong: clear, specific evidence for the central work of this role',
        'Exceptional: unusually direct evidence with concrete outcomes across the role\'s main needs',
      ],
    },
  });
  const answer = data.answers.match;
  return {
    score: answer?.type === 'score' && Number.isFinite(Number(answer.score)) ? Number(answer.score) + 1 : null,
    confidence: Number.isFinite(Number(answer?.confidence)) ? Number(answer.confidence) : null,
    probabilities: answer?.probabilities || null,
    model: data.model,
    usage: data.usage || null,
  };
}

module.exports = { evaluate, evaluateResumeMatch };
