// Only the person's current words can authorize spending. Model tool calls,
// quoted posting text, reactions and resolved reply targets cannot.
function explicitAction(message, action) {
  const text = String(message || '').trim().toLowerCase();
  if (/\b(don't|not|never|would|should|if|why|how|cost|maybe|either|or)\b/.test(text)) return false;
  const lead = text.replace(/^(?:please\s+|(?:can|could|will) you\s+)/, '');
  if (action === 'write') return /^(?:write|make|prepare|generate|redo)\s+(?:(?:me|the|my|an?|this|that)\s+)*(?:application|kit|it|one|first|second|third|https?:\/\/)/.test(lead);
  if (action === 'rewrite') return /^(?:rewrite|redo|update)(?:[.!\s]*$|\s+(?:(?:the|my|this|that)\s+)*(?:resume|it)\b)/.test(lead);
  return /^(?:search|go (?:look|search)|find me (?:jobs|roles))\b/.test(lead);
}

const isYes = text => /^(?:yes|yep|yeah|sure|ok|okay|go ahead|do it)(?: please)?[.!\s]*$/i.test(String(text).trim());
const isNo = text => /^(?:no|nope|nah|not now|later|cancel)[.!\s]*$/i.test(String(text).trim());
const refersToCurrent = text => /^(?:(?:please|can you|could you|will you)\s+)?(?:write|make|prepare|generate)\s+(?:me\s+)?(?:it|(?:this|that)(?: one| application| kit)?|(?:the|my|an?|this|that) (?:application|kit))(?: please)?[.!?\s]*$/i.test(String(text).trim());

module.exports = { explicitAction, isYes, isNo, refersToCurrent };
