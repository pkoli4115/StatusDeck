import { getUnsupportedAgileMessage } from './agileKnowledge.mjs';

function n(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(parsed) : '0';
}
function hours(value) { return `${n(value)}h`; }
function pct(value) { return `${n(value)}%`; }
function estimationDisplay(report) {
  const source = report?.estimationSource ?? {};
  const isHours = source.type === 'time' || /estimate/i.test(source.fieldName ?? source.name ?? '');
  return { short: isHours ? 'hours' : (source.type === 'issueCount' ? 'items' : 'points') };
}
function sortedEntries(counts = {}) {
  return Object.entries(counts).sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0])));
}
function issueAgeDays(issue, now = Date.now()) {
  const created = new Date(issue?.created ?? '').getTime();
  if (!Number.isFinite(created)) return null;
  return Math.max(0, Math.floor((now - created) / 86400000));
}
function openIssuesFor(report) {
  return (report?.metrics?.reportingIssues ?? []).filter((issue) => issue.statusCategoryKey !== 'done');
}
function overdueIssuesFor(report) { return openIssuesFor(report).filter((issue) => issue.isOverdue || Number(issue.daysOverdue ?? 0) > 0); }
function unestimatedIssuesFor(report) {
  return openIssuesFor(report).filter((issue) => Number(issue.storyPoints ?? issue.estimationValue ?? 0) <= 0);
}
function priorityCountsFor(report) {
  const counts = {};
  (report?.metrics?.reportingIssues ?? []).forEach((issue) => { counts[issue.priority || 'None'] = (counts[issue.priority || 'None'] ?? 0) + 1; });
  return counts;
}

export function buildUnsupportedAgileAnswer(conceptId) {
  return { text: getUnsupportedAgileMessage(conceptId), issueKeys: [] };
}

export function buildCarryOverAnswer(outlook) {
  if (!outlook?.available) {
    const reason = outlook?.reason === 'no-future-sprint'
      ? 'There is no future sprint on this board, so StatusDeck cannot confirm carry-over into a next sprint.'
      : 'StatusDeck could not resolve the next sprint needed to calculate carry-over.';
    return { text: `Carry-over / spillover\n• ${reason}\n• I will not label unfinished work as carry-over unless it is actually present in the next sprint.`, issueKeys: [] };
  }
  return {
    text: `Carry-over / spillover\n• Next sprint: ${outlook.sprint?.name ?? 'Future sprint'}\n• Carry-over items: ${n(outlook.carryOverItems)}\n• Carry-over: ${n(outlook.carryOverPoints)} ${outlook.estimationSource?.unit || 'points'}\n• Planned next-sprint scope: ${n(outlook.plannedItems)} items / ${n(outlook.plannedPoints)} ${outlook.estimationSource?.unit || 'points'}\n• Unestimated next-sprint items: ${n(outlook.unestimatedItems)}\n\nStatusDeck counts carry-over only when the same Jira issue appears in both the current and next sprint.`,
    issueKeys: outlook.carryOverKeys ?? [],
  };
}

