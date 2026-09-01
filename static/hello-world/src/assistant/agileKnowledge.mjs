const SUPPORTED = 'supported';
const LIMITED = 'limited';
const UNSUPPORTED = 'unsupported';

// StatusDeck Agile/Jira delivery vocabulary. These concepts are deliberately
// mapped to data that StatusDeck can actually support from Jira. Unsupported
// concepts return an honest capability message instead of inventing a KPI.
export const AGILE_CONCEPTS = Object.freeze([
  {
    id: 'BURNDOWN', intent: 'BURNDOWN', support: SUPPORTED, priority: 120,
    patterns: [
      /\bburn\s*down\b/, /\bburndown\b/, /\bsprint burn\b/, /\bburning down\b/,
      /\bremaining (?:work )?trend\b/, /\bremaining over time\b/,
    ],
  },
  {
    id: 'COMMITMENT_DELIVERY', intent: 'COMMITMENT_DELIVERY', support: SUPPORTED, priority: 118,
    patterns: [
      /\bcommit(?:ment|ted)?\s*(?:vs\.?|versus|against|and|to)\s*(?:deliver(?:ed|y)?|complet(?:e|ed|ion))\b/,
      /\bplanned\s*(?:vs\.?|versus|against|and|to)\s*(?:delivered|completed)\b/,
      /\bcommitted (?:work|points|items).*\bcompleted\b/, /\bwhat did we commit.*deliver\b/,
    ],
  },
  {
    id: 'PREDICTABILITY', intent: 'PREDICTABILITY', support: LIMITED, priority: 116,
    patterns: [
      /\bpredictab(?:ility|le)\b/, /\bcommitment reliability\b/, /\bdelivery reliability\b/,
      /\bforecast reliability\b/, /\blikely to meet (?:the )?commitment\b/, /\bwill we meet (?:the )?commitment\b/,
      /\bare we likely to finish\b/, /\bwill we finish\b/,
    ],
  },
  {
    id: 'CARRY_OVER', intent: 'CARRY_OVER', support: SUPPORTED, priority: 115,
    patterns: [
      /\bcarry[ -]?over\b/, /\bspill[ -]?over\b/, /\broll(?:ed)?[ -]?over\b/,
      /\bunfinished work.*next sprint\b/, /\bwork moved to (?:the )?next sprint\b/,
    ],
  },
  {
    id: 'SCOPE_CHANGES', intent: 'SCOPE_CHANGES', support: SUPPORTED, priority: 112,
    patterns: [
      /\bscope creep\b/, /\bscope (?:change|changes|movement|increase|decrease|growth)\b/,
      /\bwork added after sprint start\b/, /\badded after sprint start\b/,
      /\bwhat was added\b/, /\bwhat was removed\b/, /\bcommitment change\b/,
    ],
  },
  {
    id: 'UNESTIMATED_WORK', intent: 'UNESTIMATED_WORK', support: SUPPORTED, priority: 110,
    patterns: [
      /\bunestimated\b/, /\bmissing estimates?\b/, /\bestimate gaps?\b/,
      /\bwithout estimates?\b/, /\bnot estimated\b/,
    ],
  },
  {
    id: 'ESTIMATE_CONFIDENCE', intent: 'ESTIMATES', support: SUPPORTED, priority: 108,
    patterns: [
      /\bestimate confidence\b/, /\bestimate coverage\b/, /\bremaining estimate coverage\b/,
      /\boriginal estimate coverage\b/, /\bforecast effort\b/, /\beffort variance\b/,
      /\bremaining estimate\b/, /\boriginal estimate\b/, /\bforecast provisional\b/,
    ],
  },
  {
    id: 'VELOCITY', intent: 'VELOCITY', support: SUPPORTED, priority: 106,
    patterns: [
      /\bvelocity\b/, /\bteam pace\b/, /\bvelocity trend\b/, /\bdelivery pace\b/,
    ],
  },
  {
    id: 'THROUGHPUT', intent: 'THROUGHPUT', support: SUPPORTED, priority: 104,
    patterns: [
      /\bthroughput\b/, /\bcompleted items?\b/, /\bitems? finished\b/, /\bwork items? completed\b/,
    ],
  },
  {
    id: 'COMPLETION', intent: 'COMPLETION', support: SUPPORTED, priority: 102,
    patterns: [
      /\bcompletion (?:rate|ratio|percentage|percent)\b/, /\bpercent(?:age)? complete\b/,
      /\bhow much (?:is|was) done\b/, /\bhow much (?:is|was) complete\b/,
      /\bcompletion\b/,
    ],
  },
  {
    id: 'STATUS_DISTRIBUTION', intent: 'STATUS_DISTRIBUTION', support: SUPPORTED, priority: 101,
    patterns: [
      /\bstatus distribution\b/, /\bissues? by status\b/, /\bwork items? by status\b/,
      /\bhow many.*(?:to do|in progress|done)\b/, /\bwip\b/, /\bwork in progress\b/,
    ],
  },
  {
    id: 'ISSUE_TYPES', intent: 'ISSUE_TYPES', support: SUPPORTED, priority: 100,
    patterns: [
      /\bissue types?\b/, /\bwork item types?\b/, /\bstories? vs bugs?\b/, /\bby issue type\b/,
      /\bby work item type\b/,
    ],
  },
  {
    id: 'PRIORITY_DISTRIBUTION', intent: 'PRIORITY_DISTRIBUTION', support: SUPPORTED, priority: 99,
    patterns: [
      /\bpriority distribution\b/, /\bissues? by priority\b/, /\bwork items? by priority\b/,
      /\bhigh priority (?:items|issues|work)\b/, /\bcritical priority\b/,
    ],
  },
  {
    id: 'AGING_WORK', intent: 'AGING_WORK', support: LIMITED, priority: 98,
    patterns: [
      /\baging work\b/, /\bageing work\b/, /\bstale work\b/, /\bold open items?\b/, /\boldest open items?\b/,
    ],
  },
  {
    id: 'SPRINT_GOAL', intent: 'SPRINT_GOAL', support: LIMITED, priority: 97,
    patterns: [
      /\bsprint goal\b/, /\bgoal for (?:this|the) sprint\b/, /\bwhat is the goal\b/,
      /\bare we meeting (?:the )?sprint goal\b/,
    ],
  },
  {
    id: 'BLOCKERS', intent: 'BLOCKERS', support: LIMITED, priority: 96,
    patterns: [
      /\bblockers?\b/, /\bimpediments?\b/, /\bblocked (?:items|issues|work)\b/,
    ],
  },
  {
    id: 'CAPACITY', intent: 'CAPACITY', support: LIMITED, priority: 95,
    patterns: [
      /\bcapacity utilization\b/, /\bteam capacity\b/, /\bteam bandwidth\b/,
      /\bresource utilization\b/, /\bunderutilized\b/, /\bover capacity\b/,
    ],
  },
  {
    id: 'WORKLOAD', intent: 'WORKLOAD', support: SUPPORTED, priority: 94,
    patterns: [
      /\bworkload\b/, /\bload by assignee\b/, /\bwork by assignee\b/, /\bwho has (?:the )?most work\b/,
      /\bwho owns\b/, /\boverloaded\b/,
    ],
  },
  {
    id: 'DEFECTS', intent: 'DEFECTS', support: SUPPORTED, priority: 92,
    patterns: [/\bdefects?\b/, /\bbugs?\b/, /\bquality risk\b/, /\bunresolved defects?\b/],
  },
  {
    id: 'OVERDUE', intent: 'OVERDUE', support: SUPPORTED, priority: 91,
    patterns: [/\boverdue\b/, /\bpast due\b/, /\blate items?\b/, /\blate work\b/],
  },
  {
    id: 'REMAINING_WORK', intent: 'REMAINING_WORK', support: SUPPORTED, priority: 90,
    patterns: [
      /\bremaining work\b/, /\bopen work\b/, /\bopen items?\b/, /\bincomplete work\b/,
      /\bunfinished work\b/, /\bwhat remains\b/, /\bwhat is left\b/, /\bleft to do\b/,
    ],
  },
  {
    id: 'RISKS', intent: 'RISKS', support: SUPPORTED, priority: 89,
    patterns: [
      /\bdelivery risks?\b/, /\bcurrent risks?\b/, /\bwhat can derail\b/, /\bcritical concerns?\b/,
      /\bwhat are the risks?\b/,
    ],
  },
  {
    id: 'RAG_EXPLANATION', intent: 'RAG_EXPLANATION', support: SUPPORTED, priority: 88,
    patterns: [
      /\boverall rag\b/, /\bdelivery health\b/, /\bwhy (?:is|are).*(?:red|amber|green)\b/,
      /\bwhy red\b/, /\bwhy amber\b/, /\bwhy green\b/, /\bhealth status\b/,
    ],
  },
  {
    id: 'SPRINT_SUMMARY', intent: 'SPRINT_SUMMARY', support: SUPPORTED, priority: 70,
    patterns: [
      /\bsprint health\b/, /\bsprint status\b/, /\bhow are we doing\b/, /\bhow is (?:this|the) sprint\b/,
      /\bexecutive view\b/, /\bsprint summary\b/,
    ],
  },
  // Recognised Agile concepts that StatusDeck should not pretend to calculate
  // from the current assistant snapshot.
  {
    id: 'CYCLE_TIME', intent: 'UNSUPPORTED_KPI', support: UNSUPPORTED, priority: 130,
    patterns: [/\bcycle time\b/],
    reason: 'Cycle time requires workflow transition timestamps for each work item; the current StatusDeck Assistant snapshot does not calculate that metric.',
  },
  {
    id: 'LEAD_TIME', intent: 'UNSUPPORTED_KPI', support: UNSUPPORTED, priority: 129,
    patterns: [/\blead time\b/],
    reason: 'Lead time needs a defined start/end policy and historical workflow timestamps; StatusDeck does not currently calculate it in the Assistant.',
  },
  {
    id: 'BACKLOG_HEALTH', intent: 'UNSUPPORTED_KPI', support: UNSUPPORTED, priority: 128,
    patterns: [/\bbacklog health\b/, /\bhealthy backlog\b/, /\bbacklog quality\b/],
    reason: 'Backlog health requires backlog-wide data and refinement rules. The current Assistant deliberately avoids loading the full backlog unless that feature is explicitly built.',
  },
  {
    id: 'BURNUP', intent: 'UNSUPPORTED_KPI', support: UNSUPPORTED, priority: 127,
    patterns: [/\bburn\s*up\b/, /\bburnup\b/],
    reason: 'StatusDeck currently provides detailed daily/live burndown data, but the Assistant does not yet calculate a dedicated burnup series.',
  },
  {
    id: 'DEFINITION_OF_DONE', intent: 'UNSUPPORTED_KPI', support: UNSUPPORTED, priority: 126,
    patterns: [/\bdefinition of done\b/, /\bdod\b/],
    reason: 'Definition of Done is a team policy and is not reliably inferable from Jira issue data unless the organisation models it explicitly.',
  },
  {
    id: 'DEFECT_LEAKAGE', intent: 'UNSUPPORTED_KPI', support: UNSUPPORTED, priority: 125,
    patterns: [/\bdefect leakage\b/, /\bleakage rate\b/],
    reason: 'Defect leakage requires a clear production/release defect classification. The current sprint snapshot only knows defects in Jira scope and their current status.',
  },
  {
    id: 'RELEASE_FORECAST', intent: 'UNSUPPORTED_KPI', support: UNSUPPORTED, priority: 124,
    patterns: [/\brelease forecast\b/, /\brelease predict(?:ion|ability)\b/],
    reason: 'Release forecasting needs release/version scope and cross-sprint planning data. StatusDeck Assistant v1 is intentionally sprint-focused.',
  },
].sort((a, b) => b.priority - a.priority));

export function detectAgileConcept(normalized) {
  const text = String(normalized ?? '').trim();
  if (!text) return null;
  for (const concept of AGILE_CONCEPTS) {
    if (concept.patterns.some((pattern) => pattern.test(text))) {
      return {
        id: concept.id,
        intent: concept.intent,
        support: concept.support,
        reason: concept.reason || '',
        confidence: 'high',
      };
    }
  }
  return null;
}

export function getUnsupportedAgileMessage(conceptId) {
  const concept = AGILE_CONCEPTS.find((item) => item.id === conceptId && item.support === UNSUPPORTED);
  if (!concept) return 'StatusDeck does not currently calculate that Agile metric from the available Jira data.';
  return `${concept.id.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase())}\n• ${concept.reason}\n• I will not invent a value. Ask for a supported sprint KPI such as completion, commitment vs delivery, burndown, velocity, scope movement, workload, defects, overdue work, estimates, or RAG.`;
}

export function getAgileKnowledgeSummary() {
  return AGILE_CONCEPTS.map(({ id, intent, support }) => ({ id, intent, support }));
}
