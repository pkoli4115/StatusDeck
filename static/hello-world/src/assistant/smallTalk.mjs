const ACKNOWLEDGEMENTS = new Set([
  'thanks', 'thank you', 'thankyou', 'many thanks', 'thanks a lot',
  'good', 'great', 'nice', 'perfect', 'cool', 'awesome', 'excellent',
  'ok', 'okay', 'got it', 'understood', 'fine', 'super', 'makes sense',
]);
const GREETINGS = new Set(['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening']);
const CLOSINGS = new Set(['bye', 'goodbye', 'see you', 'see ya']);
const NEGATIVE_FEEDBACK = [
  /^no\b/, /^wrong\b/, /^incorrect\b/, /^not this\b/, /^try again\b/,
  /not what i meant/, /that is not right/, /thats not right/, /that's not right/,
];

export function classifySmallTalk(normalized) {
  const value = String(normalized ?? '').trim();
  if (!value) return null;
  if (ACKNOWLEDGEMENTS.has(value)) return { type: 'acknowledgement', value };
  if (GREETINGS.has(value)) return { type: 'greeting', value };
  if (CLOSINGS.has(value)) return { type: 'closing', value };
  if (NEGATIVE_FEEDBACK.some((pattern) => pattern.test(value))) return { type: 'negative-feedback', value };
  return null;
}

export function buildSmallTalkResponse(classification) {
  if (!classification) return null;
  if (classification.type === 'greeting') {
    return {
      text: 'Hello. I can help with Jira projects, sprints, delivery risks, workload, comparisons, or report actions.',
      actions: ['Give me a sprint summary', 'What are the current risks?', 'Show remaining work'],
    };
  }
  if (classification.type === 'closing') {
    return { text: 'Anytime. Your current Jira context will stay available while this StatusDeck session remains open.', actions: [] };
  }
  if (classification.type === 'negative-feedback') {
    return {
      text: 'Understood. Tell me what you meant, or name the project/sprint you want. I will not guess or switch Jira context unless I can resolve it confidently.',
      actions: ['Use the current sprint', 'Choose another project'],
    };
  }
  return {
    text: "You're welcome. Let me know if you want to inspect risks, team workload, compare sprints, or generate a report for another sprint.",
    actions: ['What are the current risks?', 'Give me a sprint summary', 'Show remaining work'],
  };
}