export function buildAssistantAnswer(intent, { report, velocityReport, readiness, returnToGreen = [], boardConfiguration, rag, mode = 'instant' }) {
  if (!report) return { text: 'I do not have sprint data for that question yet.', issueKeys: [] };
  const display = estimationDisplay(report);
  const issues = report?.metrics?.reportingIssues ?? [];
  const openIssues = openIssuesFor(report);
  const overdueIssues = overdueIssuesFor(report);
  const unresolvedDefects = Number(readiness?.openDefects ?? 0);
  const history = report?.history;

  switch (intent) {
    case 'RAG_EXPLANATION': {
      const reasons = [];
      if (report.metrics.overdue > 0) reasons.push(`${report.metrics.overdue} overdue open item(s)`);
      if (unresolvedDefects > 0) reasons.push(`${unresolvedDefects} unresolved defect(s)`);
      if (report.metrics.effort?.forecastProvisional) reasons.push('Remaining Estimate coverage is below the configured confidence threshold');
      if (!reasons.length) reasons.push('All configured delivery thresholds are currently within tolerance.');
      return { text: `RAG explanation\n• Overall status: ${rag?.label ?? 'NOT SET'}\n${reasons.map((reason) => `• ${reason}`).join('\n')}`, issueKeys: overdueIssues.map((issue) => issue.key) };
    }
    case 'RISKS': {
      const risks = [];
      if (report.metrics.overdue > 0) risks.push(`${report.metrics.overdue} overdue open item(s)`);
      if (unresolvedDefects > 0) risks.push(`${unresolvedDefects} unresolved defect(s)`);
      if (report.metrics.effort?.forecastProvisional) risks.push('Forecast effort is provisional because Remaining Estimate coverage is incomplete');
      const scopeAdded = Number(history?.scopeChange?.addedStoryPoints ?? 0);
      if (scopeAdded > 0) risks.push(`${n(scopeAdded)} ${display.short} were added after sprint start`);
      return { text: risks.length ? `Risk summary\n${risks.map((risk) => `• ${risk}`).join('\n')}` : 'Risk summary\n• No material risk was detected from the available Jira data and configured thresholds.', issueKeys: overdueIssues.map((issue) => issue.key) };
    }
    case 'COMPLETION':
      return {
        text: `Sprint completion\n• ${pct(report.metrics.storyPointCompletionPercentage)} of ${display.short} are complete\n• ${n(report.metrics.completedStoryPoints)} of ${n(report.metrics.committedStoryPoints)} ${display.short} delivered\n• ${n(report.metrics.completed)} of ${n(report.metrics.total)} work items complete\n• ${n(report.metrics.open)} items remain open`,
        issueKeys: openIssues.map((issue) => issue.key),
      };
    case 'COMMITMENT_DELIVERY': {
      const committed = Number(history?.originalCommitment?.storyPoints ?? report.metrics.committedStoryPoints ?? 0);
      const delivered = Number(report.metrics.completedStoryPoints ?? 0);
      const currentScope = Number(history?.currentScope?.storyPoints ?? report.metrics.committedStoryPoints ?? 0);
      const deliveryPct = committed > 0 ? (delivered / committed) * 100 : 0;
      return {
        text: `Commitment vs delivery\n• Sprint-start commitment: ${n(committed)} ${display.short}\n• Current scope: ${n(currentScope)} ${display.short}\n• Delivered so far: ${n(delivered)} ${display.short}\n• Delivered vs sprint-start commitment: ${pct(deliveryPct)}${history?.available ? `\n• Scope added: ${n(history.scopeChange?.addedStoryPoints ?? 0)} ${display.short}\n• Scope removed: ${n(history.scopeChange?.removedStoryPoints ?? 0)} ${display.short}` : ''}`,
        issueKeys: openIssues.map((issue) => issue.key),
      };
    }
    case 'BURNDOWN': {
      if (!history?.available || !(history?.burndownDaily ?? []).length) {
        return { text: 'Burndown\n• Sprint history is not available for this sprint, so StatusDeck cannot calculate the burndown trajectory.', issueKeys: [] };
      }
      const points = history.burndownDaily;
      const first = points[0] ?? {};
      const last = points[points.length - 1] ?? {};
      const gap = Number(last.remainingPoints ?? 0) - Number(last.idealRemainingPoints ?? 0);
      const position = Math.abs(gap) < 0.01 ? 'on the ideal line' : gap > 0 ? 'above the ideal remaining line' : 'ahead of the ideal remaining line';
      return {
        text: `Sprint burndown\n• Start scope: ${n(first.scopePoints)} ${display.short}\n• Current scope: ${n(last.scopePoints)} ${display.short}\n• Remaining: ${n(last.remainingPoints)} ${display.short}\n• Completed: ${n(last.completedPoints)} ${display.short}\n• Ideal remaining now: ${n(last.idealRemainingPoints)} ${display.short}\n• Position: ${position}\n• Daily points available: ${points.length}\n• Live Jira-event points available: ${(history.burndownLive ?? []).length}`,
        issueKeys: openIssues.map((issue) => issue.key),
      };
    }
    case 'THROUGHPUT':
      return {
        text: `Sprint throughput\n• ${n(report.metrics.completed)} work item(s) completed so far\n• ${n(report.metrics.open)} work item(s) remain open\n• Item completion: ${pct(report.metrics.completionPercentage)}\n• Delivered estimate: ${n(report.metrics.completedStoryPoints)} ${display.short}`,
        issueKeys: openIssues.map((issue) => issue.key),
      };
    case 'STATUS_DISTRIBUTION': {
      const rows = sortedEntries(report.metrics.statusCounts).slice(0, mode === 'high' ? 12 : 8);
      const inProgress = issues.filter((issue) => issue.statusCategoryKey === 'indeterminate').length;
      return {
        text: `Status / WIP distribution\n${rows.map(([name, count]) => `• ${name}: ${n(count)}`).join('\n')}\n• Work in progress (Jira “In Progress” category): ${n(inProgress)}`,
        issueKeys: openIssues.map((issue) => issue.key),
      };
    }
    case 'ISSUE_TYPES': {
      const rows = sortedEntries(report.metrics.typeCounts).slice(0, mode === 'high' ? 12 : 8);
      return { text: `Work-item types\n${rows.map(([name, count]) => `• ${name}: ${n(count)}`).join('\n')}`, issueKeys: [] };
    }
    case 'PRIORITY_DISTRIBUTION': {
      const rows = sortedEntries(priorityCountsFor(report)).slice(0, mode === 'high' ? 12 : 8);
      return { text: `Priority distribution\n${rows.map(([name, count]) => `• ${name}: ${n(count)}`).join('\n')}`, issueKeys: issues.filter((issue) => /highest|high|critical|blocker/i.test(issue.priority ?? '')).map((issue) => issue.key) };
    }
    case 'UNESTIMATED_WORK': {
      const unestimated = unestimatedIssuesFor(report);
      const issueCountMode = report?.estimationSource?.type === 'issueCount';
      return {
        text: issueCountMode
          ? 'Unestimated work\n• This board/report is using Issue Count as the estimation source, so “unestimated” is not meaningful for the selected metric.'
          : `Unestimated work\n• ${n(unestimated.length)} open item(s) have no value in the selected estimation field.${unestimated.length ? `\n\nExamples\n${unestimated.slice(0, 10).map((issue) => `• ${issue.key} — ${issue.summary}`).join('\n')}` : ''}`,
        issueKeys: unestimated.map((issue) => issue.key),
      };
    }
    case 'AGING_WORK': {
      const aged = openIssues.map((issue) => ({ issue, age: issueAgeDays(issue) })).filter((item) => item.age != null).sort((a, b) => b.age - a.age);
      return {
        text: aged.length
          ? `Aging open work\n• Oldest open item age: ${aged[0].age} days since Jira creation\n\nOldest open items\n${aged.slice(0, mode === 'high' ? 10 : 6).map(({ issue, age }) => `• ${issue.key} — ${age} days — ${issue.summary}`).join('\n')}\n\nThis is age since issue creation, not cycle time or time-in-status.`
          : 'Aging open work\n• Jira creation timestamps are not available for the current open-item snapshot.',
        issueKeys: aged.map(({ issue }) => issue.key),
      };
    }
    case 'SPRINT_GOAL':
      return {
        text: `Sprint goal\n• ${report.sprint.goal || 'No Sprint Goal is set in Jira.'}\n• StatusDeck can show the goal and delivery evidence, but it does not claim that the goal is achieved unless the team models explicit goal acceptance in Jira.`,
        issueKeys: [],
      };
    case 'BLOCKERS': {
      const blocked = openIssues.filter((issue) => /blocked|impediment/i.test(issue.status ?? ''));
      return {
        text: blocked.length
          ? `Blocked / impeded work\n• ${blocked.length} open item(s) have a Jira status containing Blocked/Impediment.\n${blocked.slice(0, 10).map((issue) => `• ${issue.key} — ${issue.status} — ${issue.summary}`).join('\n')}`
          : 'Blocked / impeded work\n• I found no open item whose Jira status contains Blocked/Impediment.\n• This does not prove there are no blockers if your Jira workflow records blockers in links, flags, comments, or another custom field.',
        issueKeys: blocked.map((issue) => issue.key),
      };
    }
    case 'CAPACITY': {
      const ranked = (report.metrics.workload ?? []).filter((person) => Number(person.open ?? 0) > 0).sort((a, b) => Number(b.remainingStoryPoints ?? 0) - Number(a.remainingStoryPoints ?? 0)).slice(0, mode === 'high' ? 10 : 5);
      return {
        text: `Capacity / bandwidth view\n${ranked.length ? ranked.map((person) => `• ${person.name}: ${n(person.open)} open item(s), ${n(person.remainingStoryPoints)} ${display.short} remaining`).join('\n') : '• No open assignee workload is available.'}\n\nStatusDeck is showing remaining workload distribution. True capacity utilisation needs an explicit team/person capacity denominator, so I will not invent a utilisation percentage.`,
        issueKeys: openIssues.map((issue) => issue.key),
      };
    }
    case 'PREDICTABILITY': {
      let score = 100;
      const signals = [];
      const original = Number(history?.originalCommitment?.storyPoints ?? report.metrics.committedStoryPoints ?? 0);
      const added = Number(history?.scopeChange?.addedStoryPoints ?? 0);
      const removed = Number(history?.scopeChange?.removedStoryPoints ?? 0);
      const netScopeChangePct = original > 0 ? ((added - removed) / original) * 100 : 0;
      if (Math.abs(netScopeChangePct) > 15) { score -= 25; signals.push(`Scope moved ${pct(netScopeChangePct)} from sprint-start commitment`); }
      if (Number(report.metrics.overdue ?? 0) > 0) { score -= 20; signals.push(`${report.metrics.overdue} overdue open item(s)`); }
      if (report.metrics.effort?.forecastProvisional) { score -= 20; signals.push(`Remaining Estimate coverage is ${pct(report.metrics.effort?.coverage?.remainingEstimateCoveragePercentage ?? 0)}`); }
      if (Number(readiness?.openDefects ?? 0) > 0) { score -= 15; signals.push(`${readiness.openDefects} unresolved defect(s)`); }
      if (report.sprint.state === 'closed' && Number(report.metrics.storyPointCompletionPercentage ?? 0) < 85) { score -= 20; signals.push(`Closed-sprint delivery was ${pct(report.metrics.storyPointCompletionPercentage)}`); }
      const label = score >= 75 ? 'HIGHER' : score >= 50 ? 'MEDIUM' : 'LOWER';
      const velocityLine = velocityReport ? `\n• Recent average completed: ${n(velocityReport.averageCompleted ?? 0)} ${display.short}` : '';
      return {
        text: `Sprint predictability signal: ${label}\n${signals.length ? signals.map((signal) => `• ${signal}`).join('\n') : '• No major instability signal is visible in the current sprint data.'}${velocityLine}\n\nThis is a deterministic StatusDeck delivery signal, not a statistical probability of finishing.`,
        issueKeys: overdueIssues.map((issue) => issue.key),
      };
    }
    case 'OVERDUE':
      return { text: `Overdue work\n• ${overdueIssues.length} open item(s) are overdue.${overdueIssues.length ? `\n\nHighest-priority overdue items\n${overdueIssues.slice(0, 10).map((issue) => `• ${issue.key} — ${issue.summary}`).join('\n')}${overdueIssues.length > 10 ? '\n• …' : ''}` : ''}`, issueKeys: overdueIssues.map((issue) => issue.key) };
    case 'DEFECTS':
      return { text: `Defects\n• ${report.metrics.defects} defect(s) are in sprint scope\n• ${unresolvedDefects} remain unresolved`, issueKeys: openIssues.filter((issue) => /bug|defect/i.test(issue.issueType ?? '')).map((issue) => issue.key) };
    case 'WORKLOAD': {
      const byAssignee = new Map();
      openIssues.forEach((issue) => {
        const name = issue.assignee || 'Unassigned';
        const value = Number(issue.storyPoints ?? issue.estimationValue ?? 0) || 0;
        byAssignee.set(name, (byAssignee.get(name) ?? 0) + value);
      });
      const ranking = [...byAssignee.entries()].sort((a, b) => b[1] - a[1]).slice(0, mode === 'high' ? 10 : 5);
      return { text: ranking.length ? `Highest remaining workload\n${ranking.map(([name, value], index) => `${index + 1}. ${name} — ${n(value)} ${display.short}`).join('\n')}` : 'Highest remaining workload\n• There is no open assignee workload in this sprint.', issueKeys: openIssues.map((issue) => issue.key) };
    }
    case 'REFERENCED_ITEMS':
      return { text: openIssues.length ? `Referenced Jira items\n${openIssues.slice(0, 12).map((issue) => `• ${issue.key} — ${issue.summary}`).join('\n')}${openIssues.length > 12 ? '\n• …' : ''}` : 'Referenced Jira items\n• I no longer have those issues in the current Assistant context.', issueKeys: openIssues.map((issue) => issue.key) };
    case 'REMAINING_WORK':
      return { text: openIssues.length ? `Remaining work\n• ${openIssues.length} item(s) remain open\n• ${n(report.metrics.remainingStoryPoints)} ${display.short} remain\n\nTop open items\n${openIssues.slice(0, mode === 'high' ? 12 : 8).map((issue) => `• ${issue.key} — ${issue.summary}`).join('\n')}${openIssues.length > (mode === 'high' ? 12 : 8) ? '\n• …' : ''}` : 'Remaining work\n• No incomplete work remains in this sprint.', issueKeys: openIssues.map((issue) => issue.key) };
    case 'SCOPE_CHANGES': {
      if (!history?.available) return { text: 'Scope movement\n• Sprint history is not available for this sprint.', issueKeys: [] };
      return { text: `Scope movement\n• Sprint-start commitment: ${n(history.originalCommitment?.storyPoints ?? 0)} ${display.short}\n• Current scope: ${n(history.currentScope?.storyPoints ?? 0)} ${display.short}\n• Added: ${n(history.scopeChange?.addedStoryPoints ?? 0)} ${display.short}\n• Removed: ${n(history.scopeChange?.removedStoryPoints ?? 0)} ${display.short}\n• Added items: ${n(history.scopeChange?.addedItems ?? 0)}\n• Removed items: ${n(history.scopeChange?.removedItems ?? 0)}`, issueKeys: [...(history.scopeChange?.addedIssueKeys ?? []), ...(history.scopeChange?.removedIssueKeys ?? [])] };
    }
    case 'ESTIMATES': {
      const estimation = boardConfiguration?.estimation ?? report?.estimationSource;
      const source = estimation?.fieldName || estimation?.name || (estimation?.type === 'issueCount' ? 'Issue count' : 'not configured');
      return { text: `Estimate position\n• Estimation source: ${source}\n• Original Estimate: ${hours(report.metrics.effort?.originalEstimateHours ?? 0)}\n• Time Spent: ${hours(report.metrics.effort?.timeSpentHours ?? 0)}\n• Remaining Estimate: ${hours(report.metrics.effort?.remainingEstimateHours ?? 0)}\n• Forecast: ${hours(report.metrics.effort?.forecastHours ?? 0)}\n• Remaining Estimate coverage: ${pct(report.metrics.effort?.coverage?.remainingEstimateCoveragePercentage ?? 0)}\n• Forecast status: ${report.metrics.effort?.forecastProvisional ? 'Provisional' : 'Supported by configured coverage threshold'}`, issueKeys: [] };
    }
    case 'VELOCITY': {
      const rows = (velocityReport?.velocity ?? []).slice(-5).map((item) => ({
        sprintId: item.sprintId,
        sprintName: item.sprintName,
        committed: Number(velocityReport?.usesStoryPoints ? item.committedStoryPoints : item.totalItems) || 0,
        completed: Number(velocityReport?.usesStoryPoints ? item.completedStoryPoints : item.completedItems) || 0,
      }));
      return {
        text: `Velocity\n• Recent average completed: ${n(velocityReport?.averageCompleted ?? 0)} ${display.short}`,
        issueKeys: [],
        visual: rows.length ? { type: 'velocity', rows, averageCompleted: Number(velocityReport?.averageCompleted ?? 0) || 0, unit: display.short } : null,
      };
    }
    case 'RETURN_TO_GREEN':
      return { text: returnToGreen.length ? `Return to Green\n${returnToGreen.map((item) => `• [${item.priority}] ${item.text}`).join('\n')}` : 'Return to Green\n• No immediate return-to-green action is required from the available data.', issueKeys: overdueIssues.map((issue) => issue.key) };
    case 'SPRINT_SUMMARY':
    default:
      return { text: `Sprint summary\n• Completion: ${report.metrics.storyPointCompletionPercentage}%\n• Delivered: ${n(report.metrics.completedStoryPoints)} of ${n(report.metrics.committedStoryPoints)} ${display.short}\n• Open items: ${report.metrics.open}\n• Overdue: ${report.metrics.overdue}\n• Delivery health: ${readiness?.score ?? 0}%${report.sprint.goal ? `\n• Sprint goal: ${report.sprint.goal}` : ''}`, issueKeys: openIssues.map((issue) => issue.key) };
  }
}
