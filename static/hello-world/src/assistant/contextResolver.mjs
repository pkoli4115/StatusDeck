const CONTEXT_PROJECT_PATTERNS = [
  /\b(this|that|the current|current|same) project\b/,
  /\b(this|that|same) one\b/,
];
const CONTEXT_SPRINT_PATTERNS = [
  /\b(this|that|the current|current|same) sprint\b/,
  /\b(this|that|same) one\b/,
  /\bfor (this|that|it)\b/,
  /\bof (this|that|it)\b/,
];
const CONTEXT_PRONOUN_PATTERNS = [/\bthis\b/, /\bit\b/, /\bthat\b/];
const ORDINAL_WORDS = new Map([
  ['first', 0], ['1st', 0], ['one', 0],
  ['second', 1], ['2nd', 1], ['two', 1],
  ['third', 2], ['3rd', 2], ['three', 2],
  ['fourth', 3], ['4th', 3], ['four', 3],
  ['fifth', 4], ['5th', 4], ['five', 4],
]);

export function resolveConversationalReferences(normalized, context = {}) {
  const text = String(normalized ?? '');
  let sprintReference = '';
  let relativeSprint = '';

  if (/\b(previous|prior) sprint\b|\b(the )?one before (this|that|it)?\b/.test(text)) relativeSprint = 'previous';
  else if (/\b(last sprint|last one)\b/.test(text)) relativeSprint = 'previous';
  else if (/\b(next sprint|next one|upcoming sprint)\b/.test(text)) relativeSprint = 'next';
  else if (/\b(active sprint|current sprint)\b/.test(text)) relativeSprint = 'active';

  const referencesProject = CONTEXT_PROJECT_PATTERNS.some((pattern) => pattern.test(text));
  const referencesSprint = CONTEXT_SPRINT_PATTERNS.some((pattern) => pattern.test(text));
  const hasPronoun = CONTEXT_PRONOUN_PATTERNS.some((pattern) => pattern.test(text));
  if ((referencesSprint || hasPronoun) && context?.sprintId) sprintReference = 'context';
  if (relativeSprint) sprintReference = relativeSprint;

  const referencesIssueSet = /\b(those|these)\b(?:\s+(?:issues|items|tickets|stories|bugs))?|\bthem\b/.test(text);
  const referencesAssignee = /\b(that person|them|their work)\b/.test(text);

  let listChoiceIndex = null;
  const ordinalMatch = text.match(/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(?:one|sprint|item)?\b/);
  if (ordinalMatch && ORDINAL_WORDS.has(ordinalMatch[1])) listChoiceIndex = ORDINAL_WORDS.get(ordinalMatch[1]);
  const numericChoice = text.match(/\b(?:number\s+)?([1-5])\s*(?:st|nd|rd|th)?\s*(?:one|sprint|item)\b/);
  if (listChoiceIndex == null && numericChoice) listChoiceIndex = Math.max(0, Number(numericChoice[1]) - 1);

  return {
    usesContextProject: Boolean(referencesProject || (hasPronoun && context?.projectKey)),
    usesContextSprint: Boolean(referencesSprint || (hasPronoun && context?.sprintId)),
    sprintReference,
    relativeSprint,
    referencesIssueSet,
    referencesAssignee,
    hasPronoun,
    listChoiceIndex,
    contextAvailable: Boolean(context?.projectKey || context?.sprintId),
  };
}

export function getAssistantTemporalRequest(normalized) {
  const text = String(normalized ?? '');
  const countMatch = text.match(/\bnext\s+(\d{1,2})\s+sprints?\b|\b(\d{1,2})\s+(?:next|upcoming|future)\s+sprints?\b/);
  const requestedCount = countMatch ? Math.max(1, Math.min(10, Number(countMatch?.[1] ?? countMatch?.[2] ?? 1) || 1)) : 0;
  if (/\b(future|upcoming|coming)\s+sprints\b|\bnext\s+(?:few|couple|several)\s+sprints\b|\bwhat sprints? are coming\b|\bwhat (?:is )?coming next\b|\bwhat comes after (?:this|that|it)\b|\bwhat is planned after (?:this|that|it)\b/.test(text) || requestedCount) {
    return { type: 'future-list', count: requestedCount || 5 };
  }
  if (/\bnext sprint\b|\bupcoming sprint\b|\bwhat is planned next sprint\b/.test(text)) return { type: 'next', count: 1 };
  if (/\b(previous|prior|last) sprint\b|\bone before\b/.test(text)) return { type: 'previous', count: 1 };
  if (/\b(current|active|this) sprint\b/.test(text)) return { type: 'active', count: 1 };
  return { type: '', count: 0 };
}

export function getAssistantSprintReferences(normalized) {
  const text = String(normalized ?? '');
  const pair = text.match(/sprint\s+([a-z0-9._-]+)\s+(?:and|vs\.?|versus|with)\s+(?:sprint\s+)?([a-z0-9._-]+)/i);
  if (pair) return [pair[1], pair[2]];
  return [...text.matchAll(/sprint\s+([a-z0-9._-]+)/gi)]
    .map((match) => match[1])
    .filter((value) => !['summary', 'status', 'report', 'details', 'overview'].includes(String(value).toLowerCase()));
}
