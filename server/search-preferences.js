// Only explicit annual USD base pay can satisfy a selective salary target.
function compensationMatch(text, target) {
  const minimum = Number(String(target || '').replace(/[$,\s]/g, ''));
  if (!Number.isFinite(minimum) || minimum <= 0) return false;
  const ranges = String(text).matchAll(/(?:base salary|base pay|annual salary|annual base)[^.!?\n]{0,80}?\$\s*([\d,]+(?:\.\d+)?)(k)?\s*(?:-|–|—|to)\s*\$?\s*([\d,]+(?:\.\d+)?)(k)?([^.!?\n]{0,60})/gi);
  for (const match of ranges) {
    if (/CAD|AUD|NZD|SGD|hour|month|weekly|OTE|total compensation/i.test(match[0])) continue;
    const low = Number(match[1].replace(/,/g, '')) * (match[2] ? 1000 : 1);
    const high = Number(match[3].replace(/,/g, '')) * (match[4] ? 1000 : 1);
    if (low >= 10000 && high >= low && high >= minimum) return true;
  }
  return false;
}
function selectiveMatch(score, text, target) {
  return Number.isFinite(score) && score >= 8 && compensationMatch(text, target);
}
module.exports = { compensationMatch, selectiveMatch };
