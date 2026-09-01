export function assistantTextAction(label) {
  return { label, type: 'question', question: label };
}

export function assistantCommandAction(label, type, target = {}) {
  return { label, type, target };
}

export function assistantFollowUps(intent, context = {}) {
  const hasFuture = Number(context.futureCount ?? 0) > 0;
  const currentSprint = context.currentSprintName || 'this sprint';
  switch (intent) {
    case 'RISKS': case 'RAG_EXPLANATION':
      return ['Show overdue items', 'Show unresolved defects', 'How do we return to green?', 'Show sprint predictability', ...(hasFuture ? ['Show future sprints'] : [])];
    case 'BURNDOWN':
      return ['Show scope changes', 'What is the sprint completion?', 'Why is this sprint off track?', 'Compare with the previous sprint'];
    case 'COMPLETION': case 'COMMITMENT_DELIVERY':
      return ['Show burndown', 'Show scope creep', 'What are the risks?', 'Show sprint predictability'];
    case 'PREDICTABILITY':
      return ['Show commitment vs delivery', 'Show scope changes', 'Show estimate confidence', 'Compare with the previous sprint'];
    case 'CARRY_OVER':
      return ['Show future sprints', 'Show remaining work', 'What are the risks?', 'Generate report for this'];
    case 'SCOPE_CHANGES':
      return ['Show commitment vs delivery', 'Show remaining work', 'What are the risks?', 'Show sprint predictability', ...(hasFuture ? ['Show future sprints'] : [])];
    case 'WORKLOAD': case 'CAPACITY':
      return ['Show remaining work', 'Show overdue items', 'What are the risks?', 'Show work item types'];
    case 'STATUS_DISTRIBUTION':
      return ['Show work item types', 'Show priority distribution', 'Show remaining work', 'What are the risks?'];
    case 'ISSUE_TYPES': case 'PRIORITY_DISTRIBUTION':
      return ['Show status distribution', 'Show workload', 'Show remaining work', 'What are the risks?'];
    case 'UNESTIMATED_WORK': case 'ESTIMATES':
      return ['Show estimate confidence', 'Show unestimated work', 'What is the effort variance?', 'Show sprint predictability'];
    case 'AGING_WORK': case 'BLOCKERS':
      return ['Show overdue items', 'Who owns the remaining work?', 'What are the risks?', 'How do we return to green?'];
    case 'THROUGHPUT': case 'VELOCITY':
      return ['Compare with the previous sprint', 'Show commitment vs delivery', 'Show sprint predictability', ...(hasFuture ? ['Show future sprints'] : [])];
    case 'SPRINT_GOAL':
      return ['Give me a sprint summary', 'What are the risks?', 'Show commitment vs delivery', 'Generate report for this'];
    case 'LIST_FUTURE_SPRINTS': {
      const first = context.futureSprints?.[0];
      if (!first) return ['Give me a sprint summary', 'What are the current risks?'];
      return [`Summarize ${first.name}`, `Load ${first.name}`, `Generate report for ${first.name}`, `Compare ${first.name} with ${currentSprint}`];
    }
    case 'SELECT_SPRINT':
      return ['Give me a sprint summary', 'What are the risks?', 'Show burndown', 'Generate report for this'];
    case 'SPRINT_SUMMARY':
      return ['What are the risks?', 'Show burndown', 'Show remaining work', 'Show commitment vs delivery', ...(hasFuture ? ['Show future sprints'] : [])];
    default:
      return ['What are the current risks?', 'Give me a sprint summary', 'Show burndown', 'Show remaining work', ...(hasFuture ? ['Show future sprints'] : [])];
  }
}
