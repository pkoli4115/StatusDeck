import { detectAgileConcept } from './agileKnowledge.mjs';

export const ASSISTANT_MODES = Object.freeze({
  instant: { label: 'Instant', description: 'Quick answer using current context and the minimum Jira data required.' },
  medium: { label: 'Medium', description: 'Targeted supporting Jira analysis for the current question.' },
  high: { label: 'High', description: 'Deeper but bounded cross-sprint/project analysis only when the question requires it.' },
});

function matchAny(q, patterns) { return patterns.some((pattern) => pattern.test(q)); }

export function resolveAssistantIntent(normalized) {
  const q = String(normalized ?? '').trim();
  if (!q) return { type: 'UNKNOWN', confidence: 'low' };

  // Specific temporal/list intents run before generic summary wording.
  if (matchAny(q, [
    /\b(show|list|give|display|tell me|what are|which are|can you (?:show|give|list))\b.*\b(future|upcoming|coming)\s+sprints\b/,
    /\bnext\s+(?:\d+|few|couple|several)\s+sprints?\b/,
    /\bwhat (?:is )?coming next\b/, /\bwhat sprints? are coming\b/, /\bwhat comes after (?:this|that|it)\b/,
    /\bwhat is planned after (?:this|that|it)\b/, /^future(?: sprints?)?(?: please)?$/,
    /^upcoming(?: sprints?)?(?: please)?$/, /^what is next(?: please)?$/, /^next(?: please)?$/,
    /\b(?:give|show|list)\b.*\b(?:future|upcoming|next)\s+(?:ones|sprints?)\b/,
  ])) return { type: 'LIST_FUTURE_SPRINTS', confidence: 'high' };

  if (/\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+(?:one|sprint|item)?\b/.test(q)) return { type: 'SELECT_SPRINT', confidence: 'medium' };

  const agileConcept = detectAgileConcept(q);
  if (agileConcept) return { type: agileConcept.intent, confidence: agileConcept.confidence, concept: agileConcept.id, support: agileConcept.support, reason: agileConcept.reason };

  const rules = [
    ['REFERENCED_ITEMS', [/\b(show|open|list)\b.*\b(those|these|them)\b/]],
    ['GENERATE_REPORT', [
      /\b(generate|create|build|make|prepare)\b.*\b(report|executive report|sprint report)\b/,
      /\b(report)\b.*\b(generate|create|build|prepare)\b/,
      /\b(give|show)\b.*\b(?:the )?report\b/, /\breport for (?:this|it|that sprint)\b/,
    ]],
    ['PUBLISH', [/\b(publish|send|put)\b.*\b(confluence|report|this|it)\b/, /\bpublish this\b/]],
    ['LOAD_SPRINT', [/\b(load|open|go to|take me to|show in statusdeck|switch to)\b.*\b(sprint|project|this|it)\b/]],
    ['COMPARE', [/\b(compare|versus|vs\.?|difference between|better than|worse than)\b/]],
    ['RETURN_TO_GREEN', [/\breturn to green\b/, /\bget (?:this|it|sprint) (?:back )?to green\b/, /\bwhat.*make.*green\b/, /\bhow.*reach green\b/]],
    ['RAG_EXPLANATION', [/\bwhy\b.*\b(red|amber|green)\b/, /\b(rag|delivery health|healthy|unhealthy|health status)\b/, /\bwhy is (?:this|it)\b/]],
    ['OVERDUE', [/\b(overdue|late|late items?|past due)\b/]],
    ['DEFECTS', [/\b(defects?|bugs?|quality risk)\b/]],
    ['RISKS', [/\b(risks?|critical|blockers?|derail|concerns?)\b/]],
    ['WORKLOAD', [/\b(workload|assignee|owner|owns|overloaded|most work|capacity|who has)\b/]],
    ['SCOPE_CHANGES', [/\b(scope|scope creep|added|removed|changed after|commitment change)\b/]],
    ['ESTIMATES', [/\b(estimate|estimates|forecast|variance|remaining estimate|estimate confidence)\b/]],
    ['VELOCITY', [/\b(velocity|trend|trending|last \d+ sprints?)\b/]],
    ['REMAINING_WORK', [/\b(remaining work|open work|open items?|incomplete|not complete|unfinished|left to do|what remains|what is left)\b/]],
    ['SPRINT_SUMMARY', [
      /\b(next|upcoming|previous|prior|last|current|active|this)\s+sprint\b.*\b(summary|summarise|summarize|details?|overview|status|look|planned)\b/,
      /\b(summary|summarise|summarize|details?|overview|status|tell me about|how does|how is|what is planned)\b.*\b(next|upcoming|previous|prior|last|current|active|this)\s+sprint\b/,
      /\b(sprint summary|summary|summarise|summarize|details?|overview|status|how is|how did|what happened|what is happening)\b/,
    ]],
    ['HELP', [/\b(help|what can you do|options|commands)\b/]],
  ];
  for (const [type, patterns] of rules) if (matchAny(q, patterns)) return { type, confidence: 'high' };
  return { type: 'UNKNOWN', confidence: 'low' };
}

export function getAssistantAnalysisPlan(mode = 'instant', intent = 'UNKNOWN') {
  const safeMode = ASSISTANT_MODES[mode] ? mode : 'instant';
  const historicalIntent = ['COMPARE', 'VELOCITY', 'PREDICTABILITY'].includes(intent);
  const metadataOnly = ['LIST_FUTURE_SPRINTS', 'SELECT_SPRINT', 'UNSUPPORTED_KPI'].includes(intent);
  return {
    mode: safeMode,
    fetchSnapshot: !['HELP', 'UNKNOWN', 'GENERATE_REPORT', 'LOAD_SPRINT', 'PUBLISH', 'LIST_FUTURE_SPRINTS', 'SELECT_SPRINT', 'UNSUPPORTED_KPI', 'CARRY_OVER'].includes(intent),
    fetchVelocity: intent === 'VELOCITY' || (intent === 'PREDICTABILITY' && safeMode !== 'instant'),
    fetchNextSprintOutlook: intent === 'CARRY_OVER',
    maxSprintMetadata: safeMode === 'instant' ? 100 : safeMode === 'medium' ? 200 : 350,
    maxHistoricalSprints: historicalIntent ? (safeMode === 'instant' ? 2 : safeMode === 'medium' ? 4 : 6) : 1,
    allowCrossProject: intent === 'COMPARE',
    metadataOnly,
  };
}
