import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import PptxGenJS from 'pptxgenjs';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { invoke, requestConfluence, requestJira, router, view } from '@forge/bridge';
import './App.css';
import { normalizeAssistantInput, normaliseLookup as normaliseAssistantLookup } from './assistant/normalize.mjs';
import { classifySmallTalk, buildSmallTalkResponse } from './assistant/smallTalk.mjs';
import { resolveConversationalReferences, getAssistantSprintReferences, getAssistantTemporalRequest } from './assistant/contextResolver.mjs';
import { buildAssistantProjectCatalogue, resolveAssistantProject } from './assistant/entityResolver.mjs';
import { ASSISTANT_MODES, resolveAssistantIntent, getAssistantAnalysisPlan } from './assistant/intentResolver.mjs';
import { assistantFollowUps, assistantCommandAction } from './assistant/actions.mjs';
import { buildAssistantAnswer, buildCarryOverAnswer, buildUnsupportedAgileAnswer } from './assistant/responseBuilder.mjs';
const STATUSDECK_UI_BUILD = 'v4.4.4-complete-label-titlecase-fix';
console.info('StatusDeck UI build', STATUSDECK_UI_BUILD);

const UI_TITLE_SMALL_WORDS = new Set([
  'and', 'or', 'of', 'to', 'by', 'in', 'for', 'with', 'from',
  'at', 'a', 'an', 'the', 'vs', 'vs.'
]);

function titleCaseUiLabel(value) {
  return String(value ?? '')
    .split(/(\s+)/)
    .map((token, index, all) => {
      if (/^\s+$/.test(token) || !token) return token;
      if (/^[A-Z0-9/&+-]+$/.test(token)) return token;

      const lower = token.toLowerCase();
      const wordIndex = all
        .slice(0, index)
        .filter((item) => item && !/^\s+$/.test(item))
        .length;

      if (wordIndex > 0 && UI_TITLE_SMALL_WORDS.has(lower)) return lower;
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join('');
}


class StatusDeckErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('StatusDeck render error', error, info); }
  render() {
    if (this.state.error) {
      const message = String(this.state.error?.message ?? this.state.error ?? 'Unknown rendering error');
      return (
        <main className="page-shell statusdeck-fatal-error-shell">
          <section className="statusdeck-fatal-error-card" role="alert">
            <p className="eyebrow">StatusDeck Recovery</p>
            <h1>StatusDeck Could Not Render This View</h1>
            <p>The report has been protected from a blank page. Reload StatusDeck to restore the last stable view.</p>
            <pre className="statusdeck-fatal-error-message">{message}</pre>
            <button type="button" className="primary-button" onClick={() => window.location.reload()}>Reload StatusDeck</button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}

function formatDate(value) {
  if (!value) {
    return 'Not Available';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

function formatShortDate(value, includeTime = false) {
  if (!value) {
    return '';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    ...(includeTime
      ? {
          hour: '2-digit',
          minute: '2-digit',
        }
      : {}),
  }).format(date);
}

function formatNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Number.isInteger(number)
    ? number
    : Math.round(number * 100) / 100;
}

function formatHours(value) {
  const hours = Number(value);

  if (!Number.isFinite(hours)) {
    return '0h';
  }

  return `${formatNumber(hours)}h`;
}

async function openJiraIssue(issueKey) {
  if (!issueKey) {
    return;
  }

  await router.open(`/browse/${issueKey}`);
}

async function openJiraIssues(issueKeys) {
  const validKeys = [...new Set(issueKeys ?? [])].filter(Boolean);

  if (validKeys.length === 0) {
    return;
  }

  if (validKeys.length === 1) {
    await openJiraIssue(validKeys[0]);
    return;
  }

  const jql = `key in (${validKeys.join(',')})`;

  await router.open(
    `/issues/?jql=${encodeURIComponent(jql)}`
  );
}

async function openSprintBoard(projectKey, boardId) {
  if (!projectKey || !boardId) {
    return;
  }

  await router.open(
    `/jira/software/c/projects/${projectKey}/boards/${boardId}`
  );
}


const FILTER_DEFAULTS = {
  assignee: 'all',
  status: 'all',
  priority: 'all',
  issueType: 'all',
  onlyOverdue: false,
  onlyDefects: false,
  onlyUnassigned: false,
};


const OVERVIEW_CARD_ORDER_DEFAULT = [
  'management-commentary',
  'sprint-health-core',
  'risk-profile',
  'scope-health',
  'work-distribution',
  'capacity-view',
  'velocity-summary',
  'return-to-green',
];

const OVERVIEW_FULL_WIDTH_CARD_IDS = new Set([
  'management-commentary',
  'sprint-health-core',
]);

const DEFAULT_REPORTING_SETTINGS = {
  version: 1,
  estimationOverride: '',
  rag: {
    greenCompletion: 85,
    amberCompletion: 65,
    amberOpenDefects: 1,
    redOpenDefects: 4,
    amberOverdue: 1,
    redOverdue: 4,
    minimumRemainingEstimateCoverage: 80,
  },
  readiness: {
    requireEstimate: true,
    requireAssignee: true,
    requireSprintGoal: true,
    requireDueDate: false,
    maximumVelocityLoad: 115,
    minimumAcceptanceCriteriaCoverage: 80,
    acceptanceCriteriaFieldId: '',
  },
  accessibility: {
    showStatusText: true,
    usePatternsWithColour: true,
  },
  kpiProfile: {
    native: { completion: true, completed: true, remaining: true, overdue: true, defects: true, velocity: true, workload: true, acceptanceCriteria: true, daysRemaining: true },
    custom: [],
  },
};

function mergeReportingSettings(value) {
  return {
    ...DEFAULT_REPORTING_SETTINGS,
    ...(value ?? {}),
    rag: { ...DEFAULT_REPORTING_SETTINGS.rag, ...(value?.rag ?? {}) },
    readiness: { ...DEFAULT_REPORTING_SETTINGS.readiness, ...(value?.readiness ?? {}) },
    accessibility: { ...DEFAULT_REPORTING_SETTINGS.accessibility, ...(value?.accessibility ?? {}) },
    kpiProfile: {
      native: { ...DEFAULT_REPORTING_SETTINGS.kpiProfile.native, ...(value?.kpiProfile?.native ?? {}) },
      custom: Array.isArray(value?.kpiProfile?.custom) ? value.kpiProfile.custom.slice(0, 12) : [],
    },
  };
}

function validateReportingSettings(settings) {
  const value = mergeReportingSettings(settings);
  const errors = [];

  if (value.rag.greenCompletion < 0 || value.rag.greenCompletion > 100 || value.rag.amberCompletion < 0 || value.rag.amberCompletion > 100) {
    errors.push('Green and Amber completion thresholds must be between 0 and 100%.');
  }
  if (value.rag.amberCompletion > value.rag.greenCompletion) {
    errors.push('Amber completion must be less than or equal to Green completion.');
  }
  if (value.rag.amberOpenDefects < 0 || value.rag.redOpenDefects < 0) {
    errors.push('Unresolved-defect thresholds cannot be negative.');
  }
  if (value.rag.amberOverdue < 0 || value.rag.redOverdue < 0) {
    errors.push('Overdue-item thresholds cannot be negative.');
  }
  if (value.rag.amberOpenDefects > value.rag.redOpenDefects) {
    errors.push('Amber unresolved defects must be less than or equal to Red unresolved defects.');
  }
  if (value.rag.amberOverdue > value.rag.redOverdue) {
    errors.push('Amber overdue items must be less than or equal to Red overdue items.');
  }
  if (value.rag.minimumRemainingEstimateCoverage < 0 || value.rag.minimumRemainingEstimateCoverage > 100) {
    errors.push('Minimum Remaining Estimate coverage must be between 0 and 100%.');
  }
  if (value.readiness.maximumVelocityLoad < 25 || value.readiness.maximumVelocityLoad > 300) {
    errors.push('Maximum next-sprint velocity load must be between 25 and 300%.');
  }
  if (value.readiness.minimumAcceptanceCriteriaCoverage < 0 || value.readiness.minimumAcceptanceCriteriaCoverage > 100) {
    errors.push('Minimum Acceptance Criteria coverage must be between 0 and 100%.');
  }

  return errors;
}

function getCalculationHelp(key, context = {}) {
  const { report, effort, readiness, settings, projectView, team } = context;

  if (projectView) {
    const teamNames = projectView.teams.map((item) => item.board?.name ?? 'Team');
    const teamCompletionValues = projectView.teams.map((item) => Number(item.completion ?? 0));
    const teamOverdueValues = projectView.teams.map((item) => Number(item.overdue ?? 0));
    const teamDefectValues = projectView.teams.map((item) => Number(item.unresolvedDefects ?? 0));
    const teamBlockedValues = projectView.teams.map((item) => Number(item.blocked ?? 0));
    const breakdown = (values, suffix = '') => values.map((value, index) => `${teamNames[index]} ${formatNumber(value)}${suffix}`).join(' · ');

    const projectExplanations = {
      projectOverallRag: {
        title: 'Overall Project RAG',
        formula: `Worst current team RAG across included boards = ${projectView.rag?.label ?? '—'}. Team RAGs: ${projectView.teams.map((item) => `${item.board?.name ?? 'Team'} ${item.rag?.label ?? '—'}`).join(' · ')}`,
        note: `Each team is evaluated independently using the configured StatusDeck thresholds (Green completion ≥ ${settings?.rag?.greenCompletion ?? 85}%, Amber completion ≥ ${settings?.rag?.amberCompletion ?? 65}%, plus overdue, defect and Remaining Estimate coverage rules). The project RAG is the most severe current team state.`,
      },
      projectMeanCompletion: {
        title: 'Mean Team Completion',
        formula: teamCompletionValues.length ? `(${teamCompletionValues.join(' + ')}) ÷ ${teamCompletionValues.length} = ${formatNumber(teamCompletionValues.reduce((sum, value) => sum + value, 0) / teamCompletionValues.length)}% → displayed ${projectView.meanCompletion}%` : 'No included team completion values are available.',
        note: `Simple mean of each included board's current reporting-sprint completion. ${breakdown(teamCompletionValues, '%')}. StatusDeck does not sum unlike estimation units into a project velocity.`,
      },
      projectTeamsOnTrack: {
        title: 'Teams on Track',
        formula: `${projectView.teamsOnTrack} Green team${projectView.teamsOnTrack === 1 ? '' : 's'} ÷ ${projectView.teams.length} included team${projectView.teams.length === 1 ? '' : 's'}.`,
        note: projectView.teams.filter((item) => item.rag?.label === 'GREEN').length ? `Green: ${projectView.teams.filter((item) => item.rag?.label === 'GREEN').map((item) => item.board?.name).join(', ')}.` : 'No included team currently satisfies all configured Green conditions.',
      },
      projectTeamsAtRisk: {
        title: 'Teams at Risk',
        formula: `${projectView.rag?.counts?.RED ?? 0} Red + ${projectView.rag?.counts?.AMBER ?? 0} Amber = ${projectView.teamsAtRisk} teams requiring follow-up.`,
        note: projectView.teams.filter((item) => item.rag?.label !== 'GREEN').map((item) => `${item.board?.name}: ${item.rag?.label}`).join(' · ') || 'No included team is currently at risk.',
      },
      projectOverdue: {
        title: 'Project Overdue Work',
        formula: `${teamOverdueValues.join(' + ')} = ${projectView.overdue} overdue open item${projectView.overdue === 1 ? '' : 's'}.`,
        note: `Per team: ${breakdown(teamOverdueValues)}. Counts open items whose Jira due date has passed in each included reporting sprint.`,
      },
      projectDefects: {
        title: 'Project Unresolved Defects',
        formula: `${teamDefectValues.join(' + ')} = ${projectView.unresolvedDefects} unresolved defect${projectView.unresolvedDefects === 1 ? '' : 's'}.`,
        note: `Per team: ${breakdown(teamDefectValues)}. Uses open Bug/Defect-classified work items in the included reporting-sprint scope.`,
      },
      projectBlocked: {
        title: 'Project Blocked / Impeded Work',
        formula: `${teamBlockedValues.join(' + ')} = ${projectView.blocked} blocked / impeded open item${projectView.blocked === 1 ? '' : 's'}.`,
        note: `Per team: ${breakdown(teamBlockedValues)}. StatusDeck detects open statuses whose names indicate blocked, impediment or waiting states.`,
      },
      projectStatusDistribution: {
        title: 'Project Status Distribution',
        formula: `Counts are summed by Jira status across the current reporting sprint of each included board. Total = ${Object.values(projectView.statusCounts ?? {}).reduce((sum, count) => sum + Number(count ?? 0), 0)} work items.`,
        note: Object.entries(projectView.statusCounts ?? {}).sort((a, b) => Number(b[1]) - Number(a[1])).map(([status, count]) => `${status}: ${count}`).join(' · ') || 'No status data is available.',
      },
      projectWorkload: {
        title: 'Project Open Workload',
        formula: 'Open work is grouped by Jira assignee across the current reporting sprint of each included board, then summed by assignee.',
        note: projectView.workload?.length ? projectView.workload.slice(0, 8).map((person) => `${person.name}: ${person.open} open${person.overdue ? ` (${person.overdue} overdue)` : ''}`).join(' · ') : 'No assignee workload data is available. This is a workload signal, not an individual productivity score.',
      },
      projectScopeGrowth: {
        title: 'Teams with Scope Growth',
        formula: `${projectView.scopeIncreasedTeams} team${projectView.scopeIncreasedTeams === 1 ? '' : 's'} have a reliable sprint-start baseline and a positive item-count scope delta.`,
        note: projectView.scopeBaselineUnavailableTeams ? `${projectView.scopeBaselineUnavailableTeams} team${projectView.scopeBaselineUnavailableTeams === 1 ? ' has' : 's have'} no reliable sprint-start item baseline, so StatusDeck omits scope-growth claims for those teams.` : 'All included teams have a usable sprint-start item baseline.',
      },
    };
    if (projectExplanations[key]) return projectExplanations[key];
  }

  if (team) {
    const metrics = team.report?.metrics ?? {};
    const estimationUnit = team.report?.estimationSource?.unit || 'points';
    const currentScope = Number(metrics.committedStoryPoints ?? 0);
    const completed = Number(metrics.completedStoryPoints ?? 0);
    const teamExplanations = {
      projectTeamCompletion: {
        title: `${team.board?.name ?? 'Team'} completion`,
        formula: currentScope > 0 ? `${formatNumber(completed)} completed ${estimationUnit} ÷ ${formatNumber(currentScope)} current-scope ${estimationUnit} × 100 = ${formatNumber((completed / currentScope) * 100)}% → displayed ${team.completion}%` : `${metrics.completed ?? 0} completed work items out of ${metrics.total ?? 0} current items.`,
        note: 'Uses the board/report estimation source for that team. Team completion is evaluated independently rather than merged into a cross-team velocity.',
      },
      projectTeamOverdue: {
        title: `${team.board?.name ?? 'Team'} overdue work`,
        formula: `${team.overdue} open item${team.overdue === 1 ? '' : 's'} with a Jira due date earlier than today.`,
        note: 'Completed items are excluded from the overdue count.',
      },
      projectTeamDefects: {
        title: `${team.board?.name ?? 'Team'} unresolved defects`,
        formula: `${team.unresolvedDefects} open Bug/Defect-classified item${team.unresolvedDefects === 1 ? '' : 's'} in the reporting-sprint scope.`,
        note: 'Done/resolved defects are not counted as unresolved.',
      },
      projectTeamScope: {
        title: `${team.board?.name ?? 'Team'} scope movement`,
        formula: team.hasScopeBaseline ? `${formatNumber(team.originalItems)} sprint-start items → ${formatNumber(team.currentItems)} current items = ${team.scopeDeltaItems > 0 ? '+' : ''}${formatNumber(team.scopeDeltaItems)} item change (${team.scopeDeltaPercentage > 0 ? '+' : ''}${formatNumber(team.scopeDeltaPercentage)}%).` : 'A reliable sprint-start item baseline is not available for this team.',
        note: team.hasScopeBaseline ? 'Item-count scope movement is calculated only when Jira history provides a usable sprint-start baseline.' : 'StatusDeck does not treat all current items as scope added when the sprint-start baseline is missing or zero.',
      },
    };
    if (teamExplanations[key]) return teamExplanations[key];
  }

  const explanations = {
    completion: {
      title: 'Story-Point Completion',
      formula: 'Completed story points ÷ current sprint story points × 100',
      note: 'Uses the board/report estimation source when story points are available. It is a delivery indicator, not an individual productivity measure.',
    },
    remaining: {
      title: 'Remaining Estimate',
      formula: 'Sum of Jira Remaining Estimate on the selected work items',
      note: 'StatusDeck does not silently replace Jira Remaining Estimate with Original Estimate − Time Spent. If coverage is incomplete, the forecast is labelled provisional.',
    },
    forecast: {
      title: 'Forecast Effort',
      formula: 'Time Spent + Remaining Estimate',
      note: 'When Remaining Estimate is missing on open work, the forecast is explicitly marked provisional.',
    },
    variance: {
      title: 'Effort Variance',
      formula: 'Forecast effort − Original Estimate',
      note: 'Positive means forecast effort is above the original estimate. Negative means below. A favourable variance is not treated as realised efficiency when estimate coverage is incomplete.',
    },
    health: {
      title: 'Delivery Health / RAG',
      formula: `Completion adjusted for overdue work, unresolved defects and estimate confidence. Green completion threshold: ${settings?.rag?.greenCompletion ?? 85}%.`,
      note: 'Thresholds are organizational reporting policy. StatusDeck keeps Scrum transparency intact: incomplete work remains incomplete and velocity remains a team planning signal.',
    },
    scopeCurrent: {
      title: 'Current Sprint Scope',
      formula: 'Original commitment + scope added − scope removed + estimate revisions = current scope',
      note: 'Reconstructed from Jira sprint and issue history. The current scope can differ from the sprint-start commitment when work is added, removed, or re-estimated.',
    },
    scopeEstimateChange: {
      title: 'Estimate Change',
      formula: 'Net story-point estimate revisions recorded during the sprint',
      note: 'This isolates estimate changes on work that remained in scope; it is separate from points added to or removed from the sprint.',
    },
    originalCoverage: {
      title: 'Original Estimate Coverage',
      formula: 'Items with Original Estimate ÷ report-scope items × 100',
      note: 'Coverage indicates how complete the Jira effort data is. It is not a delivery-performance score.',
    },
    remainingCoverage: {
      title: 'Remaining Estimate Coverage',
      formula: 'Eligible open items with Remaining Estimate ÷ eligible open items × 100',
      note: 'Low coverage makes forecast effort provisional because Jira Remaining Estimate is missing on open work.',
    },
    spentCoverage: {
      title: 'Time Spent Coverage',
      formula: 'Items with Time Spent data ÷ report-scope items × 100',
      note: 'Coverage shows whether logged effort is sufficiently populated for effort reporting.',
    },
    velocity: {
      title: 'Velocity',
      formula: 'Average completed story points across recent closed sprints',
      note: 'Velocity is shown as an empirical team planning signal. It is not converted into individual performance.',
    },
    acceptanceCriteriaCoverage: {
      title: 'Acceptance Criteria Coverage',
      formula: report?.metrics?.acceptanceCriteria?.eligibleStories > 0
        ? `${report.metrics.acceptanceCriteria.detectedStories} Stories with at least one identifiable Acceptance Criterion ÷ ${report.metrics.acceptanceCriteria.eligibleStories} Stories × 100 = ${formatNumber(report.metrics.acceptanceCriteria.coveragePercentage)}%.`
        : 'No Story issues are available in this sprint for Acceptance Criteria assessment.',
      note: report?.metrics?.acceptanceCriteria?.eligibleStories > 0
        ? `Detection is deterministic: StatusDeck inspects Story descriptions for an Acceptance Criteria/AC section or Given-When-Then structure. ${report.metrics.acceptanceCriteria.totalCriteria ?? 0} individual criterion/criteria were identified. ${report.metrics.acceptanceCriteria.noDescriptionStories ?? 0} Story(s) have no Description, ${report.metrics.acceptanceCriteria.emptyCriteriaStories ?? 0} contain an AC heading with no identifiable criterion, and ${report.metrics.acceptanceCriteria.notDetectedStories ?? 0} have Description content but no identifiable AC pattern.`
        : 'Epics and non-Story issue types are not counted in this Story-level readiness percentage.',
    },
    acceptanceCriteriaCompletion: {
      title: 'Acceptance Criteria Completion',
      formula: report?.metrics?.acceptanceCriteria?.trackableCriteria > 0
        ? `${report.metrics.acceptanceCriteria.metCriteria} explicitly completed criteria ÷ ${report.metrics.acceptanceCriteria.trackableCriteria} criteria with an explicit checkbox/task state × 100 = ${formatNumber(report.metrics.acceptanceCriteria.completionPercentage)}%.`
        : 'No Acceptance Criteria in this sprint have an explicit Jira checkbox/task completion state, so a completion percentage is not calculated.',
      note: report?.metrics?.acceptanceCriteria
        ? `${report.metrics.acceptanceCriteria.totalCriteria ?? 0} criteria identified: ${report.metrics.acceptanceCriteria.metCriteria ?? 0} Met, ${report.metrics.acceptanceCriteria.notMetCriteria ?? 0} Not met, and ${report.metrics.acceptanceCriteria.unrecordedCriteria ?? 0} with completion status not recorded. Plain-text criteria are never inferred as Met or Not met.`
        : 'StatusDeck only classifies Met/Not met when Jira explicitly records a checkbox/task state.',
    },
    planningReadiness: {
      title: 'Future Sprint Planning Readiness',
      formula: `Starts at 100 and applies bounded deductions for unassigned items, unestimated items, missing Sprint Goal, overdue work, weak estimate coverage, velocity-load imbalance and Story Acceptance Criteria coverage below ${settings?.readiness?.minimumAcceptanceCriteriaCoverage ?? 80}%.`,
      note: 'This is a deterministic planning-readiness signal based on Jira data. It does not claim that detected Acceptance Criteria are semantically complete or correct.',
    },
  };
  return explanations[key] ?? null;
}

function CalculationButton({ calculationKey, context }) {
  const help = getCalculationHelp(calculationKey, context);
  const [position, setPosition] = useState(null);

  if (!help) return null;

  const nativeTooltip = `${help.title}\n${help.formula}\n${help.note}`;

  function showTooltip(event) {
    const trigger = event?.currentTarget;
    if (!trigger || typeof trigger.getBoundingClientRect !== 'function') return;

    const rect = trigger.getBoundingClientRect();
    const tooltipWidth = Math.min(380, Math.max(280, window.innerWidth - 24));
    const estimatedHeight = 170;
    const preferredLeft = rect.left + rect.width / 2 - tooltipWidth / 2;
    const left = Math.max(12, Math.min(preferredLeft, window.innerWidth - tooltipWidth - 12));
    const belowTop = rect.bottom + 8;
    const top = belowTop + estimatedHeight <= window.innerHeight - 12
      ? belowTop
      : Math.max(12, rect.top - estimatedHeight - 8);

    setPosition({ top, left, width: tooltipWidth });
  }

  function hideTooltip() {
    setPosition(null);
  }

  function toggleTooltip(event) {
    event.preventDefault();
    event.stopPropagation();
    if (position) {
      hideTooltip();
      return;
    }
    showTooltip(event);
  }

  return (
    <span className="calculation-help-wrap no-export">
      <button
        type="button"
        className="calculation-help-button"
        aria-label={`Calculation details for ${help.title}`}
        title={nativeTooltip}
        onPointerEnter={showTooltip}
        onPointerLeave={hideTooltip}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        onClick={toggleTooltip}
        onKeyDown={(event) => {
          if (event.key === 'Escape') hideTooltip();
        }}
      >
        ⓘ
      </button>
      {position
        ? createPortal(
            <div
              className="calculation-popover calculation-popover-portal"
              role="tooltip"
              style={{ top: position.top, left: position.left, width: position.width }}
            >
              <strong>{help.title}</strong>
              <span>{help.formula}</span>
              <small>{help.note}</small>
            </div>,
            document.body
          )
        : null}
    </span>
  );
}


function buildReturnToGreen({ report, displayedIssues, readiness, settings }) {
  if (!report) return [];
  const now = Date.now();
  const actions = [];
  const openIssues = (displayedIssues ?? []).filter((issue) => issue.statusCategoryKey !== 'done');
  const overdue = openIssues.filter((issue) => issue.dueDate && new Date(issue.dueDate).getTime() < now);
  const defects = openIssues.filter(isDefectIssue);
  const missingRemaining = openIssues.filter((issue) => Number(issue.remainingEstimateHours ?? 0) <= 0);
  const unassigned = openIssues.filter((issue) => !issue.assignee || issue.assignee === 'Unassigned');

  if (overdue.length > 0) {
    const oldestDays = Math.max(...overdue.map((issue) => Math.max(1, Math.floor((now - new Date(issue.dueDate).getTime()) / (24 * 60 * 60 * 1000)))));
    actions.push({
      priority: overdue.length >= Number(settings?.rag?.redOverdue ?? 4) || oldestDays >= 7 ? 'Critical' : 'High',
      text: `${overdue.length} overdue open item${overdue.length === 1 ? '' : 's'} need a single recovery review: confirm ownership, realistic recovery dates, and whether each item still belongs in the sprint scope.`,
    });
  }

  if (defects.length >= Number(settings?.rag?.amberOpenDefects ?? 1)) {
    actions.push({
      priority: defects.length >= Number(settings?.rag?.redOpenDefects ?? 4) ? 'Critical' : 'High',
      text: `${defects.length} unresolved defect${defects.length === 1 ? '' : 's'} remain in open work. Agree severity-based disposition and release acceptance before treating delivery as recovered.`,
    });
  }

  if (missingRemaining.length > 0) {
    actions.push({
      priority: 'High',
      text: `Remaining Estimate is missing or zero on ${missingRemaining.length} open item${missingRemaining.length === 1 ? '' : 's'}. Update the estimates before relying on forecast effort or favourable variance.`,
    });
  }

  if (unassigned.length > 0) {
    actions.push({
      priority: 'Medium',
      text: `${unassigned.length} open item${unassigned.length === 1 ? '' : 's'} lack clear ownership. Assign accountable owners before the next delivery checkpoint.`,
    });
  }

  if ((readiness?.score ?? 100) < Number(settings?.rag?.amberCompletion ?? 65)) {
    actions.push({
      priority: 'High',
      text: 'Delivery health is below the configured recovery threshold. Reconfirm the Sprint Goal and re-plan work that cannot credibly be completed within the remaining timebox.',
    });
  }

  return actions.slice(0, 4);
}

function deriveAssistantReadiness(report, settings = DEFAULT_REPORTING_SETTINGS) {
  if (!report) return { score: 0, label: 'Not Calculated', openDefects: 0 };
  const rag = settings?.rag ?? DEFAULT_REPORTING_SETTINGS.rag;
  const issues = report?.metrics?.reportingIssues ?? [];
  const openDefects = issues.filter((issue) => issue.statusCategoryKey !== 'done' && isDefectIssue(issue)).length;
  const completion = Number(report?.metrics?.storyPointCompletionPercentage ?? 0);
  const overduePenalty = Math.min(15, Number(report?.metrics?.overdue ?? 0) * 5);
  const openDefectPenalty = Math.min(12, openDefects * 2);
  const remainingCoverage = Number(report?.metrics?.effort?.coverage?.remainingEstimateCoveragePercentage ?? 100);
  const estimateConfidencePenalty = report?.metrics?.effort?.forecastProvisional
    ? Math.min(8, Math.round((100 - remainingCoverage) / 12.5))
    : 0;
  const score = Math.max(0, Math.min(100, Math.round(completion - overduePenalty - openDefectPenalty - estimateConfidencePenalty)));
  return {
    score,
    openDefects,
    label: score >= Number(rag.greenCompletion ?? 85)
      ? 'Strong Outcome'
      : score >= Number(rag.amberCompletion ?? 65)
        ? 'Delivered With Concerns'
        : score >= 50
          ? 'Needs Follow-Up'
          : 'Needs Attention',
  };
}

function getOverallRag({ report, readiness, settings = DEFAULT_REPORTING_SETTINGS }) {
  if (!report) return { label: 'NOT SET', tone: 'neutral', detail: 'Load sprint data to calculate RAG.' };
  const rag = settings?.rag ?? DEFAULT_REPORTING_SETTINGS.rag;
  const overdue = Number(report?.metrics?.overdue ?? 0);
  const unresolvedDefects = Number(readiness?.openDefects ?? 0);
  const score = Number(readiness?.score ?? report?.metrics?.storyPointCompletionPercentage ?? 0);
  const provisional = Boolean(report?.metrics?.effort?.forecastProvisional);

  if (
    overdue >= Number(rag.redOverdue ?? 4) ||
    unresolvedDefects >= Number(rag.redOpenDefects ?? 4) ||
    score < Number(rag.amberCompletion ?? 65)
  ) {
    return { label: 'RED', tone: 'negative', detail: 'Immediate management attention required.' };
  }

  if (
    overdue >= Number(rag.amberOverdue ?? 1) ||
    unresolvedDefects >= Number(rag.amberOpenDefects ?? 1) ||
    score < Number(rag.greenCompletion ?? 85) ||
    provisional
  ) {
    return { label: 'AMBER', tone: 'warning', detail: 'Delivery has concerns that require follow-up.' };
  }

  return { label: 'GREEN', tone: 'positive', detail: 'Delivery is within configured reporting thresholds.' };
}

function getAssistantVisualTone(text) {
  const value = String(text ?? '').toLowerCase();
  if (/\b(red|critical|blocked|overdue|unresolved|defect|risk|needs attention)\b/.test(value)) return 'danger';
  if (/\b(amber|warning|watch|provisional|concern|follow-up|remaining)\b/.test(value)) return 'warning';
  if (/\b(green|healthy|complete|completed|return to green|recommended actions|recovered)\b/.test(value)) return 'success';
  return 'info';
}

function renderAssistantListItem(item, index) {
  const tone = getAssistantVisualTone(item);
  const pair = String(item ?? '').match(/^([^:]{2,34}):\s*(.+)$/);
  if (pair) {
    return (
      <li key={`${index}-${item}`} className={`assistant-answer-list-item assistant-answer-list-item-${tone}`}>
        <span className="assistant-answer-list-label">{pair[1]}:</span> <strong>{pair[2]}</strong>
      </li>
    );
  }
  return <li key={`${index}-${item}`} className={`assistant-answer-list-item assistant-answer-list-item-${tone}`}>{item}</li>;
}

function renderAssistantMessageText(value) {
  const lines = String(value ?? '').split(/\r?\n/);
  const nodes = [];
  let bulletItems = [];
  let orderedItems = [];

  const flushLists = () => {
    if (bulletItems.length) {
      nodes.push(<ul key={`ul-${nodes.length}`} className="assistant-answer-list">{bulletItems.map(renderAssistantListItem)}</ul>);
      bulletItems = [];
    }
    if (orderedItems.length) {
      nodes.push(<ol key={`ol-${nodes.length}`} className="assistant-answer-list">{orderedItems.map(renderAssistantListItem)}</ol>);
      orderedItems = [];
    }
  };

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) { flushLists(); return; }
    const bullet = line.match(/^•\s+(.+)$/);
    if (bullet) { orderedItems = []; bulletItems.push(bullet[1]); return; }
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) { bulletItems = []; orderedItems.push(ordered[1]); return; }
    flushLists();

    const rag = line.match(/^Overall RAG:\s*(RED|AMBER|GREEN)\b(?:\s*[—-]\s*(.*))?$/i);
    if (rag) {
      const ragClass = rag[1].toLowerCase();
      nodes.push(
        <div key={`rag-${index}`} className={`assistant-rag-callout assistant-rag-${ragClass}`}>
          <span>Overall RAG</span><strong>{rag[1].toUpperCase()}</strong>{rag[2] ? <small>{rag[2]}</small> : null}
        </div>
      );
      return;
    }

    if (index === 0 && /\([A-Z0-9._-]+\)\s*$/.test(line)) {
      nodes.push(<div key={`ctx-${index}`} className="assistant-project-context-chip">{line}</div>);
      return;
    }

    if (/^#{1,3}\s+/.test(line)) {
      const heading = line.replace(/^#{1,3}\s+/, '');
      const tone = getAssistantVisualTone(heading);
      nodes.push(<strong key={`h-${index}`} className={`assistant-answer-heading assistant-answer-heading-${tone}`}>{heading}</strong>);
      return;
    }
    const nextLine = String(lines[index + 1] ?? '').trim();
    if ((nextLine.startsWith('• ') || /^\d+[.)]\s+/.test(nextLine)) && line.length < 80) {
      const tone = getAssistantVisualTone(line);
      nodes.push(<strong key={`h-${index}`} className={`assistant-answer-heading assistant-answer-heading-${tone}`}>{line}</strong>);
      return;
    }
    nodes.push(<p key={`p-${index}`} className="assistant-answer-paragraph">{line}</p>);
  });
  flushLists();
  return <div className="assistant-structured-answer">{nodes}</div>;
}

function renderAssistantVisual(visual) {
  if (!visual || visual.type !== 'velocity' || !Array.isArray(visual.rows) || visual.rows.length === 0) return null;
  const maximum = Math.max(1, ...visual.rows.flatMap((row) => [Number(row.committed ?? 0), Number(row.completed ?? 0)]));
  return (
    <div className="assistant-mini-velocity" aria-label="Velocity trend">
      <div className="assistant-mini-chart-heading">
        <span>Recent Delivery Trend</span>
        <strong>Avg {formatNumber(visual.averageCompleted ?? 0)} {visual.unit || ''}</strong>
      </div>
      <div className="assistant-mini-velocity-rows">
        {visual.rows.map((row) => {
          const committed = Number(row.committed ?? 0);
          const completed = Number(row.completed ?? 0);
          return (
            <div className="assistant-mini-velocity-row" key={`assistant-velocity-${row.sprintId || row.sprintName}`}>
              <span className="assistant-mini-velocity-name">{row.sprintName}</span>
              <div className="assistant-mini-velocity-bars">
                <div className="assistant-mini-velocity-line"><span>C</span><div><i className="assistant-mini-bar-committed" style={{ width: `${Math.round((committed / maximum) * 100)}%` }} /></div><strong>{formatNumber(committed)}</strong></div>
                <div className="assistant-mini-velocity-line"><span>D</span><div><i className="assistant-mini-bar-completed" style={{ width: `${Math.round((completed / maximum) * 100)}%` }} /></div><strong>{formatNumber(completed)}</strong></div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="assistant-mini-chart-legend"><span><i className="assistant-legend-committed" />Committed</span><span><i className="assistant-legend-completed" />Completed</span></div>
    </div>
  );
}

function findAssistantSprint(sprints, reference, currentSprintId = null) {
  const list = sprints ?? [];
  const ref = String(reference ?? '').trim().toLowerCase();
  const current = currentSprintId ? list.find((sprint) => String(sprint.id) === String(currentSprintId)) ?? null : null;
  if (!ref && current) return current;
  if (ref === 'context') return current;
  if (ref === 'active' || ref === 'current') return list.find((sprint) => sprint.state === 'active') ?? current ?? null;
  if (ref === 'previous' || ref === 'last') {
    const currentTime = current ? new Date(current.completeDate ?? current.endDate ?? current.startDate ?? Date.now()).getTime() : Number.POSITIVE_INFINITY;
    return list.filter((sprint) => sprint.state === 'closed' && String(sprint.id) !== String(currentSprintId) && new Date(sprint.completeDate ?? sprint.endDate ?? 0).getTime() < currentTime)
      .sort((a, b) => new Date(b.completeDate ?? b.endDate ?? 0) - new Date(a.completeDate ?? a.endDate ?? 0))[0]
      ?? list.filter((sprint) => sprint.state === 'closed' && String(sprint.id) !== String(currentSprintId)).sort((a, b) => new Date(b.completeDate ?? b.endDate ?? 0) - new Date(a.completeDate ?? a.endDate ?? 0))[0]
      ?? null;
  }
  if (ref === 'next') {
    const currentTime = current ? new Date(current.endDate ?? current.completeDate ?? current.startDate ?? 0).getTime() : 0;
    return list.filter((sprint) => String(sprint.id) !== String(currentSprintId) && new Date(sprint.startDate ?? sprint.endDate ?? 0).getTime() > currentTime)
      .sort((a, b) => new Date(a.startDate ?? a.endDate ?? 0) - new Date(b.startDate ?? b.endDate ?? 0))[0] ?? null;
  }
  return list.find((sprint) => {
    const name = String(sprint.name ?? '').toLowerCase();
    return name === ref || name.endsWith(`sprint ${ref}`) || name.includes(`sprint ${ref}`) || (ref && new RegExp(`\\b${ref.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`).test(name));
  }) ?? null;
}


function getAssistantFutureSprints(sprints, currentSprintId = null, limit = 5) {
  const list = [...(sprints ?? [])];
  const current = currentSprintId ? list.find((sprint) => String(sprint.id) === String(currentSprintId)) ?? null : null;
  const currentTime = current ? new Date(current.endDate ?? current.completeDate ?? current.startDate ?? 0).getTime() : 0;
  const future = list.filter((sprint) => {
    if (String(sprint.id) === String(currentSprintId)) return false;
    if (sprint.state === 'future') return true;
    if (sprint.state === 'active' && current?.state === 'closed') return true;
    const start = new Date(sprint.startDate ?? sprint.endDate ?? 0).getTime();
    return Boolean(currentTime && start > currentTime && sprint.state !== 'closed');
  }).sort((a, b) => new Date(a.startDate ?? a.endDate ?? 0) - new Date(b.startDate ?? b.endDate ?? 0));
  return future.slice(0, Math.max(1, Math.min(10, Number(limit) || 5)));
}

function escapeIcsText(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

function getTimeZoneParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  return Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function validateCalendarSchedule(schedule) {
  const errors = [];
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(schedule?.time ?? ''))) errors.push('Choose a valid time including minutes.');
  if (!['daily', 'weekly'].includes(schedule?.cadence)) errors.push('Choose Daily or Weekly cadence.');
  if (schedule?.cadence === 'weekly' && (Number(schedule?.dayOfWeek) < 0 || Number(schedule?.dayOfWeek) > 6)) errors.push('Choose a valid weekday.');
  const timeZone = String(schedule?.timeZone ?? '').trim();
  if (!timeZone) {
    errors.push('Enter a time zone such as Asia/Kolkata.');
  } else {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    } catch {
      errors.push(`Time zone “${timeZone}” is not valid.`);
    }
  }
  const reminder = Number(schedule?.reminderMinutes ?? 15);
  if (!Number.isFinite(reminder) || reminder < 0 || reminder > 1440) errors.push('Calendar reminder must be between 0 and 1440 minutes.');
  return errors;
}

function getNextScheduleOccurrence(schedule) {
  const timeZone = schedule?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const [hour, minute] = String(schedule?.time || '15:00').split(':').map(Number);
  const now = new Date();
  const nowParts = getTimeZoneParts(now, timeZone);
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const todayDow = weekdayMap[nowParts.weekday] ?? 0;
  const nowMinutes = Number(nowParts.hour) * 60 + Number(nowParts.minute);
  let addDays = 0;
  if (schedule?.cadence === 'weekly') {
    const targetDow = Number(schedule?.dayOfWeek ?? 1);
    addDays = (targetDow - todayDow + 7) % 7;
    if (addDays === 0 && hour * 60 + minute <= nowMinutes) addDays = 7;
  } else if (hour * 60 + minute <= nowMinutes) {
    addDays = 1;
  }
  const localBase = new Date(Date.UTC(Number(nowParts.year), Number(nowParts.month) - 1, Number(nowParts.day) + addDays, hour, minute, 0));
  const endBase = new Date(localBase.getTime() + 30 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, '0');
  const start = `${localBase.getUTCFullYear()}${pad(localBase.getUTCMonth() + 1)}${pad(localBase.getUTCDate())}T${pad(localBase.getUTCHours())}${pad(localBase.getUTCMinutes())}00`;
  const end = `${endBase.getUTCFullYear()}${pad(endBase.getUTCMonth() + 1)}${pad(endBase.getUTCDate())}T${pad(endBase.getUTCHours())}${pad(endBase.getUTCMinutes())}00`;
  const isoStart = `${localBase.getUTCFullYear()}-${pad(localBase.getUTCMonth() + 1)}-${pad(localBase.getUTCDate())}T${pad(localBase.getUTCHours())}:${pad(localBase.getUTCMinutes())}:00`;
  const isoEnd = `${endBase.getUTCFullYear()}-${pad(endBase.getUTCMonth() + 1)}-${pad(endBase.getUTCDate())}T${pad(endBase.getUTCHours())}:${pad(endBase.getUTCMinutes())}:00`;
  return { timeZone, start, end, isoStart, isoEnd };
}

function buildCalendarInvite(schedule, { projectName, boardName } = {}) {
  const occurrence = getNextScheduleOccurrence(schedule);
  const weekdayCodes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const recurrence = schedule?.cadence === 'daily'
    ? 'RRULE:FREQ=DAILY'
    : `RRULE:FREQ=WEEKLY;BYDAY=${weekdayCodes[Number(schedule?.dayOfWeek ?? 1)] || 'MO'}`;
  const title = `StatusDeck – ${projectName || 'Jira'} reporting review`;
  const description = `${schedule?.message || 'StatusDeck reporting is due. Please review the current sprint report.'}${boardName ? `\nBoard: ${boardName}` : ''}${projectName ? `\nProject: ${projectName}` : ''}`;
  const reminderMinutes = Math.max(0, Number(schedule?.reminderMinutes ?? 15));
  const uid = `statusdeck-${Date.now()}-${Math.random().toString(36).slice(2)}@qtilabs.com`;
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//QTI Labs//StatusDeck//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`,
    `DTSTART;TZID=${occurrence.timeZone}:${occurrence.start}`, `DTEND;TZID=${occurrence.timeZone}:${occurrence.end}`, recurrence,
    `SUMMARY:${escapeIcsText(title)}`, `DESCRIPTION:${escapeIcsText(description)}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeIcsText(title)}`, `TRIGGER:-PT${reminderMinutes}M`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
  return { ...occurrence, recurrence, title, description, ics };
}

function downloadCalendarInvite(schedule, context) {
  const calendar = buildCalendarInvite(schedule, context);
  const blob = new Blob([calendar.ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `StatusDeck_${String(context?.projectName || 'Report').replace(/[^a-z0-9_-]+/gi, '_')}_Reminder.ics`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const STATUSDECK_TIME_ZONES = [
  ['UTC', 'UTC'],
  ['Asia/Kolkata', 'Asia/Kolkata (India)'],
  ['Asia/Dubai', 'Asia/Dubai (UAE)'],
  ['Asia/Singapore', 'Asia/Singapore'],
  ['Europe/London', 'Europe/London'],
  ['America/New_York', 'America/New_York'],
  ['America/Chicago', 'America/Chicago'],
  ['America/Los_Angeles', 'America/Los_Angeles'],
  ['Australia/Sydney', 'Australia/Sydney'],
];

function getStatusDeckTimeZoneOptions(currentTimeZone) {
  const current = String(currentTimeZone || '').trim();
  const seen = new Set();
  const options = [];
  if (current) {
    options.push([current, `${current} (current)`]);
    seen.add(current);
  }
  STATUSDECK_TIME_ZONES.forEach(([value, label]) => {
    if (!seen.has(value)) {
      seen.add(value);
      options.push([value, label]);
    }
  });
  return options;
}

function extractConfluencePageId(value) {
  const text = String(value ?? '').trim();
  if (/^\d+$/.test(text)) return text;
  const fromPath = text.match(/\/pages\/(\d+)(?:\/|$|[?#])/i)?.[1];
  if (fromPath) return fromPath;
  // Confluence space overview URLs point at the space home page with homepageId,
  // while normal page URLs may use pageId. Both values are valid page IDs for
  // the v2 page API used by StatusDeck.
  const fromQuery = text.match(/[?&](?:pageId|homepageId)=(\d+)/i)?.[1];
  return fromQuery || '';
}


function normaliseConfluenceApiPath(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.startsWith('/wiki/')) return text;
  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      return `${url.pathname}${url.search}`;
    } catch {
      return '';
    }
  }
  return text.startsWith('/') ? text : `/${text}`;
}

async function fetchConfluenceCollection(initialPath, maxPages = 8) {
  const results = [];
  let path = normaliseConfluenceApiPath(initialPath);
  let pageCount = 0;
  while (path && pageCount < maxPages) {
    const response = await requestConfluence(path, { headers: { Accept: 'application/json' } });
    if (!response.ok) {
      const detail = await response.text();
      const error = new Error(`Confluence request failed (${response.status}). ${detail.slice(0, 180)}`);
      error.status = response.status;
      throw error;
    }
    const payload = await response.json();
    results.push(...(payload?.results ?? []));
    path = normaliseConfluenceApiPath(payload?._links?.next ?? '');
    pageCount += 1;
  }
  return results;
}

function getConfluenceSprintPageTitle(sprintName) {
  const text = String(sprintName ?? '').trim();
  const sprintMatch = text.match(/\bsprint\s*([a-z0-9._-]+)/i);
  return sprintMatch ? `Sprint ${sprintMatch[1]}` : (text || 'Sprint Report');
}

function chooseConfluenceSpaceForProject(spaces, project) {
  const list = spaces ?? [];
  if (!list.length) return null;
  if (!project) return list[0];
  const projectName = normaliseAssistantLookup(project.name);
  const projectKey = normaliseAssistantLookup(project.key);
  const exact = list.find((space) => normaliseAssistantLookup(space.name) === projectName || normaliseAssistantLookup(space.key) === projectKey);
  if (exact) return exact;
  const contains = list.find((space) => {
    const name = normaliseAssistantLookup(space.name);
    return (projectName && (name.includes(projectName) || projectName.includes(name))) || (projectKey && name.includes(projectKey));
  });
  return contains || list[0];
}

function escapeConfluenceStorage(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


function confluenceStatusMacro(title, colour = 'Blue') {
  return `<ac:structured-macro ac:name="status" ac:schema-version="1"><ac:parameter ac:name="colour">${escapeConfluenceStorage(colour)}</ac:parameter><ac:parameter ac:name="title">${escapeConfluenceStorage(title)}</ac:parameter></ac:structured-macro>`;
}

function confluencePanelMacro({ title, bodyHtml, tone = 'info' }) {
  const palette = {
    info: { border: '#85B8FF', background: '#E9F2FF', titleBackground: '#CCE0FF', title: '#0C66E4' },
    success: { border: '#7EE2B8', background: '#DCFFF1', titleBackground: '#BAF3DB', title: '#216E4E' },
    warning: { border: '#F5CD47', background: '#FFF7D6', titleBackground: '#F8E6A0', title: '#7F5F01' },
    danger: { border: '#FF9C8F', background: '#FFECE8', titleBackground: '#FFD5D2', title: '#AE2E24' },
    neutral: { border: '#B3B9C4', background: '#F7F8F9', titleBackground: '#DCDFE4', title: '#44546F' },
  }[tone] || { border: '#85B8FF', background: '#E9F2FF', titleBackground: '#CCE0FF', title: '#0C66E4' };
  return `<ac:structured-macro ac:name="panel" ac:schema-version="1"><ac:parameter ac:name="title">${escapeConfluenceStorage(title)}</ac:parameter><ac:parameter ac:name="borderColor">${palette.border}</ac:parameter><ac:parameter ac:name="bgColor">${palette.background}</ac:parameter><ac:parameter ac:name="titleBGColor">${palette.titleBackground}</ac:parameter><ac:parameter ac:name="titleColor">${palette.title}</ac:parameter><ac:rich-text-body>${bodyHtml}</ac:rich-text-body></ac:structured-macro>`;
}

function buildConfluenceCanonicalPageUrl(spaceKey, pageId, pageTitle = '', webui = '') {
  const key = String(spaceKey ?? '').trim();
  const id = String(pageId ?? '').trim();
  const title = String(pageTitle ?? '').trim();
  if (key && id) {
    const titlePath = title ? `/${encodeURIComponent(title).replace(/%20/g, '+')}` : '';
    return `/wiki/spaces/${encodeURIComponent(key)}/pages/${encodeURIComponent(id)}${titlePath}`;
  }
  const raw = String(webui ?? '').trim();
  if (raw.startsWith('/wiki/')) return raw;
  if (raw.startsWith('/spaces/')) return `/wiki${raw}`;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (parsed.pathname.startsWith('/wiki/')) return `${parsed.pathname}${parsed.search}${parsed.hash}`;
      if (parsed.pathname.startsWith('/spaces/')) return `/wiki${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      // Fall through to page-id route below.
    }
  }
  return id ? `/wiki/pages/${encodeURIComponent(id)}` : '/wiki';
}

function commentaryToConfluenceStorage(value) {
  const lines = String(value ?? '').split(/\r?\n/);
  const headingLabels = new Set([
    'summary',
    'at-a-glance',
    'key risks',
    'recommended actions',
    'next sprint outlook',
    'planning checks',
  ]);
  const output = [];
  let bulletItems = [];

  const flushBullets = () => {
    if (!bulletItems.length) return;
    output.push(`<ul>${bulletItems.join('')}</ul>`);
    bulletItems = [];
  };

  const formatInline = (text) => {
    const raw = String(text ?? '').trim();
    const match = raw.match(/^([^:]{2,42}):\s*(.+)$/);
    if (!match) return escapeConfluenceStorage(raw);
    return `<strong>${escapeConfluenceStorage(match[1])}:</strong> ${escapeConfluenceStorage(match[2])}`;
  };

  lines.forEach((rawLine) => {
    const line = String(rawLine ?? '').trim();
    if (!line) {
      flushBullets();
      return;
    }

    const normalized = line.replace(/[:：]$/, '').trim().toLowerCase();
    if (headingLabels.has(normalized)) {
      flushBullets();
      output.push(`<h4>${escapeConfluenceStorage(line.replace(/[:：]$/, ''))}</h4>`);
      return;
    }

    if (/^[•*-]\s*/.test(line)) {
      bulletItems.push(`<li>${formatInline(line.replace(/^[•*-]\s*/, ''))}</li>`);
      return;
    }

    flushBullets();
    output.push(`<p>${formatInline(line)}</p>`);
  });

  flushBullets();
  return output.join('');
}

const FULL_EXPORT_SECTIONS = {
  overview: true,
  traceability: true,
  effort: true,
  scopeHistory: true,
  burndown: true,
  changeLog: true,
  statusTypes: true,
  sprintReport: true,
  velocity: true,
  teamWorkload: true,
  workItems: true,
};

function isDefectIssue(issue) {
  const type = String(issue?.issueType ?? '').toLowerCase();

  return (
    type === 'bug' ||
    type === 'defect' ||
    type.includes('defect')
  );
}

function buildExportFileName(projectKey, sprintName, extension) {
  const safeSprint = String(sprintName ?? 'Sprint')
    .replace(/[^a-z0-9-_]+/gi, '_')
    .replace(/^_+|_+$/g, '');

  const date = new Date().toISOString().slice(0, 10);

  return `${projectKey || 'Jira'}_${safeSprint}_Executive_Report_${date}.${extension}`;
}

function buildConfluenceAttachmentFileName(projectKey, sprintName, extension) {
  const safeProject = String(projectKey || 'Jira')
    .replace(/[^a-z0-9-_]+/gi, '_')
    .replace(/^_+|_+$/g, '');
  const safeSprint = String(sprintName ?? 'Sprint')
    .replace(/[^a-z0-9-_]+/gi, '_')
    .replace(/^_+|_+$/g, '');

  // Deliberately omit the publish date so re-publishing the same sprint updates
  // the existing Confluence attachment and creates a new attachment version.
  return `${safeProject}_${safeSprint}_StatusDeck_Report.${extension}`;
}


function addPptText(slide, text, options = {}) {
  slide.addText(String(text ?? ''), {
    fontFace: 'Aptos',
    color: '172B4D',
    margin: 0,
    breakLine: false,
    valign: 'mid',
    ...options,
  });
}

function getExportPalette() {
  return {
    navy: '102A43',
    blue: '2457A6',
    blueLight: 'EAF0FA',
    green: '13795B',
    greenLight: 'E7F4EF',
    amber: 'B7791F',
    amberLight: 'FBF1DD',
    red: 'A83B3B',
    redLight: 'F8E8E8',
    purple: '5A4A8A',
    grey: '536273',
    greyLight: 'F5F3EF',
    border: 'C9D3DF',
    white: 'FFFFFF',
  };
}

function getEstimationDisplay(report) {
  const source = report?.estimationSource ?? report?.storyPointField ?? {};
  const type = String(source?.type ?? '');
  const unit = String(source?.unit ?? '');
  const fieldId = String(source?.fieldId ?? source?.id ?? '');
  const name = String(source?.name ?? report?.storyPointField?.name ?? '').trim();

  if (type === 'issueCount' || unit === 'items') {
    return { noun: 'items', short: 'items' };
  }
  if (type === 'originalEstimate' || unit === 'hours' || fieldId === 'timeoriginalestimate') {
    return { noun: 'estimate hours', short: 'hours' };
  }
  if (unit === 'points' || /story point/i.test(name)) {
    return { noun: 'story points', short: 'points' };
  }
  return { noun: name ? `${name} units` : 'estimation units', short: 'units' };
}


function getReportFingerprint(report) {
  if (!report?.sprint?.id) return '';
  const metrics = report.metrics ?? {};
  const effort = metrics.effort ?? {};
  const ac = metrics.acceptanceCriteria ?? {};
  const trace = metrics.traceability ?? {};
  return [
    report.sprint.id,
    metrics.total ?? 0,
    metrics.completed ?? 0,
    metrics.committedStoryPoints ?? 0,
    metrics.completedStoryPoints ?? 0,
    metrics.remainingStoryPoints ?? 0,
    metrics.overdue ?? 0,
    metrics.defects ?? 0,
    effort.forecastHours ?? 0,
    ac.coveragePercentage ?? 'na',
    trace.parentLinkedStories ?? 0,
    trace.testEvidenceStories ?? 0,
    trace.releaseMappedStories ?? 0,
  ].join('|');
}

function getManagementNarrative({
  report,
  readiness,
  deliveryStatus,
  settings = DEFAULT_REPORTING_SETTINGS,
}) {
  const effort = report.metrics?.effort;
  const history = report.history;
  const estimationDisplay = getEstimationDisplay(report);
  const summary = [];
  const risks = [];
  const actions = [];

  if (report.sprint?.state === 'future') {
    const issues = report.metrics?.reportingIssues ?? [];
    const unassigned = issues.filter((issue) => issue.assignee === 'Unassigned').length;
    const unestimated = issues.filter((issue) => Number(issue.storyPoints ?? 0) <= 0).length;
    const ac = report.metrics?.acceptanceCriteria ?? null;

    summary.push(
      `${report.sprint.name} has not started. It contains ${report.metrics.total} planned work items totalling ${formatNumber(report.metrics.committedStoryPoints)} ${estimationDisplay.short}.`
    );

    if (ac?.eligibleStories > 0) {
      summary.push(
        `Acceptance Criteria are identifiable in ${ac.detectedStories} of ${ac.eligibleStories} Stories (${formatNumber(ac.coveragePercentage)}%), with ${ac.totalCriteria ?? 0} individual criteria identified.`
      );
      if ((ac.trackableCriteria ?? 0) > 0) {
        summary.push(`${ac.metCriteria ?? 0} criteria are explicitly Met and ${ac.notMetCriteria ?? 0} are explicitly Not met; ${ac.unrecordedCriteria ?? 0} have no recorded completion state.`);
      } else if ((ac.totalCriteria ?? 0) > 0) {
        summary.push(`${ac.unrecordedCriteria ?? ac.totalCriteria ?? 0} identified criteria have no explicit Jira completion state, so StatusDeck does not infer whether they are Met.`);
      }
      if (ac.missingStories > 0) {
        risks.push(`${ac.missingStories} ${ac.missingStories === 1 ? 'Story is' : 'Stories are'} missing identifiable Acceptance Criteria.`);
        actions.push('Complete Acceptance Criteria: Refine the flagged Stories before sprint activation using the configured Acceptance Criteria source.');
      }
    }

    if (!String(report.sprint.goal ?? '').trim()) {
      risks.push('No Sprint Goal has been entered.');
      actions.push('Confirm sprint goal: Add a measurable Sprint Goal before sprint activation.');
    }
    if (unassigned > 0) {
      risks.push(`${unassigned} planned ${unassigned === 1 ? 'item is' : 'items are'} unassigned.`);
      actions.push('Assign ownership: Confirm owners for planned work before sprint activation.');
    }
    if (unestimated > 0) {
      risks.push(`${unestimated} planned ${unestimated === 1 ? 'item has' : 'items have'} no estimate.`);
      actions.push('Validate estimates: Estimate material planned work and confirm capacity before sprint activation.');
    }
    if (report.metrics.overdue > 0) {
      risks.push(`${report.metrics.overdue} planned ${report.metrics.overdue === 1 ? 'item is' : 'items are'} already overdue.`);
      actions.push('Review overdue scope: Re-baseline, remove, or prioritise overdue items before sprint activation.');
    }

    if (risks.length === 0) risks.push('No material planning gaps were detected from the available Jira data.');
    if (actions.length === 0) actions.push('Confirm the Sprint Goal and planned scope with the team before activation.');

    return {
      title: deliveryStatus.label,
      score: readiness.score,
      summary,
      risks,
      actions: [...new Set(actions)],
    };
  }

  summary.push(
    `${report.metrics.storyPointCompletionPercentage}% of sprint ${estimationDisplay.noun} are complete (${formatNumber(
      report.metrics.completedStoryPoints
    )} of ${formatNumber(report.metrics.committedStoryPoints)}).`
  );

  const currentAcceptanceCriteria = report.metrics?.acceptanceCriteria ?? null;
  const minimumAcceptanceCriteriaCoverage = Number(settings?.readiness?.minimumAcceptanceCriteriaCoverage ?? 80);
  if (currentAcceptanceCriteria?.eligibleStories > 0) {
    summary.push(`Acceptance Criteria coverage is ${formatNumber(currentAcceptanceCriteria.coveragePercentage)}% (${currentAcceptanceCriteria.detectedStories}/${currentAcceptanceCriteria.eligibleStories} Stories) from ${report.acceptanceCriteriaSource?.name || 'Jira'}.`);
    if (Number(currentAcceptanceCriteria.coveragePercentage ?? 0) < minimumAcceptanceCriteriaCoverage) {
      risks.push(`Quality readiness risk: Acceptance Criteria coverage is ${formatNumber(currentAcceptanceCriteria.coveragePercentage)}%, below the configured ${minimumAcceptanceCriteriaCoverage}% minimum.`);
      actions.push('Complete Acceptance Criteria: Review flagged Stories and complete Acceptance Criteria before release or sprint sign-off.');
    }
  }

  if (history?.available) {
    const original = Number(
      history.originalCommitment?.storyPoints ?? 0
    );
    const current = Number(report.metrics.committedStoryPoints ?? history.currentScope?.storyPoints ?? 0);
    const baselineReliable = original > 0 || current === 0;
    const difference = current - original;

    summary.push(
      difference === 0
        ? `Current scope remains aligned to the ${formatNumber(
            original
          )} ${estimationDisplay.short} sprint-start commitment.`
        : `Current scope is ${formatNumber(
            Math.abs(difference)
          )} ${estimationDisplay.short} ${difference > 0 ? 'above' : 'below'} the sprint-start commitment.`
    );
  }

  if (effort) {
    summary.push(
      `Forecast effort is ${formatHours(
        effort.forecastHours
      )} against an original estimate of ${formatHours(
        effort.originalEstimateHours
      )}, a ${formatHours(
        effort.varianceHours
      )} variance (${formatNumber(
        effort.variancePercentage
      )}%).`
    );

    if (effort.forecastProvisional) {
      risks.push(
        `Estimate-quality risk: Remaining Estimate coverage is ${formatNumber(
          effort.coverage?.remainingEstimateCoveragePercentage ?? 0
        )}%, so forecast effort may be understated.`
      );

      const missingRemainingItems = Math.max(
        0,
        Number(effort.coverage?.remainingEstimateEligibleItems ?? 0) -
          Number(effort.coverage?.remainingEstimateCoveredItems ?? 0)
      );
      actions.push(
        missingRemainingItems > 0
          ? `Validate estimates: Require immediate Remaining Estimate updates for ${missingRemainingItems} incomplete ${missingRemainingItems === 1 ? 'item' : 'items'} with missing or zero values, then revalidate the forecast.`
          : 'Validate estimates: Require Remaining Estimate updates for all open items and revalidate whether the apparent variance reflects genuine efficiency or missing data.'
      );
    }
  }

  const sprintAcceptanceCriteria = report.metrics?.acceptanceCriteria ?? null;
  if (sprintAcceptanceCriteria?.eligibleStories > 0) {
    summary.push(
      `${sprintAcceptanceCriteria.detectedStories} of ${sprintAcceptanceCriteria.eligibleStories} Stories contain identifiable Acceptance Criteria, with ${sprintAcceptanceCriteria.totalCriteria ?? 0} individual criteria identified.`
    );
    if ((sprintAcceptanceCriteria.trackableCriteria ?? 0) > 0) {
      summary.push(
        `${sprintAcceptanceCriteria.metCriteria ?? 0} criteria are explicitly Met and ${sprintAcceptanceCriteria.notMetCriteria ?? 0} are explicitly Not met (${formatNumber(sprintAcceptanceCriteria.completionPercentage)}% of criteria with a recorded Jira checkbox/task state).`
      );
    }
    if ((sprintAcceptanceCriteria.notMetCriteria ?? 0) > 0) {
      risks.push(`${sprintAcceptanceCriteria.notMetCriteria} Acceptance ${sprintAcceptanceCriteria.notMetCriteria === 1 ? 'Criterion is' : 'Criteria are'} explicitly marked Not met.`);
      actions.push('Review the Stories with explicitly incomplete Acceptance Criteria before sprint closure or release sign-off.');
    }
    if ((sprintAcceptanceCriteria.unrecordedCriteria ?? 0) > 0) {
      risks.push(`${sprintAcceptanceCriteria.unrecordedCriteria} identified Acceptance ${sprintAcceptanceCriteria.unrecordedCriteria === 1 ? 'Criterion has' : 'Criteria have'} no recorded completion state; StatusDeck will not infer completion from plain text.`);
    }
  }

  if (report.metrics.overdue > 0) {
    risks.push(
      `Schedule risk: ${report.metrics.overdue} overdue open ${
        report.metrics.overdue === 1 ? 'item requires' : 'items require'
      } management attention.`
    );

    actions.push(
      'Review overdue scope: Replan unfinished overdue work with confirmed owners and revised due dates.'
    );
  }

  if (report.metrics.defects > 0) {
    risks.push(
      `Quality risk: ${report.metrics.defects} defects were included in sprint scope; ${readiness.openDefects ?? 0} remain unresolved.`
    );

    actions.push(
      'Resolve quality blockers: Prioritise unresolved high-severity defects and confirm release acceptance criteria before deployment.'
    );
  }

  if (risks.length === 0) {
    risks.push('No material delivery risks were detected from the available Jira data.');
  }

  if (actions.length === 0) {
    actions.push('Continue monitoring delivery and keep estimates current through sprint closure.');
  }

  return {
    title: deliveryStatus.label,
    score: readiness.score,
    summary,
    risks,
    actions: [...new Set(actions)],
  };
}

function parseManagementCommentaryForExport(text, fallbackNarrative) {
  const source = String(text ?? '').trim();
  const result = {
    summary: [],
    risks: [],
    actions: [],
    outlook: [],
    planning: [],
    additional: [],
  };

  if (!source) {
    return {
      ...result,
      summary: [...(fallbackNarrative?.summary ?? [])],
      risks: [...(fallbackNarrative?.risks ?? [])],
      actions: [...(fallbackNarrative?.actions ?? [])],
    };
  }

  let section = 'additional';
  const headingMap = new Map([
    ['summary', 'summary'],
    ['at-a-glance', 'summary'],
    ['key risks', 'risks'],
    ['risks', 'risks'],
    ['recommended actions', 'actions'],
    ['actions', 'actions'],
    ['next sprint outlook', 'outlook'],
    ['release / milestone outlook', 'outlook'],
    ['release outlook', 'outlook'],
    ['milestone outlook', 'outlook'],
    ['planning checks', 'planning'],
  ]);

  source.split(/\r?\n/).forEach((rawLine) => {
    const line = String(rawLine ?? '').trim();
    if (!line) return;

    const lowerLine = line.toLowerCase();
    if (lowerLine.startsWith('planning checks:')) {
      section = 'planning';
      const detail = line.slice(line.indexOf(':') + 1).trim();
      if (detail) result.planning.push(detail);
      return;
    }

    const normalizedHeading = line.replace(/[:：]$/, '').trim().toLowerCase();
    if (headingMap.has(normalizedHeading)) {
      section = headingMap.get(normalizedHeading);
      return;
    }

    const cleaned = line.replace(/^[•*-]\s*/, '').trim();
    if (cleaned) result[section].push(cleaned);
  });

  if (!result.summary.length) result.summary = [...(fallbackNarrative?.summary ?? [])];
  if (!result.risks.length) result.risks = [...(fallbackNarrative?.risks ?? [])];
  if (!result.actions.length) result.actions = [...(fallbackNarrative?.actions ?? [])];

  return result;
}

function getCommentaryContinuationLines(commentarySections) {
  const lines = [];
  const append = (title, items) => {
    if (!items?.length) return;
    lines.push(title);
    items.forEach((item) => lines.push(`• ${item}`));
    lines.push('');
  };

  append('ADDITIONAL COMMENTARY', commentarySections?.additional);
  return lines.filter((line, index, all) => line || (index > 0 && all[index - 1]));
}

function buildNextSprintOutlookSummary(
  nextSprintOutlook,
  velocityReport
) {
  if (!nextSprintOutlook?.available) {
    return null;
  }

  const averageVelocity = Number(
    velocityReport?.averageCompleted ?? 0
  );

  const plannedPoints = Number(
    nextSprintOutlook.plannedPoints ?? 0
  );

  const velocityLoadPercentage =
    averageVelocity > 0
      ? Math.round((plannedPoints / averageVelocity) * 100)
      : 0;

  const risks = [];

  if (nextSprintOutlook.unassignedItems > 0) {
    risks.push(
      `${nextSprintOutlook.unassignedItems} unassigned`
    );
  }

  if (nextSprintOutlook.unestimatedItems > 0) {
    risks.push(
      `${nextSprintOutlook.unestimatedItems} unestimated`
    );
  }

  if (nextSprintOutlook.overdueItems > 0) {
    risks.push(
      `${nextSprintOutlook.overdueItems} overdue`
    );
  }

  if (nextSprintOutlook.defects > 0) {
    risks.push(
      `${nextSprintOutlook.defects} defects`
    );
  }

  const acceptanceCriteria = nextSprintOutlook.acceptanceCriteria ?? null;
  if (acceptanceCriteria?.eligibleStories > 0 && acceptanceCriteria.missingStories > 0) {
    risks.push(
      `${acceptanceCriteria.missingStories} ${acceptanceCriteria.missingStories === 1 ? 'Story missing' : 'Stories missing'} identifiable Acceptance Criteria`
    );
  }

  return {
    sprintName: nextSprintOutlook.sprint?.name ?? 'Next Sprint',
    goal:
      nextSprintOutlook.sprint?.goal ||
      'No sprint goal entered',
    plannedItems: Number(
      nextSprintOutlook.plannedItems ?? 0
    ),
    plannedPoints,
    carryOverItems: Number(
      nextSprintOutlook.carryOverItems ?? 0
    ),
    carryOverPoints: Number(
      nextSprintOutlook.carryOverPoints ?? 0
    ),
    averageVelocity,
    velocityLoadPercentage,
    acceptanceCriteria,
    risks,
  };
}

function getPriorityCounts(issues) {
  return (issues ?? []).reduce((result, issue) => {
    const key = issue.priority || 'None';
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});
}

function addPptHeader(slide, title, subtitle, page) {
  const palette = getExportPalette();

  slide.addShape('rect', {
    x: 0,
    y: 0,
    w: 13.333,
    h: 0.18,
    fill: { color: palette.blue },
    line: { color: palette.blue, transparency: 100 },
  });

  addPptText(slide, title, {
    x: 0.55,
    y: 0.38,
    w: 8.8,
    h: 0.4,
    fontSize: 23,
    bold: true,
    color: palette.navy,
  });

  if (subtitle) {
    addPptText(slide, subtitle, {
      x: 0.58,
      y: 0.84,
      w: 10.8,
      h: 0.25,
      fontSize: 10,
      color: palette.grey,
    });
  }

  addPptText(slide, 'Executive Sprint Reporting · by QTI Labs', {
    x: 0.55,
    y: 7.18,
    w: 5.8,
    h: 0.16,
    fontSize: 7.5,
    color: palette.grey,
  });

  addPptText(slide, String(page), {
    x: 12.3,
    y: 7.18,
    w: 0.45,
    h: 0.16,
    fontSize: 7.5,
    color: palette.grey,
    align: 'right',
  });
}

function addPptMetricCard(
  pptx,
  slide,
  {
    x,
    y,
    w,
    h,
    label,
    value,
    helper,
    accent = '0C66E4',
  }
) {
  const palette = getExportPalette();

  slide.addShape(pptx.ShapeType.roundRect, {
    x,
    y,
    w,
    h,
    rectRadius: 0.05,
    fill: { color: palette.white },
    line: { color: palette.border, pt: 0.8 },
    shadow: {
      type: 'outer',
      color: 'AAB4C3',
      opacity: 0.16,
      blur: 1.5,
      angle: 45,
      distance: 1,
    },
  });

  slide.addShape(pptx.ShapeType.rect, {
    x,
    y,
    w: 0.08,
    h,
    fill: { color: accent },
    line: { color: accent, transparency: 100 },
  });

  addPptText(slide, label, {
    x: x + 0.22,
    y: y + 0.12,
    w: w - 0.4,
    h: 0.2,
    fontSize: 8.5,
    bold: true,
    color: palette.grey,
  });

  addPptText(slide, value, {
    x: x + 0.22,
    y: y + 0.36,
    w: w - 0.4,
    h: 0.38,
    fontSize: 22,
    bold: true,
    color: palette.navy,
  });

  if (helper) {
    addPptText(slide, helper, {
      x: x + 0.22,
      y: y + h - 0.28,
      w: w - 0.4,
      h: 0.16,
      fontSize: 7.5,
      color: palette.grey,
    });
  }
}

function addPptHorizontalBars(
  pptx,
  slide,
  entries,
  {
    x = 0.8,
    y = 1.4,
    w = 11.7,
    rowHeight = 0.42,
    labelWidth = 2.2,
    valueWidth = 0.65,
    colors = [],
  } = {}
) {
  const palette = getExportPalette();
  const maxValue = Math.max(
    1,
    ...entries.map((entry) => Math.abs(Number(entry.value ?? 0)))
  );

  entries.forEach((entry, index) => {
    const rowY = y + index * rowHeight;
    const barX = x + labelWidth;
    const barW = w - labelWidth - valueWidth;

    addPptText(slide, entry.label, {
      x,
      y: rowY,
      w: labelWidth - 0.15,
      h: 0.2,
      fontSize: 8.5,
      color: palette.grey,
    });

    slide.addShape(pptx.ShapeType.roundRect, {
      x: barX,
      y: rowY + 0.04,
      w: barW,
      h: 0.12,
      rectRadius: 0.03,
      fill: { color: 'EDF0F5' },
      line: { color: 'EDF0F5', transparency: 100 },
    });

    const magnitude = Math.abs(Number(entry.value ?? 0));
    const width = Math.max(0.04, (magnitude / maxValue) * barW);
    const color =
      entry.color ??
      colors[index % colors.length] ??
      palette.blue;

    slide.addShape(pptx.ShapeType.roundRect, {
      x: barX,
      y: rowY + 0.04,
      w: width,
      h: 0.12,
      rectRadius: 0.03,
      fill: { color },
      line: { color, transparency: 100 },
    });

    addPptText(
      slide,
      `${entry.prefix ?? ''}${formatNumber(entry.value)}`,
      {
        x: x + w - valueWidth + 0.08,
        y: rowY - 0.01,
        w: valueWidth - 0.08,
        h: 0.2,
        fontSize: 8.5,
        bold: true,
        color: palette.navy,
        align: 'right',
      }
    );
  });
}

// For management exports, the ideal line always terminates at zero
// on the sprint end date. The actual line preserves Jira's remaining work.
function addPptBurndown(
  pptx,
  slide,
  points,
  {
    x = 0.85,
    y = 1.35,
    w = 11.6,
    h = 4.9,
    basis = 'points',
  } = {}
) {
  const palette = getExportPalette();
  const rows = Array.isArray(points)
    ? points.filter((point) => point?.timestamp)
    : [];

  if (rows.length < 2) {
    addPptText(slide, 'Burndown data is not available.', {
      x,
      y: y + 1.5,
      w,
      h: 0.4,
      fontSize: 16,
      color: palette.grey,
      align: 'center',
    });
    return;
  }

  const actualKey =
    basis === 'effort'
      ? 'remainingEffortHours'
      : 'remainingPoints';

  const idealKey =
    basis === 'effort'
      ? 'idealRemainingEffortHours'
      : 'idealRemainingPoints';

  const maxValue = Math.max(
    1,
    ...rows.flatMap((point) => [
      Number(point[actualKey] ?? 0),
      Number(point[idealKey] ?? 0),
    ])
  );

  const left = x + 0.55;
  const top = y + 0.15;
  const chartW = w - 0.85;
  const chartH = h - 0.75;

  for (let index = 0; index <= 5; index += 1) {
    const gy = top + (chartH * index) / 5;

    slide.addShape(pptx.ShapeType.line, {
      x: left,
      y: gy,
      w: chartW,
      h: 0,
      line: { color: 'D9E2EC', pt: 0.6 },
    });

    addPptText(slide, formatNumber(maxValue * (1 - index / 5)), {
      x: x,
      y: gy - 0.09,
      w: 0.45,
      h: 0.16,
      fontSize: 7,
      color: palette.grey,
      align: 'right',
    });
  }

  slide.addShape(pptx.ShapeType.line, {
    x: left,
    y: top,
    w: 0,
    h: chartH,
    line: { color: palette.grey, pt: 0.9 },
  });

  slide.addShape(pptx.ShapeType.line, {
    x: left,
    y: top + chartH,
    w: chartW,
    h: 0,
    line: { color: palette.grey, pt: 0.9 },
  });

  function pointPosition(point, index, key) {
    const value =
      key === idealKey && index === rows.length - 1
        ? 0
        : Number(point[key] ?? 0);

    return {
      x: left + (chartW * index) / Math.max(1, rows.length - 1),
      y:
        top +
        chartH -
        (value / maxValue) * chartH,
    };
  }

  for (let index = 1; index < rows.length; index += 1) {
    const previousActual = pointPosition(
      rows[index - 1],
      index - 1,
      actualKey
    );
    const currentActual = pointPosition(rows[index], index, actualKey);
    const previousIdeal = pointPosition(
      rows[index - 1],
      index - 1,
      idealKey
    );
    const currentIdeal = pointPosition(rows[index], index, idealKey);

    slide.addShape(pptx.ShapeType.line, {
      x: previousActual.x,
      y: previousActual.y,
      w: currentActual.x - previousActual.x,
      h: 0,
      line: { color: 'E34935', pt: 2 },
    });

    slide.addShape(pptx.ShapeType.line, {
      x: currentActual.x,
      y: previousActual.y,
      w: 0,
      h: currentActual.y - previousActual.y,
      line: { color: 'E34935', pt: 2 },
    });

    slide.addShape(pptx.ShapeType.line, {
      x: previousIdeal.x,
      y: previousIdeal.y,
      w: currentIdeal.x - previousIdeal.x,
      h: currentIdeal.y - previousIdeal.y,
      line: { color: '5B8F67', pt: 1.4 },
    });
  }

  const labelIndexes = [
    0,
    Math.floor((rows.length - 1) / 2),
    rows.length - 1,
  ];

  labelIndexes.forEach((index) => {
    const point = rows[index];
    const px = left + (chartW * index) / Math.max(1, rows.length - 1);

    addPptText(slide, formatShortDate(point.timestamp), {
      x: px - 0.65,
      y: top + chartH + 0.15,
      w: 1.3,
      h: 0.18,
      fontSize: 7.5,
      color: palette.grey,
      align:
        index === 0
          ? 'left'
          : index === rows.length - 1
            ? 'right'
            : 'center',
    });
  });

  addPptText(slide, 'Actual Remaining', {
    x: x + w - 3.25,
    y: y - 0.05,
    w: 1.35,
    h: 0.18,
    fontSize: 7.5,
    color: 'E34935',
    bold: true,
  });

  addPptText(slide, 'Ideal Remaining', {
    x: x + w - 1.75,
    y: y - 0.05,
    w: 1.35,
    h: 0.18,
    fontSize: 7.5,
    color: '5B8F67',
    bold: true,
  });
}

function addPptTableSlides({
  pptx,
  title,
  subtitle,
  headers,
  rows,
  columnWidths,
  rowsPerSlide = 15,
  pageRef,
}) {
  const palette = getExportPalette();

  if (!rows.length) {
    return;
  }

  for (let offset = 0; offset < rows.length; offset += rowsPerSlide) {
    const slide = pptx.addSlide();
    const pageRows = rows.slice(offset, offset + rowsPerSlide);
    const pageNumber = pageRef.value++;

    addPptHeader(
      slide,
      `${title}${rows.length > rowsPerSlide ? ` · ${Math.floor(offset / rowsPerSlide) + 1}/${Math.ceil(rows.length / rowsPerSlide)}` : ''}`,
      subtitle,
      pageNumber
    );

    slide.addTable(
      [
        headers.map((header) => ({
          text: header,
          options: {
            bold: true,
            color: palette.white,
            fill: palette.navy,
          },
        })),
        ...pageRows,
      ],
      {
        x: 0.55,
        y: 1.25,
        w: 12.2,
        h: 5.65,
        border: {
          type: 'solid',
          color: palette.border,
          pt: 0.6,
        },
        fill: palette.white,
        color: palette.navy,
        fontFace: 'Aptos',
        fontSize: 7.3,
        margin: 0.045,
        rowH: 0.31,
        colW: columnWidths,
        autoFit: false,
        valign: 'mid',
        breakLine: false,
      }
    );
  }
}


function getCreatedResolvedTickIndices(points, maxTicks = 7) {
  const length = Array.isArray(points) ? points.length : 0;
  if (!length) return [];
  if (length <= maxTicks) return points.map((_, index) => index);
  const slots = Math.max(2, Math.min(maxTicks, length));
  const selected = new Set();
  for (let tick = 0; tick < slots; tick += 1) {
    selected.add(Math.round((tick * (length - 1)) / (slots - 1)));
  }
  selected.add(0);
  selected.add(length - 1);
  return [...selected]
    .filter((index) => index >= 0 && index < length)
    .sort((a, b) => a - b);
}

function getCreatedResolvedTotals(insight) {
  const points = Array.isArray(insight?.timeSeries) ? insight.timeSeries : [];
  return points.reduce(
    (totals, point) => ({
      created: totals.created + Number(point?.created || 0),
      resolved: totals.resolved + Number(point?.resolved || 0),
    }),
    { created: 0, resolved: 0 }
  );
}

function getCustomInsightEvidence(insight) {
  if (!insight) return '';
  if (insight.error) return String(insight.error);
  if (insight.viewType === 'createdResolved') {
    const totals = getCreatedResolvedTotals(insight);
    return `${formatNumber(insight.matchedIssues ?? insight.value ?? 0)} in chart window · Created ${formatNumber(totals.created)} · Resolved ${formatNumber(totals.resolved)} · ${insight.period || 'day'} buckets · last ${formatNumber(insight.daysPreviously || 30)} days${Number.isFinite(Number(insight.sourceFilterCount)) ? ` · source filter ≈${formatNumber(insight.sourceFilterCount)}` : ''}`;
  }
  if (insight.viewType === 'daysRemaining') {
    return `Days Remaining${insight.sprintName ? ` · ${insight.sprintName}` : ''}`;
  }
  if (insight.viewType === 'pie') {
    return `Grouped by ${formatJiraStatisticLabel(insight.statisticType)} · ${formatNumber(insight.matchedIssues ?? insight.value ?? 0)} matching Jira items`;
  }
  if (insight.viewType === 'twoDimensional') {
    return `${formatJiraStatisticLabel(insight.xStatistic)} × ${formatJiraStatisticLabel(insight.yStatistic)} · ${formatNumber(insight.matchedIssues ?? insight.value ?? 0)} matching Jira items`;
  }
  return `${insight.approximate ? '≈ ' : ''}${formatNumber(insight.matchedIssues ?? insight.value ?? 0)} matching Jira items`;
}

function addPptCreatedResolvedInsight(pptx, slide, insight, bounds) {
  const palette = getExportPalette();
  const points = Array.isArray(insight?.timeSeries) ? insight.timeSeries : [];
  const totals = getCreatedResolvedTotals(insight);
  const { x, y, w, h } = bounds;
  const left = x + 0.35;
  const right = x + w - 0.25;
  const top = y + 0.95;
  const bottom = y + h - 0.45;
  const chartW = Math.max(0.1, right - left);
  const chartH = Math.max(0.1, bottom - top);
  const maxValue = Math.max(1, ...points.flatMap((point) => [Number(point?.created || 0), Number(point?.resolved || 0)]));
  const pointX = (index) => points.length <= 1 ? left : left + (index / (points.length - 1)) * chartW;
  const pointY = (value) => bottom - (Number(value || 0) / maxValue) * chartH;
  addPptText(slide, insight.name || 'Created vs. Resolved Chart', { x, y, w: w * 0.55, h: 0.28, fontSize: 12, bold: true, color: palette.navy });
  addPptText(slide, `${formatNumber(insight.matchedIssues ?? insight.value ?? 0)} in chart window`, { x, y: y + 0.31, w: 2.8, h: 0.32, fontSize: 18, bold: true, color: palette.navy });
  addPptText(slide, `${insight.period || 'day'} buckets · last ${formatNumber(insight.daysPreviously || 30)} days${Number.isFinite(Number(insight.sourceFilterCount)) ? ` · source filter ≈${formatNumber(insight.sourceFilterCount)}` : ''}`, { x: x + 5.7, y: y + 0.08, w: w - 5.7, h: 0.22, fontSize: 7.4, color: palette.grey, align: 'right' });
  addPptText(slide, `Created ${formatNumber(totals.created)}   Resolved ${formatNumber(totals.resolved)}`, { x, y: y + 0.67, w: 4.2, h: 0.22, fontSize: 8, color: palette.grey });
  [0, 0.25, 0.5, 0.75, 1].forEach((ratio) => {
    const gy = bottom - ratio * chartH;
    slide.addShape(pptx.ShapeType.line, { x: left, y: gy, w: chartW, h: 0, line: { color: 'D9E2EC', width: 0.7 } });
  });
  const addChartLineSegment = (x1, y1, x2, y2, color) => {
    // PowerPoint can repair or misplace line shapes when pptxgenjs receives a negative h value.
    // PDF renders raw point-to-point coordinates correctly, which is why the PDF chart looked right while
    // the PPT chart displayed the Aug 8 spike incorrectly. Normalize each segment before adding it.
    const startX = Math.min(x1, x2);
    const startY = Math.min(y1, y2);
    const width = Math.max(0.001, Math.abs(x2 - x1));
    const height = Math.max(0.001, Math.abs(y2 - y1));
    slide.addShape(pptx.ShapeType.line, {
      x: startX,
      y: startY,
      w: width,
      h: height,
      flipV: y2 < y1,
      flipH: x2 < x1,
      line: { color, width: 2.4, beginArrowType: 'none', endArrowType: 'none' },
    });
  };
  const addSeries = (field, color) => {
    for (let index = 1; index < points.length; index += 1) {
      addChartLineSegment(
        pointX(index - 1),
        pointY(points[index - 1]?.[field]),
        pointX(index),
        pointY(points[index]?.[field]),
        color
      );
    }
  };
  addSeries('created', 'C0392B');
  addSeries('resolved', '2F8F74');
  getCreatedResolvedTickIndices(points, 7).forEach((index) => {
    addPptText(slide, points[index]?.label || '', { x: pointX(index) - 0.34, y: bottom + 0.08, w: 0.68, h: 0.16, fontSize: 6.6, color: palette.grey, align: 'center' });
  });
}

function addPptCustomJiraInsightSlides({ pptx, customKpiResults = [], pageRef }) {
  const insights = (customKpiResults ?? []).filter(Boolean);
  if (!insights.length) return;
  const palette = getExportPalette();
  const createdResolved = insights.filter((item) => item.viewType === 'createdResolved' && Array.isArray(item.timeSeries) && !item.error);
  createdResolved.forEach((insight, index) => {
    const slide = pptx.addSlide();
    addPptHeader(slide, 'Custom Jira Insights', `${insight.name || 'Created vs. Resolved Chart'}${createdResolved.length > 1 ? ` · ${index + 1}/${createdResolved.length}` : ''}`, pageRef.value++);
    addPptCreatedResolvedInsight(pptx, slide, insight, { x: 0.7, y: 1.25, w: 11.9, h: 5.3 });
  });
  const otherInsights = insights.filter((item) => !createdResolved.includes(item));
  if (!otherInsights.length) return;
  const slide = pptx.addSlide();
  addPptHeader(slide, 'Custom Jira Insights', 'Saved Jira filters and dashboard visuals', pageRef.value++);
  otherInsights.slice(0, 8).forEach((insight, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = 0.7 + col * 6.1;
    const y = 1.25 + row * 1.42;
    slide.addShape(pptx.ShapeType.roundRect, { x, y, w: 5.65, h: 1.05, rectRadius: 0.07, fill: { color: insight.error ? 'FFF5F3' : palette.white }, line: { color: insight.error ? palette.red : palette.border, width: 0.8 } });
    addPptText(slide, insight.name || 'Custom Jira insight', { x: x + 0.15, y: y + 0.12, w: 3.95, h: 0.22, fontSize: 8.4, bold: true, color: palette.navy });
    addPptText(slide, insight.error ? '—' : formatNumber(insight.value ?? insight.matchedIssues ?? 0), { x: x + 0.15, y: y + 0.4, w: 1.35, h: 0.36, fontSize: 18, bold: true, color: insight.error ? palette.red : palette.navy });
    addPptText(slide, getCustomInsightEvidence(insight), { x: x + 1.6, y: y + 0.42, w: 3.75, h: 0.38, fontSize: 6.7, color: palette.grey, breakLine: true, valign: 'top' });
  });
}

function pdfCreatedResolvedInsight(doc, insight, bounds) {
  const points = Array.isArray(insight?.timeSeries) ? insight.timeSeries : [];
  const totals = getCreatedResolvedTotals(insight);
  const { x, y, w, h } = bounds;
  const left = x + 10;
  const right = x + w - 6;
  const top = y + 26;
  const bottom = y + h - 10;
  const chartW = Math.max(1, right - left);
  const chartH = Math.max(1, bottom - top);
  const maxValue = Math.max(1, ...points.flatMap((point) => [Number(point?.created || 0), Number(point?.resolved || 0)]));
  const pointX = (index) => points.length <= 1 ? left : left + (index / (points.length - 1)) * chartW;
  const pointY = (value) => bottom - (Number(value || 0) / maxValue) * chartH;
  pdfSetText(doc, [16, 42, 67], 9.5, 'bold');
  doc.text(pdfAscii(insight.name || 'Created vs. Resolved Chart'), x, y + 4);
  pdfSetText(doc, [16, 42, 67], 16, 'bold');
  doc.text(`${formatNumber(insight.matchedIssues ?? insight.value ?? 0)} in chart window`, x, y + 12);
  pdfSetText(doc, [83, 98, 115], 7, 'normal');
  doc.text(pdfAscii(`${insight.period || 'day'} buckets · last ${formatNumber(insight.daysPreviously || 30)} days${Number.isFinite(Number(insight.sourceFilterCount)) ? ` · source filter ≈${formatNumber(insight.sourceFilterCount)}` : ''}`), x + w - 5, y + 5, { align: 'right' });
  doc.text(pdfAscii(`Created ${formatNumber(totals.created)}   Resolved ${formatNumber(totals.resolved)}`), x, y + 18);
  doc.setDrawColor(217, 226, 236);
  doc.setLineWidth(0.25);
  [0, 0.25, 0.5, 0.75, 1].forEach((ratio) => {
    const gy = bottom - ratio * chartH;
    doc.line(left, gy, right, gy);
  });
  const drawSeries = (field, color) => {
    doc.setDrawColor(...color);
    doc.setLineWidth(1.05);
    for (let index = 1; index < points.length; index += 1) {
      doc.line(pointX(index - 1), pointY(points[index - 1]?.[field]), pointX(index), pointY(points[index]?.[field]));
    }
  };
  drawSeries('created', [192, 57, 43]);
  drawSeries('resolved', [47, 143, 116]);
  pdfSetText(doc, [83, 98, 115], 6.2, 'normal');
  getCreatedResolvedTickIndices(points, 7).forEach((index) => {
    doc.text(pdfAscii(points[index]?.label || ''), pointX(index), bottom + 5, { align: 'center' });
  });
}

function getPdfCustomJiraInsightPageCount(customKpiResults = []) {
  const insights = (customKpiResults ?? []).filter(Boolean);
  if (!insights.length) return 0;
  const createdResolvedCount = insights.filter((item) => item.viewType === 'createdResolved' && Array.isArray(item.timeSeries) && !item.error).length;
  const otherCount = insights.some((item) => !(item.viewType === 'createdResolved' && Array.isArray(item.timeSeries) && !item.error)) ? 1 : 0;
  return createdResolvedCount + otherCount;
}

function addPdfCustomJiraInsightPages(doc, customKpiResults = [], pageRef) {
  const insights = (customKpiResults ?? []).filter(Boolean);
  if (!insights.length) return;
  const createdResolved = insights.filter((item) => item.viewType === 'createdResolved' && Array.isArray(item.timeSeries) && !item.error);
  createdResolved.forEach((insight, index) => {
    doc.addPage();
    pdfAddPageHeader(doc, 'Custom Jira Insights', `${insight.name || 'Created vs. Resolved Chart'}${createdResolved.length > 1 ? ` · ${index + 1}/${createdResolved.length}` : ''}`, pageRef.value++);
    pdfCreatedResolvedInsight(doc, insight, { x: 15, y: 34, w: 267, h: 140 });
  });
  const otherInsights = insights.filter((item) => !createdResolved.includes(item));
  if (!otherInsights.length) return;
  doc.addPage();
  pdfAddPageHeader(doc, 'Custom Jira Insights', 'Saved Jira filters and dashboard visuals', pageRef.value++);
  autoTable(doc, {
    startY: 31,
    head: [['Insight', 'Value', 'Evidence']],
    body: otherInsights.map((insight) => [insight.name || 'Custom Jira insight', insight.error ? '—' : formatNumber(insight.value ?? insight.matchedIssues ?? 0), getCustomInsightEvidence(insight)]),
    theme: 'grid',
    headStyles: { fillColor: [16, 42, 67], textColor: [255, 255, 255], fontSize: 8 },
    bodyStyles: { fontSize: 7, cellPadding: 2 },
    columnStyles: { 0: { cellWidth: 70 }, 1: { cellWidth: 28, halign: 'right' }, 2: { cellWidth: 160 } },
    margin: { left: 15, right: 15 },
  });
}

async function createPowerPoint({
  report,
  velocityReport,
  nextSprintOutlook,
  projectKey,
  selectedSections,
  filteredIssues,
  readiness,
  deliveryStatus,
  planningAssessment,
  managementCommentaryText = '',
  customKpiResults = [],
  reportingSettings = DEFAULT_REPORTING_SETTINGS,
}) {
  const pptx = new PptxGenJS();
  const palette = getExportPalette();
  const pageRef = { value: 1 };
  const estimationDisplay = getEstimationDisplay(report);
  const overall = getOverallRag({ report, readiness, settings: reportingSettings });
  const narrative = getManagementNarrative({
    report,
    readiness,
    deliveryStatus,
    settings: reportingSettings,
  });
  const commentarySections = parseManagementCommentaryForExport(
    managementCommentaryText,
    narrative
  );
  const commentaryContinuationLines = getCommentaryContinuationLines(commentarySections);
  const outlookSummary = buildNextSprintOutlookSummary(
    nextSprintOutlook,
    velocityReport
  );
  const executiveSnapshot = getExecutiveCommentarySnapshot({
    report,
    effort: report.metrics?.effort,
    deliveryStatus,
    planningAssessment,
  });

  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'QTI Labs';
  pptx.company = 'QTI Labs';
  pptx.subject = 'Executive Sprint Reporting';
  pptx.title = `${report.sprint.name} Executive Sprint Report`;
  pptx.lang = 'en-IN';
  pptx.theme = {
    headFontFace: 'Aptos Display',
    bodyFontFace: 'Aptos',
    lang: 'en-US',
  };

  {
    const slide = pptx.addSlide();
    slide.background = { color: palette.navy };

    slide.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 13.333,
      h: 0.18,
      fill: { color: palette.blue },
      line: { color: palette.blue, transparency: 100 },
    });

    addPptText(slide, 'EXECUTIVE SPRINT REPORTING', {
      x: 0.72,
      y: 0.72,
      w: 5.7,
      h: 0.3,
      fontSize: 14,
      bold: true,
      color: '85B8FF',
      charSpacing: 1.4,
    });

    addPptText(slide, report.sprint.name, {
      x: 0.72,
      y: 1.25,
      w: 11.6,
      h: 0.72,
      fontSize: 32,
      bold: true,
      color: palette.white,
    });

    addPptText(
      slide,
      report.sprint.goal || 'No sprint goal entered',
      {
        x: 0.72,
        y: 2.08,
        w: 11.2,
        h: 0.45,
        fontSize: 14,
        color: 'DDEBFF',
      }
    );

    addPptText(
      slide,
      `${formatDate(report.sprint.startDate)} – ${formatDate(
        report.sprint.endDate
      )}`,
      {
        x: 0.72,
        y: 2.72,
        w: 6.2,
        h: 0.28,
        fontSize: 12,
        color: palette.white,
      }
    );

    addPptMetricCard(pptx, slide, {
      x: 0.72,
      y: 3.45,
      w: 2.8,
      h: 1.3,
      label: 'Delivery Progress',
      value: `${report.metrics.storyPointCompletionPercentage}%`,
      helper: `${formatNumber(report.metrics.completedStoryPoints)} of ${formatNumber(report.metrics.committedStoryPoints)} ${estimationDisplay.short}`,
      accent: palette.green,
    });

    addPptMetricCard(pptx, slide, {
      x: 3.75,
      y: 3.45,
      w: 2.8,
      h: 1.3,
      label: 'Delivery Health',
      value: `${readiness.score}%`,
      helper: readiness.label,
      accent: palette.blue,
    });

    addPptMetricCard(pptx, slide, {
      x: 6.78,
      y: 3.45,
      w: 2.8,
      h: 1.3,
      label: 'Open Work',
      value: report.metrics.open,
      helper: `${report.metrics.overdue} overdue`,
      accent: palette.amber,
    });

    addPptMetricCard(pptx, slide, {
      x: 9.81,
      y: 3.45,
      w: 2.8,
      h: 1.3,
      label: 'Defects',
      value: report.metrics.defects,
      helper: `${readiness.openDefects ?? 0} unresolved`,
      accent: palette.red,
    });

    addPptText(slide, deliveryStatus.label, {
      x: 0.72,
      y: 5.25,
      w: 5.0,
      h: 0.35,
      fontSize: 19,
      bold: true,
      color: palette.white,
    });

    addPptText(slide, 'Prepared from Jira · by QTI Labs', {
      x: 8.6,
      y: 6.5,
      w: 3.9,
      h: 0.24,
      fontSize: 10,
      color: 'DDEBFF',
      align: 'right',
    });
  }

  if (selectedSections.overview) {
    const slide = pptx.addSlide();
    const page = pageRef.value++;

    addPptHeader(
      slide,
      'Executive Overview',
      'Headline sprint delivery, risk and scope indicators',
      page
    );

    const metrics = [
      {
        label: 'Delivery Progress',
        value: `${report.metrics.storyPointCompletionPercentage}%`,
        helper: `${report.metrics.completed} of ${report.metrics.total} items completed`,
        accent: palette.green,
      },
      {
        label: `Completed ${estimationDisplay.short}`,
        value: report.metrics.completedStoryPoints,
        helper: `${report.metrics.completed} completed items`,
        accent: palette.green,
      },
      {
        label: `Remaining ${estimationDisplay.short}`,
        value: report.metrics.remainingStoryPoints,
        helper: `${report.metrics.open} open items`,
        accent: palette.amber,
      },
      {
        label: 'Delivery Risk',
        value: report.metrics.overdue,
        helper: `${report.metrics.defects} defects · ${report.metrics.overdue} overdue`,
        accent: palette.red,
      },
    ];

    metrics.forEach((metric, index) => {
      addPptMetricCard(pptx, slide, {
        x: 0.55 + index * 3.12,
        y: 1.25,
        w: 2.85,
        h: 1.15,
        ...metric,
      });
    });

    const executiveTakeaway = `${overall.label} · ${deliveryStatus.label} · ${formatNumber(report.metrics.storyPointCompletionPercentage)}% Complete · ${formatNumber(report.metrics.overdue)} overdue · ${formatNumber(readiness?.openDefects ?? 0)} unresolved defects`;
    slide.addShape(pptx.ShapeType.roundRect, { x: 0.65, y: 2.53, w: 11.95, h: 0.42, rectRadius: 0.04, fill: { color: overall.label === 'RED' ? palette.redLight : overall.label === 'AMBER' ? palette.amberLight : palette.greenLight }, line: { color: overall.label === 'RED' ? palette.red : overall.label === 'AMBER' ? palette.amber : palette.green, pt: 0.7 } });
    addPptText(slide, executiveTakeaway, { x: 0.88, y: 2.64, w: 11.45, h: 0.18, fontSize: 8.5, bold: true, color: palette.navy });

    addPptText(slide, 'Delivery Progress', {
      x: 0.65,
      y: 2.75,
      w: 2.2,
      h: 0.25,
      fontSize: 12,
      bold: true,
      color: palette.navy,
    });

    slide.addShape(pptx.ShapeType.roundRect, {
      x: 0.65,
      y: 3.2,
      w: 7.25,
      h: 0.34,
      rectRadius: 0.06,
      fill: { color: 'E9EDF3' },
      line: { color: 'E9EDF3', transparency: 100 },
    });

    const completeWidth =
      7.25 *
      Math.max(
        0,
        Math.min(
          100,
          report.metrics.storyPointCompletionPercentage
        )
      ) /
      100;

    slide.addShape(pptx.ShapeType.roundRect, {
      x: 0.65,
      y: 3.2,
      w: Math.max(0.08, completeWidth),
      h: 0.34,
      rectRadius: 0.06,
      fill: { color: palette.green },
      line: { color: palette.green, transparency: 100 },
    });

    addPptText(
      slide,
      `${formatNumber(report.metrics.completedStoryPoints)} completed of ${formatNumber(report.metrics.committedStoryPoints)} ${estimationDisplay.short}`,
      {
        x: 0.65,
        y: 3.72,
        w: 4.2,
        h: 0.22,
        fontSize: 10,
        color: palette.grey,
      }
    );

    addPptText(slide, 'Issues by Status', {
      x: 8.3,
      y: 2.75,
      w: 2.2,
      h: 0.25,
      fontSize: 12,
      bold: true,
      color: palette.navy,
    });

    const statusEntries = Object.entries(
      report.metrics.statusCounts ?? {}
    )
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, value], index) => ({
        label,
        value,
        color: [
          palette.green,
          palette.blue,
          palette.amber,
          palette.red,
          palette.purple,
        ][index % 5],
      }));

    addPptHorizontalBars(pptx, slide, statusEntries, {
      x: 8.3,
      y: 3.17,
      w: 4.35,
      rowHeight: 0.42,
      labelWidth: 1.45,
      valueWidth: 0.42,
    });

    const scopeEntries = [
      [`Scope ${estimationDisplay.short}`, report.metrics.committedStoryPoints],
      ['Completed Items', report.metrics.completed],
      ['Open Items', report.metrics.open],
      ['Defects', report.metrics.defects],
      ['Overdue', report.metrics.overdue],
    ];

    scopeEntries.forEach(([label, value], index) => {
      addPptMetricCard(pptx, slide, {
        x: 0.65 + index * 2.4,
        y: 5.25,
        w: 2.15,
        h: 0.95,
        label,
        value,
        accent:
          index === 3 || index === 4
            ? palette.red
            : palette.blue,
      });
    });
  }

  addPptCustomJiraInsightSlides({ pptx, customKpiResults, pageRef });

  {
    const slide = pptx.addSlide();
    const page = pageRef.value++;

    addPptHeader(
      slide,
      'Executive Commentary',
      'At-a-glance sprint status, risks, actions and next-sprint outlook',
      page
    );

    const statusColor = executiveSnapshot.tone === 'negative'
      ? palette.red
      : executiveSnapshot.tone === 'warning'
        ? palette.amber
        : executiveSnapshot.tone === 'positive'
          ? palette.green
          : palette.blue;
    const statusLight = executiveSnapshot.tone === 'negative'
      ? palette.redLight
      : executiveSnapshot.tone === 'warning'
        ? palette.amberLight
        : executiveSnapshot.tone === 'positive'
          ? palette.greenLight
          : palette.blueLight;

    slide.addShape(pptx.ShapeType.roundRect, {
      x: 0.65,
      y: 1.22,
      w: 4.25,
      h: 0.52,
      rectRadius: 0.04,
      fill: { color: statusLight },
      line: { color: statusColor, pt: 0.8 },
    });
    addPptText(
      slide,
      `${String(executiveSnapshot.statusPrefix).toUpperCase()}  ·  ${String(executiveSnapshot.statusLabel).toUpperCase()}`,
      {
        x: 0.88,
        y: 1.34,
        w: 3.8,
        h: 0.2,
        fontSize: 10.5,
        bold: true,
        color: statusColor,
      }
    );

    const addExecutiveCallout = (callout, x, w, accent) => {
      slide.addShape(pptx.ShapeType.roundRect, {
        x,
        y: 1.95,
        w,
        h: 1.1,
        rectRadius: 0.04,
        fill: { color: 'FFFFFF' },
        line: { color: palette.border, pt: 0.8 },
        shadow: { type: 'outer', color: 'B8C2CC', opacity: 0.14, blur: 1, angle: 45, distance: 1 },
      });
      slide.addShape(pptx.ShapeType.rect, {
        x,
        y: 1.95,
        w: 0.06,
        h: 1.1,
        fill: { color: accent },
        line: { color: accent, transparency: 100 },
      });
      addPptText(slide, String(callout.label).toUpperCase(), {
        x: x + 0.22,
        y: 2.08,
        w: w - 0.45,
        h: 0.16,
        fontSize: 8,
        bold: true,
        color: palette.grey,
      });
      addPptText(slide, callout.value, {
        x: x + 0.22,
        y: 2.31,
        w: w - 0.45,
        h: 0.28,
        fontSize: 18,
        bold: true,
        color: palette.navy,
      });
      addPptText(slide, callout.detail, {
        x: x + 0.22,
        y: 2.61,
        w: w - 0.45,
        h: 0.17,
        fontSize: 8.4,
        bold: true,
        color: palette.grey,
        fit: 'shrink',
      });
      if (callout.meta) {
        addPptText(slide, callout.meta, {
          x: x + 0.22,
          y: 2.82,
          w: w - 0.45,
          h: 0.15,
          fontSize: 7.4,
          color: palette.grey,
          fit: 'shrink',
        });
      }
    };

    addExecutiveCallout(executiveSnapshot.progress, 0.65, 5.82, palette.blue);
    addExecutiveCallout(
      executiveSnapshot.forecast,
      6.72,
      5.96,
      executiveSnapshot.forecast.provisional ? palette.amber : palette.green
    );

    const addExecutiveBulletPanel = ({ title, items, x, y, w, h, titleColor, fillColor }) => {
      slide.addShape(pptx.ShapeType.roundRect, {
        x,
        y,
        w,
        h,
        rectRadius: 0.04,
        fill: { color: fillColor },
        line: { color: titleColor, transparency: 72, pt: 0.8 },
      });
      addPptText(slide, title, {
        x: x + 0.22,
        y: y + 0.14,
        w: w - 0.44,
        h: 0.2,
        fontSize: 9.5,
        bold: true,
        color: titleColor,
      });
      const visible = (items ?? []).slice(0, 4);
      const runs = [];
      visible.forEach((item) => {
        runs.push({
          text: item,
          options: { bullet: { indent: 12 }, breakLine: true, hanging: 3 },
        });
      });
      if (!visible.length) {
        runs.push({ text: 'No material items identified.', options: { breakLine: true } });
      }
      slide.addText(runs, {
        x: x + 0.26,
        y: y + 0.42,
        w: w - 0.5,
        h: h - 0.5,
        fontFace: 'Aptos',
        fontSize: 8.6,
        color: palette.grey,
        margin: 0.02,
        valign: 'top',
        fit: 'shrink',
      });
    };

    addExecutiveBulletPanel({
      title: 'KEY RISKS',
      items: commentarySections.risks,
      x: 0.65,
      y: 3.30,
      w: 5.82,
      h: 1.55,
      titleColor: palette.red,
      fillColor: 'FFF7F5',
    });
    addExecutiveBulletPanel({
      title: 'RECOMMENDED ACTIONS',
      items: commentarySections.actions,
      x: 6.72,
      y: 3.30,
      w: 5.96,
      h: 1.55,
      titleColor: palette.green,
      fillColor: 'F2FBF7',
    });

    const outlookLines = commentarySections.outlook?.length
      ? commentarySections.outlook
      : outlookSummary
        ? [
            `Load: ${outlookSummary.sprintName} · ${formatNumber(outlookSummary.plannedPoints)} planned ${estimationDisplay.short} / ${formatNumber(outlookSummary.plannedItems)} items / ${formatNumber(outlookSummary.carryOverItems)} carry-over`,
            `Goal: ${outlookSummary.goal}`,
          ]
        : [];
    const planningLines = commentarySections.planning?.length
      ? commentarySections.planning
      : (outlookSummary?.risks ?? []).map((item) => `Check: ${item}`);

    if (outlookLines.length || planningLines.length) {
      slide.addShape(pptx.ShapeType.roundRect, {
        x: 0.65,
        y: 5.08,
        w: 12.03,
        h: 1.42,
        rectRadius: 0.04,
        fill: { color: palette.blueLight },
        line: { color: '85B8FF', pt: 0.7 },
      });
      addPptText(slide, 'NEXT SPRINT OUTLOOK', {
        x: 0.9,
        y: 5.24,
        w: 2.8,
        h: 0.18,
        fontSize: 9.5,
        bold: true,
        color: palette.blue,
      });
      const outlookText = [...outlookLines.slice(0, 3), ...planningLines.slice(0, 2)].join('\n');
      addPptText(slide, outlookText, {
        x: 0.92,
        y: 5.53,
        w: 11.45,
        h: 0.74,
        fontSize: 8.6,
        color: palette.grey,
        valign: 'top',
        breakLine: true,
        fit: 'shrink',
      });
    }

    const overflowLines = [];
    const appendOverflow = (title, items) => {
      if (!items?.length) return;
      overflowLines.push(title);
      items.forEach((item) => overflowLines.push(`• ${item}`));
      overflowLines.push('');
    };
    if (String(managementCommentaryText ?? '').trim()) {
      appendOverflow('PUBLISHED SUMMARY / NOTES', commentarySections.summary);
    }
    appendOverflow('KEY RISKS · CONTINUED', commentarySections.risks?.slice(4));
    appendOverflow('RECOMMENDED ACTIONS · CONTINUED', commentarySections.actions?.slice(4));
    appendOverflow('NEXT SPRINT OUTLOOK · CONTINUED', outlookLines.slice(3));
    appendOverflow('PLANNING CHECKS · CONTINUED', planningLines.slice(2));
    if (commentaryContinuationLines.length) overflowLines.push(...commentaryContinuationLines);

    if (overflowLines.filter(Boolean).length) {
      const continuationSlide = pptx.addSlide();
      const continuationPage = pageRef.value++;
      addPptHeader(
        continuationSlide,
        'Executive Commentary · Continued',
        'Additional published commentary and overflow details',
        continuationPage
      );
      addPptText(continuationSlide, overflowLines.join('\n'), {
        x: 0.72,
        y: 1.25,
        w: 11.85,
        h: 5.65,
        fontSize: 10,
        color: palette.grey,
        valign: 'top',
        breakLine: true,
        fit: 'shrink',
        margin: 0.04,
      });
    }
  }

  const pptAcceptanceCriteria = report.metrics?.acceptanceCriteria ?? null;
  if (pptAcceptanceCriteria?.eligibleStories > 0) {
    const slide = pptx.addSlide();
    const page = pageRef.value++;

    addPptHeader(
      slide,
      'Acceptance Criteria',
      'Story-level coverage and explicit Jira completion-state tracking',
      page
    );

    const acCards = [
      {
        label: 'Stories With AC',
        value: `${pptAcceptanceCriteria.detectedStories}/${pptAcceptanceCriteria.eligibleStories}`,
        helper: `${formatNumber(pptAcceptanceCriteria.coveragePercentage)}% Story coverage`,
        accent: palette.blue,
      },
      {
        label: 'Criteria Identified',
        value: pptAcceptanceCriteria.totalCriteria ?? 0,
        helper: 'Individual criteria',
        accent: palette.blue,
      },
      {
        label: 'Met',
        value: pptAcceptanceCriteria.metCriteria ?? 0,
        helper: 'Explicitly completed',
        accent: palette.green,
      },
      {
        label: 'Not Met',
        value: pptAcceptanceCriteria.notMetCriteria ?? 0,
        helper: 'Explicitly incomplete',
        accent: palette.red,
      },
      {
        label: 'Status Not Recorded',
        value: pptAcceptanceCriteria.unrecordedCriteria ?? 0,
        helper: 'Plain text / no task state',
        accent: palette.amber,
      },
    ];

    acCards.forEach((card, index) => {
      addPptMetricCard(pptx, slide, {
        x: 0.55 + index * 2.5,
        y: 1.35,
        w: 2.25,
        h: 1.25,
        ...card,
      });
    });

    const tracked = Number(pptAcceptanceCriteria.trackableCriteria ?? 0);
    const completionText = tracked > 0
      ? `${formatNumber(pptAcceptanceCriteria.completionPercentage)}% of criteria with an explicit Jira checkbox/task state are Met (${pptAcceptanceCriteria.metCriteria}/${tracked}).`
      : 'No Acceptance Criteria have an explicit Jira checkbox/task completion state, so StatusDeck does not calculate a Met percentage.';

    slide.addShape(pptx.ShapeType.roundRect, {
      x: 0.65,
      y: 3.05,
      w: 12.0,
      h: 1.25,
      rectRadius: 0.05,
      fill: { color: palette.blueLight },
      line: { color: '85B8FF', pt: 0.8 },
    });

    addPptText(slide, 'HOW TO READ THIS', {
      x: 0.92,
      y: 3.28,
      w: 2.2,
      h: 0.2,
      fontSize: 9,
      bold: true,
      color: palette.blue,
    });
    addPptText(slide, completionText, {
      x: 0.92,
      y: 3.62,
      w: 11.3,
      h: 0.42,
      fontSize: 11,
      color: palette.navy,
    });
    addPptText(
      slide,
      `Source: ${report.acceptanceCriteriaSource?.name || 'Jira Description'}. Met / Not met is reported only when Jira explicitly records a checkbox/task state. Plain-text criteria are kept as “Status not recorded”; StatusDeck does not infer completion from issue status or prose.`,
      {
        x: 0.92,
        y: 4.55,
        w: 11.3,
        h: 0.72,
        fontSize: 10,
        color: palette.grey,
        breakLine: true,
      }
    );
  }


  const pptTraceability = report.metrics?.traceability ?? null;
  if (selectedSections.traceability && pptTraceability?.eligibleStories > 0) {
    const slide = pptx.addSlide();
    const page = pageRef.value++;
    addPptHeader(slide, 'Traceability & Quality Evidence', 'Story-level Jira links, Acceptance Criteria, test evidence, defects and release mapping', page);
    const traceCards = [
      ['Parent / Requirement', `${formatNumber(pptTraceability.parentCoveragePercentage)}%`, `${pptTraceability.parentLinkedStories}/${pptTraceability.eligibleStories} Stories`, palette.blue],
      ['Acceptance Criteria', `${formatNumber(report.metrics?.acceptanceCriteria?.coveragePercentage ?? 0)}%`, `${report.metrics?.acceptanceCriteria?.detectedStories ?? 0}/${report.metrics?.acceptanceCriteria?.eligibleStories ?? 0} Stories`, palette.green],
      ['Linked Test Evidence', `${formatNumber(pptTraceability.testEvidenceCoveragePercentage)}%`, `${pptTraceability.testEvidenceStories}/${pptTraceability.eligibleStories} Stories`, palette.purple],
      ['Release Mapping', `${formatNumber(pptTraceability.releaseCoveragePercentage)}%`, `${pptTraceability.releaseMappedStories}/${pptTraceability.eligibleStories} Stories`, palette.amber],
      ['Open Linked Defects', pptTraceability.storiesWithOpenLinkedDefects, `${pptTraceability.storiesWithLinkedDefects} Stories have linked defects`, pptTraceability.storiesWithOpenLinkedDefects ? palette.red : palette.green],
    ];
    traceCards.forEach(([label, value, helper, accent], index) => addPptMetricCard(pptx, slide, { x: 0.55 + index * 2.5, y: 1.35, w: 2.25, h: 1.25, label, value, helper, accent }));
    slide.addShape(pptx.ShapeType.roundRect, { x: 0.7, y: 3.1, w: 11.9, h: 1.35, rectRadius: 0.05, fill: { color: palette.blueLight }, line: { color: '85B8FF', pt: 0.8 } });
    addPptText(slide, 'CORE TRACEABILITY GAPS', { x: 0.95, y: 3.35, w: 2.6, h: 0.22, fontSize: 9, bold: true, color: palette.blue });
    addPptText(slide, `${pptTraceability.criticalGapKeys.length} Stories are missing a parent/requirement link or identifiable Acceptance Criteria.`, { x: 0.95, y: 3.75, w: 10.8, h: 0.35, fontSize: 12, bold: true, color: palette.navy });
    addPptText(slide, `Acceptance Criteria source: ${report.acceptanceCriteriaSource?.name || 'Jira Description'} · ${pptTraceability.methodology}`, { x: 0.95, y: 4.7, w: 11.2, h: 0.72, fontSize: 9, color: palette.grey, breakLine: true });
  }

  if (selectedSections.effort && report.metrics.effort) {
    const slide = pptx.addSlide();
    const page = pageRef.value++;
    const effort = report.metrics.effort;

    addPptHeader(
      slide,
      'Effort Estimate and Variance',
      'Jira Original Estimate, Time Spent and Remaining Estimate normalised to hours',
      page
    );

    const cards = [
      ['Original Estimate', `${effort.originalEstimateHours}h`, palette.blue],
      ['Time Spent', `${effort.timeSpentHours}h`, palette.green],
      ['Remaining Estimate', `${effort.remainingEstimateHours}h`, palette.amber],
      ['Forecast Effort', `${effort.forecastHours}h`, palette.purple],
      ['Effort Variance', `${effort.varianceHours}h`, palette.red],
    ];

    cards.forEach(([label, value, accent], index) => {
      addPptMetricCard(pptx, slide, {
        x: 0.55 + index * 2.5,
        y: 1.25,
        w: 2.25,
        h: 1.15,
        label,
        value,
        helper:
          label === 'Effort Variance'
            ? `${effort.variancePercentage}%`
            : undefined,
        accent,
      });
    });

    const coverage = [
      {
        label: 'Original Estimate Coverage',
        value:
          effort.coverage?.originalEstimateCoveragePercentage ?? 0,
        color: palette.blue,
      },
      {
        label: 'Remaining Estimate Coverage',
        value:
          effort.coverage?.remainingEstimateCoveragePercentage ?? 0,
        color: palette.amber,
      },
      {
        label: 'Time-Spent Coverage',
        value:
          effort.coverage?.timeSpentCoveragePercentage ?? 0,
        color: palette.green,
      },
    ];

    addPptHorizontalBars(pptx, slide, coverage, {
      x: 0.75,
      y: 3.0,
      w: 6.0,
      rowHeight: 0.65,
      labelWidth: 2.65,
      valueWidth: 0.55,
    });

    slide.addShape(pptx.ShapeType.roundRect, {
      x: 7.15,
      y: 2.85,
      w: 5.25,
      h: 2.25,
      rectRadius: 0.06,
      fill: {
        color: effort.forecastProvisional
          ? palette.amberLight
          : palette.greenLight,
      },
      line: {
        color: effort.forecastProvisional
          ? 'F5CD47'
          : '4BCE97',
      },
    });

    addPptText(
      slide,
      effort.forecastProvisional
        ? 'Low estimate confidence'
        : 'Forecast Confidence',
      {
        x: 7.5,
        y: 3.18,
        w: 4.5,
        h: 0.35,
        fontSize: 18,
        bold: true,
        color: effort.forecastProvisional
          ? '7F5F01'
          : '164B35',
      }
    );

    addPptText(
      slide,
      effort.forecastProvisional
        ? 'Remaining Estimate coverage is incomplete. Forecast effort and favourable variance may be understated.'
        : 'Forecast and variance are supported by current remaining-estimate data.',
      {
        x: 7.5,
        y: 3.75,
        w: 4.25,
        h: 0.85,
        fontSize: 11,
        color: palette.grey,
        valign: 'top',
      }
    );
  }

  if (selectedSections.scopeHistory && report.history?.available) {
    const slide = pptx.addSlide();
    const page = pageRef.value++;
    const history = report.history;

    addPptHeader(
      slide,
      'Sprint Scope History',
      'Original commitment, scope movement and estimate revisions reconstructed from Jira history',
      page
    );

    const original = Number(
      history.originalCommitment?.storyPoints ?? 0
    );
    const added = Number(
      history.scopeChange?.addedStoryPoints ?? 0
    );
    const removed = Number(
      history.scopeChange?.removedStoryPoints ?? 0
    );
    const estimateChange = Number(
      history.scopeChange?.estimateChangeStoryPoints ?? 0
    );
    const current = Number(
      report.metrics.committedStoryPoints ?? history.currentScope?.storyPoints ?? 0
    );
    const baselineReliable = original > 0 || current === 0;

    addPptHorizontalBars(
      pptx,
      slide,
      [
        { label: baselineReliable ? 'Original Commitment' : 'Commitment baseline unavailable', value: baselineReliable ? original : 0, color: palette.blue },
        { label: 'Scope Added', value: added, prefix: '+', color: palette.green },
        { label: 'Scope Removed', value: removed, prefix: '−', color: palette.red },
        {
          label: 'Estimate Revisions',
          value: estimateChange,
          prefix: estimateChange > 0 ? '+' : '',
          color: palette.amber,
        },
        { label: 'Current Scope', value: current, color: palette.purple },
      ],
      {
        x: 0.75,
        y: 1.45,
        w: 11.8,
        rowHeight: 0.62,
        labelWidth: 2.2,
        valueWidth: 0.55,
      }
    );

    addPptText(
      slide,
      baselineReliable
        ? `${formatNumber(original)} committed + ${formatNumber(added)} added − ${formatNumber(removed)} removed ${estimateChange >= 0 ? '+' : '−'} ${formatNumber(Math.abs(estimateChange))} estimate revision = ${formatNumber(current)} current ${estimationDisplay.short}`
        : `Current scope: ${formatNumber(current)} ${estimationDisplay.short} · sprint-start commitment baseline unavailable; StatusDeck does not treat the entire sprint as scope added.`,
      {
        x: 0.85,
        y: 4.75,
        w: 11.5,
        h: 0.45,
        fontSize: 12,
        bold: true,
        color: palette.navy,
        align: 'center',
      }
    );

    const historyCards = [
      ['Original Items', history.originalCommitment?.items ?? 0],
      ['Current Items', report.metrics.total ?? history.currentScope?.items ?? 0],
      ['Added Items', history.scopeChange?.addedItems ?? 0],
      ['Removed Items', history.scopeChange?.removedItems ?? 0],
      [`Completed ${estimationDisplay.short}`, report.metrics.completedStoryPoints ?? history.currentScope?.completedStoryPoints ?? 0],
      [`Remaining ${estimationDisplay.short}`, report.metrics.remainingStoryPoints ?? history.currentScope?.remainingStoryPoints ?? 0],
    ];

    historyCards.forEach(([label, value], index) => {
      addPptMetricCard(pptx, slide, {
        x: 0.65 + index * 2.05,
        y: 5.55,
        w: 1.8,
        h: 0.85,
        label,
        value,
        accent: palette.blue,
      });
    });
  }

  if (selectedSections.burndown && report.history?.available) {
    const slide = pptx.addSlide();
    const page = pageRef.value++;

    addPptHeader(
      slide,
      'Sprint Burndown',
      `Daily ${estimationDisplay.noun} burndown compared with the ideal sprint trajectory`,
      page
    );

    addPptBurndown(
      pptx,
      slide,
      report.history.burndownDaily ??
        report.history.burndown ??
        [],
      {
        basis: estimationDisplay.short === 'hours' ? 'effort' : 'points',
      }
    );
  }

  if (selectedSections.statusTypes) {
    const slide = pptx.addSlide();
    const page = pageRef.value++;

    addPptHeader(
      slide,
      'Status and Work-Item Distribution',
      'Current sprint distribution by Jira status, issue type and priority',
      page
    );

    addPptText(slide, 'Issues by Status', {
      x: 0.7,
      y: 1.25,
      w: 2.3,
      h: 0.25,
      fontSize: 12,
      bold: true,
      color: palette.navy,
    });

    addPptHorizontalBars(
      pptx,
      slide,
      Object.entries(report.metrics.statusCounts ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([label, value], index) => ({
          label,
          value,
          color: [
            palette.green,
            palette.blue,
            palette.amber,
            palette.red,
            palette.purple,
          ][index % 5],
        })),
      {
        x: 0.7,
        y: 1.7,
        w: 5.75,
        rowHeight: 0.48,
        labelWidth: 1.7,
        valueWidth: 0.45,
      }
    );

    addPptText(slide, 'Work-Item Types', {
      x: 6.9,
      y: 1.25,
      w: 2.3,
      h: 0.25,
      fontSize: 12,
      bold: true,
      color: palette.navy,
    });

    addPptHorizontalBars(
      pptx,
      slide,
      Object.entries(report.metrics.typeCounts ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([label, value], index) => ({
          label,
          value,
          color: [
            palette.blue,
            palette.amber,
            palette.purple,
            palette.red,
            palette.green,
          ][index % 5],
        })),
      {
        x: 6.9,
        y: 1.7,
        w: 5.75,
        rowHeight: 0.48,
        labelWidth: 1.65,
        valueWidth: 0.45,
      }
    );

    addPptText(slide, 'Priority Profile', {
      x: 0.7,
      y: 4.8,
      w: 2.3,
      h: 0.25,
      fontSize: 12,
      bold: true,
      color: palette.navy,
    });

    addPptHorizontalBars(
      pptx,
      slide,
      Object.entries(getPriorityCounts(filteredIssues))
        .sort((a, b) => b[1] - a[1])
        .map(([label, value], index) => ({
          label,
          value,
          color: [
            palette.red,
            'E34935',
            'F5A524',
            palette.blue,
            palette.green,
          ][index % 5],
        })),
      {
        x: 0.7,
        y: 5.18,
        w: 5.75,
        rowHeight: 0.42,
        labelWidth: 1.7,
        valueWidth: 0.45,
      }
    );
  }

  if (selectedSections.sprintReport) {
    const slide = pptx.addSlide();
    const page = pageRef.value++;

    addPptHeader(
      slide,
      'Sprint Report',
      'Completed and incomplete delivery summary',
      page
    );

    const cards = [
      ['Completed Items', report.sprintReport.completedCount, palette.green],
      ['Incomplete Items', report.sprintReport.incompleteCount, palette.amber],
      [`Completed ${estimationDisplay.short}`, report.sprintReport.completedStoryPoints, palette.green],
      [`Incomplete ${estimationDisplay.short}`, report.sprintReport.incompleteStoryPoints, palette.amber],
    ];

    cards.forEach(([label, value, accent], index) => {
      addPptMetricCard(pptx, slide, {
        x: 0.75 + index * 3.05,
        y: 1.5,
        w: 2.75,
        h: 1.35,
        label,
        value,
        accent,
      });
    });

    addPptText(slide, 'Completion against sprint-start commitment', {
      x: 0.85,
      y: 3.45,
      w: 4.8,
      h: 0.28,
      fontSize: 13,
      bold: true,
      color: palette.navy,
    });

    const reconstructedCommitment = Number(report.history?.originalCommitment?.storyPoints ?? 0);
    const currentScopeForCommitment = Number(report.metrics.committedStoryPoints ?? 0);
    const commitmentReliable = !report.history?.available || reconstructedCommitment > 0 || currentScopeForCommitment === 0;
    const committed = report.history?.available ? reconstructedCommitment : currentScopeForCommitment;

    slide.addShape(pptx.ShapeType.roundRect, {
      x: 0.85,
      y: 4.0,
      w: 10.9,
      h: 0.42,
      rectRadius: 0.06,
      fill: { color: 'E9EDF3' },
      line: { color: 'E9EDF3', transparency: 100 },
    });

    slide.addShape(pptx.ShapeType.roundRect, {
      x: 0.85,
      y: 4.0,
      w:
        10.9 *
        Math.min(
          1,
          Number(report.sprintReport.completedStoryPoints ?? 0) /
            Math.max(1, Number(committed ?? 0))
        ),
      h: 0.42,
      rectRadius: 0.06,
      fill: { color: palette.green },
      line: { color: palette.green, transparency: 100 },
    });

    addPptText(
      slide,
      commitmentReliable
        ? `${formatNumber(report.sprintReport.completedStoryPoints)} completed of ${formatNumber(committed)} committed ${estimationDisplay.short}`
        : `${formatNumber(report.sprintReport.completedStoryPoints)} completed · sprint-start commitment baseline unavailable`,
      {
        x: 0.85,
        y: 4.6,
        w: 6.2,
        h: 0.3,
        fontSize: 12,
        color: palette.grey,
      }
    );
  }

  if (selectedSections.velocity && velocityReport?.velocity?.length) {
    const slide = pptx.addSlide();
    const page = pageRef.value++;

    addPptHeader(
      slide,
      'Velocity & Team Workload',
      `Recent closed sprints · Average completed: ${velocityReport.averageCompleted} ${velocityReport.usesStoryPoints ? estimationDisplay.noun : 'work items'} · capacity and workload on one executive slide`,
      page
    );

    const maximum = Math.max(
      1,
      ...velocityReport.velocity.flatMap((item) => [
        Number(item.committedStoryPoints ?? 0),
        Number(item.completedStoryPoints ?? 0),
      ])
    );

    velocityReport.velocity.forEach((item, index) => {
      const rowY = 1.35 + index * 0.74;
      const trackX = 3.0;
      const trackW = 4.4;

      addPptText(slide, item.sprintName, {
        x: 0.7,
        y: rowY,
        w: 2.1,
        h: 0.22,
        fontSize: 9,
        bold: true,
        color: palette.navy,
      });

      addPptText(slide, 'Committed', {
        x: 2.15,
        y: rowY - 0.02,
        w: 0.8,
        h: 0.18,
        fontSize: 7,
        color: palette.grey,
        align: 'right',
      });

      slide.addShape(pptx.ShapeType.roundRect, {
        x: trackX,
        y: rowY,
        w: trackW,
        h: 0.12,
        rectRadius: 0.03,
        fill: { color: 'E9EDF3' },
        line: { color: 'E9EDF3', transparency: 100 },
      });

      slide.addShape(pptx.ShapeType.roundRect, {
        x: trackX,
        y: rowY,
        w:
          trackW *
          Number(item.committedStoryPoints ?? 0) /
          maximum,
        h: 0.12,
        rectRadius: 0.03,
        fill: { color: palette.blue },
        line: { color: palette.blue, transparency: 100 },
      });

      addPptText(slide, 'Completed', {
        x: 2.15,
        y: rowY + 0.23,
        w: 0.8,
        h: 0.18,
        fontSize: 7,
        color: palette.grey,
        align: 'right',
      });

      slide.addShape(pptx.ShapeType.roundRect, {
        x: trackX,
        y: rowY + 0.25,
        w: trackW,
        h: 0.12,
        rectRadius: 0.03,
        fill: { color: 'E9EDF3' },
        line: { color: 'E9EDF3', transparency: 100 },
      });

      slide.addShape(pptx.ShapeType.roundRect, {
        x: trackX,
        y: rowY + 0.25,
        w:
          trackW *
          Number(item.completedStoryPoints ?? 0) /
          maximum,
        h: 0.12,
        rectRadius: 0.03,
        fill: { color: palette.green },
        line: { color: palette.green, transparency: 100 },
      });

      addPptText(
        slide,
        `${formatNumber(item.committedStoryPoints)} / ${formatNumber(
          item.completedStoryPoints
        )}`,
        {
          x: 7.55,
          y: rowY + 0.07,
          w: 0.85,
          h: 0.22,
          fontSize: 8,
          bold: true,
          color: palette.navy,
          align: 'right',
        }
      );
    });

    const compactPeople = (report.metrics.workload ?? []).slice(0, 8);
    addPptText(slide, 'Team Workload', { x: 8.65, y: 1.15, w: 2.4, h: 0.28, fontSize: 12, bold: true, color: palette.navy });
    const maxWorkload = Math.max(1, ...compactPeople.map((person) => Number(person.storyPoints ?? 0)));
    compactPeople.forEach((person, index) => {
      const y = 1.55 + index * 0.55;
      addPptText(slide, person.name, { x: 8.65, y, w: 2.0, h: 0.2, fontSize: 7.5, bold: true, color: palette.navy });
      slide.addShape(pptx.ShapeType.roundRect, { x: 10.55, y: y + 0.03, w: 1.8, h: 0.13, rectRadius: 0.03, fill: { color: 'E4E9EF' }, line: { color: 'E4E9EF', transparency: 100 } });
      slide.addShape(pptx.ShapeType.roundRect, { x: 10.55, y: y + 0.03, w: 1.8 * Number(person.storyPoints ?? 0) / maxWorkload, h: 0.13, rectRadius: 0.03, fill: { color: palette.blue }, line: { color: palette.blue, transparency: 100 } });
      addPptText(slide, `${formatNumber(person.storyPoints)} · ${formatNumber(person.remainingStoryPoints)} rem`, { x: 10.55, y: y + .18, w: 1.8, h: .18, fontSize: 6.5, color: palette.grey, align: 'right' });
    });
  }

  if (selectedSections.teamWorkload && !(selectedSections.velocity && velocityReport?.velocity?.length)) {
    const slide = pptx.addSlide();
    const page = pageRef.value++;
    const people = report.metrics.workload ?? [];
    const maxPoints = Math.max(
      1,
      ...people.map((person) => Number(person.storyPoints ?? 0))
    );

    addPptHeader(
      slide,
      'Team Workload',
      `Assignee-level ${estimationDisplay.noun} load, remaining work and overdue items`,
      page
    );

    people.slice(0, 12).forEach((person, index) => {
      const y = 1.3 + index * 0.43;
      const completed = Math.max(
        0,
        Number(person.storyPoints ?? 0) -
          Number(person.remainingStoryPoints ?? 0)
      );
      const remaining = Number(
        person.remainingStoryPoints ?? 0
      );
      const trackX = 3.1;
      const trackW = 7.4;

      addPptText(slide, person.name, {
        x: 0.7,
        y,
        w: 2.15,
        h: 0.2,
        fontSize: 8.5,
        bold: true,
        color: palette.navy,
      });

      slide.addShape(pptx.ShapeType.roundRect, {
        x: trackX,
        y: y + 0.03,
        w: trackW,
        h: 0.13,
        rectRadius: 0.03,
        fill: { color: 'E9EDF3' },
        line: { color: 'E9EDF3', transparency: 100 },
      });

      if (completed > 0) {
        slide.addShape(pptx.ShapeType.roundRect, {
          x: trackX,
          y: y + 0.03,
          w: trackW * completed / maxPoints,
          h: 0.13,
          rectRadius: 0.03,
          fill: { color: palette.green },
          line: { color: palette.green, transparency: 100 },
        });
      }

      if (remaining > 0) {
        slide.addShape(pptx.ShapeType.rect, {
          x: trackX + trackW * completed / maxPoints,
          y: y + 0.03,
          w: trackW * remaining / maxPoints,
          h: 0.13,
          fill: { color: palette.amber },
          line: { color: palette.amber, transparency: 100 },
        });
      }

      addPptText(slide, formatNumber(person.storyPoints), {
        x: 10.65,
        y,
        w: 0.45,
        h: 0.2,
        fontSize: 8.5,
        bold: true,
        color: palette.navy,
        align: 'right',
      });

      addPptText(
        slide,
        `${formatNumber(person.remainingStoryPoints)} remaining`,
        {
          x: 11.2,
          y,
          w: 1.0,
          h: 0.2,
          fontSize: 7,
          color: palette.grey,
          align: 'right',
        }
      );
    });
  }

  if (selectedSections.changeLog && report.history?.events?.length) {
    addPptTableSlides({
      pptx,
      title: 'Scope, Estimate and Effort Changes',
      subtitle: `Executive change summary · ${report.history.events.length} Jira history events detected · showing 5 latest/material entries`,
      headers: ['Date', 'Key', 'Change'],
      rows: [...report.history.events].slice(0, 5)
        .sort(
          (a, b) =>
            new Date(b.time).getTime() -
            new Date(a.time).getTime()
        )
        .map((event) => {
          let description = event.type;

          if (event.type === 'scope-added') {
            description = `Added to sprint · ${formatNumber(
              event.storyPoints
            )} points`;
          } else if (event.type === 'scope-removed') {
            description = `Removed from sprint · ${formatNumber(
              event.storyPoints
            )} points`;
          } else if (event.type === 'estimate-changed') {
            description = `Story points ${formatNumber(
              event.beforeEstimate
            )} → ${formatNumber(event.afterEstimate)}`;
          } else if (
            event.type === 'original-estimate-changed'
          ) {
            description = `Original estimate ${formatHours(
              event.beforeHours
            )} → ${formatHours(event.afterHours)}`;
          } else if (
            event.type === 'remaining-estimate-changed'
          ) {
            description = `Remaining estimate ${formatHours(
              event.beforeHours
            )} → ${formatHours(event.afterHours)}`;
          } else if (event.type === 'time-spent-changed') {
            description = `Time spent ${formatHours(
              event.beforeHours
            )} → ${formatHours(event.afterHours)}`;
          } else if (event.type === 'status-changed') {
            description = `Status ${event.beforeStatus ?? 'Unknown'} → ${
              event.afterStatus ?? 'Unknown'
            }`;
          }

          return [
            formatShortDate(event.time, true),
            event.key,
            description,
          ];
        }),
      columnWidths: [1.45, 1.15, 9.6],
      rowsPerSlide: 5,
      pageRef,
    });
  }

  if (selectedSections.workItems && filteredIssues.length) {
    addPptTableSlides({
      pptx,
      title: 'Sprint Work Items',
      subtitle: `${filteredIssues.length} items in the selected report scope`,
      headers: [
        'Key',
        'Summary',
        'Type',
        'Status',
        'SP',
        'Original',
        'Spent',
        'Remaining',
        'Assignee',
        'Due',
      ],
      rows: filteredIssues.map((issue) => [
        issue.key,
        issue.summary,
        issue.issueType,
        issue.status,
        String(formatNumber(issue.storyPoints)),
        formatHours(issue.originalEstimateHours),
        formatHours(issue.timeSpentHours),
        formatHours(issue.remainingEstimateHours),
        issue.assignee,
        formatDate(issue.dueDate),
      ]),
      columnWidths: [
        0.85,
        3.1,
        0.85,
        1.05,
        0.4,
        0.65,
        0.55,
        0.7,
        1.45,
        1.05,
      ],
      rowsPerSlide: 13,
      pageRef,
    });
  }

  return pptx;
}

function pdfAscii(value) {
  if (Array.isArray(value)) {
    return value.map((item) => pdfAscii(item));
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value !== 'string') {
    return value;
  }

  return value
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2212]/g, '-')
    .replace(/[\u2190\u2192\u21d2]/g, '->')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2022\u25cf\u25aa]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

function enablePdfSafeText(doc) {
  const originalText = doc.text.bind(doc);

  doc.text = (text, ...args) =>
    originalText(pdfAscii(text), ...args);
}

function addPdfFinalFooters(doc) {
  const totalPages = doc.getNumberOfPages();

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
    doc.setPage(pageNumber);
    pdfSetText(doc, [83, 98, 115], 6.5, 'normal');
    doc.text(
      'Executive Sprint Reporting | by QTI Labs',
      10,
      204
    );
    doc.text(
      `${pageNumber} / ${totalPages}`,
      287,
      204,
      { align: 'right' }
    );
  }
}

function pdfNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function pdfSetText(doc, color, size = 10, style = 'normal') {
  const safeColor = Array.isArray(color)
    ? color.map((value) =>
        Math.max(0, Math.min(255, Number(value) || 0))
      )
    : [16, 42, 67];

  doc.setTextColor(...safeColor);
  doc.setFont('helvetica', style);
  doc.setFontSize(Number(size) || 10);
}

function pdfAddPageHeader(doc, title, subtitle, pageNumber) {
  doc.setFillColor(12, 102, 228);
  doc.rect(0, 0, 297, 3, 'F');

  pdfSetText(doc, [16, 42, 67], 18, 'bold');
  doc.text(title, 12, 15);

  if (subtitle) {
    pdfSetText(doc, [83, 98, 115], 8, 'normal');
    doc.text(subtitle, 12, 21);
  }

}

function pdfMetricCard(
  doc,
  {
    x,
    y,
    w,
    h,
    label,
    value,
    helper,
    accent = [36, 87, 166],
  }
) {
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(217, 226, 236);
  doc.roundedRect(x, y, w, h, 2.5, 2.5, 'FD');

  doc.setFillColor(...accent);
  doc.rect(x, y, 1.6, h, 'F');

  pdfSetText(doc, [83, 98, 115], 6.5, 'bold');
  doc.text(String(label), x + 4, y + 6.2);

  pdfSetText(doc, [16, 42, 67], 17, 'bold');
  doc.text(String(value), x + 4, y + 15.5);

  if (helper) {
    pdfSetText(doc, [83, 98, 115], 6.2, 'normal');
    doc.text(
      doc.splitTextToSize(String(helper), w - 7),
      x + 4,
      y + h - 4.5
    );
  }
}

function pdfHorizontalBars(
  doc,
  entries,
  {
    x,
    y,
    w,
    rowHeight = 9,
    labelWidth = 42,
    colors = [],
  }
) {
  const maximum = Math.max(
    1,
    ...entries.map((entry) => Math.abs(Number(entry.value ?? 0)))
  );

  entries.forEach((entry, index) => {
    const rowY = y + index * rowHeight;
    const barX = x + labelWidth;
    const barW = w - labelWidth - 12;

    pdfSetText(doc, [68, 84, 111], 7, 'normal');
    doc.text(String(entry.label), x, rowY + 3);

    doc.setFillColor(237, 240, 245);
    doc.roundedRect(barX, rowY, barW, 3, 1.2, 1.2, 'F');

    const color =
      entry.color ??
      colors[index % colors.length] ??
      [36, 87, 166];

    doc.setFillColor(...color);
    doc.roundedRect(
      barX,
      rowY,
      Math.max(
        1,
        barW *
          Math.abs(Number(entry.value ?? 0)) /
          maximum
      ),
      3,
      1.2,
      1.2,
      'F'
    );

    pdfSetText(doc, [16, 42, 67], 7, 'bold');
    doc.text(
      `${entry.prefix ?? ''}${formatNumber(entry.value)}`,
      x + w,
      rowY + 3,
      { align: 'right' }
    );
  });
}

// Keep the PDF ideal trajectory consistent with the PowerPoint:
// zero remaining work at the sprint end date.
function pdfBurndown(
  doc,
  points,
  {
    x = 20,
    y = 35,
    w = 255,
    h = 130,
    basis = 'points',
  } = {}
) {
  const rows = Array.isArray(points)
    ? points.filter((point) => point?.timestamp)
    : [];

  if (rows.length < 2) {
    pdfSetText(doc, [83, 98, 115], 12, 'normal');
    doc.text('Burndown data is not available.', 148.5, 100, {
      align: 'center',
    });
    return;
  }

  const actualKey =
    basis === 'effort'
      ? 'remainingEffortHours'
      : 'remainingPoints';

  const idealKey =
    basis === 'effort'
      ? 'idealRemainingEffortHours'
      : 'idealRemainingPoints';

  const maximum = Math.max(
    1,
    ...rows.flatMap((point) => [
      Number(point[actualKey] ?? 0),
      Number(point[idealKey] ?? 0),
    ])
  );

  const left = x + 14;
  const top = y;
  const chartW = w - 18;
  const chartH = h - 15;

  for (let index = 0; index <= 5; index += 1) {
    const gy = top + chartH * index / 5;

    doc.setDrawColor(217, 226, 236);
    doc.setLineWidth(0.25);
    doc.line(left, gy, left + chartW, gy);

    pdfSetText(doc, [83, 98, 115], 6, 'normal');
    doc.text(
      String(formatNumber(maximum * (1 - index / 5))),
      left - 3,
      gy + 1.5,
      { align: 'right' }
    );
  }

  doc.setDrawColor(98, 111, 134);
  doc.setLineWidth(0.4);
  doc.line(left, top, left, top + chartH);
  doc.line(left, top + chartH, left + chartW, top + chartH);

  function position(point, index, key) {
    const value =
      key === idealKey && index === rows.length - 1
        ? 0
        : Number(point[key] ?? 0);

    return {
      x:
        left +
        chartW *
          index /
          Math.max(1, rows.length - 1),
      y:
        top +
        chartH -
        value /
          maximum *
          chartH,
    };
  }

  doc.setLineWidth(0.8);

  for (let index = 1; index < rows.length; index += 1) {
    const previousActual = position(
      rows[index - 1],
      index - 1,
      actualKey
    );
    const currentActual = position(
      rows[index],
      index,
      actualKey
    );
    const previousIdeal = position(
      rows[index - 1],
      index - 1,
      idealKey
    );
    const currentIdeal = position(
      rows[index],
      index,
      idealKey
    );

    doc.setDrawColor(227, 73, 53);
    doc.line(
      previousActual.x,
      previousActual.y,
      currentActual.x,
      previousActual.y
    );
    doc.line(
      currentActual.x,
      previousActual.y,
      currentActual.x,
      currentActual.y
    );

    doc.setDrawColor(91, 143, 103);
    doc.line(
      previousIdeal.x,
      previousIdeal.y,
      currentIdeal.x,
      currentIdeal.y
    );
  }

  [
    0,
    Math.floor((rows.length - 1) / 2),
    rows.length - 1,
  ].forEach((index) => {
    const px =
      left +
      chartW *
        index /
        Math.max(1, rows.length - 1);

    pdfSetText(doc, [83, 98, 115], 6.5, 'normal');
    doc.text(
      formatShortDate(rows[index].timestamp),
      px,
      top + chartH + 7,
      {
        align:
          index === 0
            ? 'left'
            : index === rows.length - 1
              ? 'right'
              : 'center',
      }
    );
  });
}


async function createProjectPowerPoint({ projectReport, projectView, projectCommentaryText, customKpiResults = [] }) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'QTI Labs';
  pptx.subject = 'StatusDeck Project / Program Report';
  pptx.title = `${projectReport.projectName} Project / Program Report`;
  pptx.company = 'QTI Labs';

  const palette = getExportPalette();
  let page = 1;
  const addHeader = (slide, title, subtitle = '') => {
    const currentPage = page++;
    slide.addShape(pptx.ShapeType.rect, {
      x: 0, y: 0, w: 13.333, h: 0.18,
      fill: { color: palette.blue },
      line: { color: palette.blue, transparency: 100 },
    });
    addPptText(slide, title, {
      x: 0.55, y: 0.38, w: 8.8, h: 0.4,
      fontSize: 23, bold: true, color: palette.navy,
    });
    if (subtitle) {
      addPptText(slide, subtitle, {
        x: 0.58, y: 0.84, w: 10.8, h: 0.25,
        fontSize: 10, color: palette.grey,
      });
    }
    addPptText(slide, 'Executive Project & Program Reporting · by QTI Labs', {
      x: 0.55, y: 7.18, w: 6.4, h: 0.16,
      fontSize: 7.5, color: palette.grey,
    });
    addPptText(slide, String(currentPage), {
      x: 12.3, y: 7.18, w: 0.45, h: 0.16,
      fontSize: 7.5, color: palette.grey, align: 'right',
    });
  };
  const ragColor = projectView.rag.label === 'RED'
    ? palette.red
    : projectView.rag.label === 'AMBER'
      ? palette.amber
      : palette.green;

  const narrative = buildProjectManagementNarrative(projectReport, DEFAULT_REPORTING_SETTINGS);
  const commentaryText = String(
    projectCommentaryText ||
    projectNarrativeText(projectReport, DEFAULT_REPORTING_SETTINGS)
  ).trim();
  const commentary = parseManagementCommentaryForExport(commentaryText, narrative);
  const usableCustomKpis = (customKpiResults ?? []).filter((kpi) => {
    if (!kpi || kpi.error) return false;
    const numericValue = Number(kpi.value ?? kpi.matchedIssues ?? 0);
    const hasPositiveValue = Number.isFinite(numericValue) && numericValue > 0;
    const hasBreakdown = Array.isArray(kpi.breakdown)
      ? kpi.breakdown.some((item) => Number(item?.value ?? item?.count ?? 0) > 0)
      : Array.isArray(kpi.groups)
        ? kpi.groups.some((item) => Number(item?.value ?? item?.count ?? 0) > 0)
        : false;
    const hasTimeSeries = Array.isArray(kpi.timeSeries) && kpi.timeSeries.some((point) =>
      Object.entries(point ?? {}).some(([key, value]) =>
        key !== 'label' && key !== 'date' && key !== 'timestamp' && Number(value) > 0
      )
    );
    return hasPositiveValue || hasBreakdown || hasTimeSeries;
  });

  const addPanel = (slide, { x, y, w, h, title, items, accent = palette.blue, emptyText = 'No current exceptions.' }) => {
    slide.addShape(pptx.ShapeType.roundRect, {
      x, y, w, h,
      rectRadius: 0.05,
      fill: { color: palette.white },
      line: { color: palette.border, pt: 0.8 },
    });
    slide.addShape(pptx.ShapeType.rect, {
      x, y, w: 0.06, h,
      fill: { color: accent },
      line: { color: accent, transparency: 100 },
    });
    addPptText(slide, title, {
      x: x + 0.2, y: y + 0.14, w: w - 0.35, h: 0.25,
      fontSize: 10, bold: true, color: palette.navy,
    });
    const rows = (items?.length ? items : [emptyText]).slice(0, 5);
    addPptText(slide, rows.map((item) => `• ${item}`).join('\n'), {
      x: x + 0.2, y: y + 0.5, w: w - 0.4, h: h - 0.65,
      fontSize: 8.2, color: palette.grey, breakLine: true, valign: 'top',
    });
  };

  let slide = pptx.addSlide();
  slide.background = { color: palette.greyLight };
  addHeader(slide, projectReport.projectName, 'PROJECT / PROGRAM REPORT');
  addPptText(slide, `Overall RAG  ${projectView.rag.label}`, {
    x: 0.72, y: 1.15, w: 4.2, h: 0.55,
    fontSize: 28, bold: true, color: ragColor,
  });
  addPptText(slide, `${projectView.teams.length} included Scrum team${projectView.teams.length === 1 ? '' : 's'} · current cross-team Jira delivery view`, {
    x: 0.75, y: 1.75, w: 8.5, h: 0.28,
    fontSize: 9.5, color: palette.grey,
  });

  const coverCards = [
    ['Mean Completion', `${projectView.meanCompletion}%`, palette.blue, `${projectView.teamsOnTrack}/${projectView.teams.length} teams Green`],
    ['Teams at Risk', projectView.teamsAtRisk, projectView.teamsAtRisk ? palette.amber : palette.green, `${projectView.rag.counts.RED} Red · ${projectView.rag.counts.AMBER} Amber`],
    ['Open Work', projectView.open, palette.blue, `${projectView.totalItems} Jira items in scope`],
    ['Unresolved Defects', projectView.unresolvedDefects, projectView.unresolvedDefects ? palette.red : palette.green, 'Across current reporting scope'],
    ['Overdue Work', projectView.overdue, projectView.overdue ? palette.amber : palette.green, 'Open items past due date'],
    ['Blocked / Impeded', projectView.blocked, projectView.blocked ? palette.red : palette.green, 'Blocked / waiting statuses'],
    ['Scope Growth Teams', projectView.scopeIncreasedTeams, projectView.scopeIncreasedTeams ? palette.amber : palette.green, projectView.scopeBaselineUnavailableTeams ? `${projectView.scopeBaselineUnavailableTeams} baseline unavailable` : 'Against sprint-start baseline'],
    ['Forecast-Ready Teams', `${projectView.forecastReadyTeams}/${projectView.teams.length}`, projectView.forecastAttentionTeams ? palette.amber : palette.green, 'Non-provisional effort forecast'],
  ];
  coverCards.forEach((card, index) => {
    const col = index % 4;
    const row = Math.floor(index / 4);
    addPptMetricCard(pptx, slide, {
      x: 0.62 + col * 3.12,
      y: 2.35 + row * 1.55,
      w: 2.82,
      h: 1.25,
      label: card[0],
      value: card[1],
      helper: card[3],
      accent: card[2],
    });
  });
  addPptText(slide, `Open Epics: ${projectView.openEpics.length} · Active/planned Jira versions: ${projectView.versions.length} · Work-type categories: ${Object.keys(projectView.typeCounts ?? {}).length}`, {
    x: 0.72, y: 5.75, w: 11.8, h: 0.3, fontSize: 8.7, color: palette.grey,
  });

  slide = pptx.addSlide();
  addHeader(slide, 'Management Commentary', 'Executive interpretation generated from the current Jira project/team analysis');
  addPptText(slide, `Project Status: ${projectView.rag.label === 'RED' ? 'At Risk' : projectView.rag.label === 'AMBER' ? 'Watch Closely' : 'On Track'}`, {
    x: 0.7, y: 1.08, w: 4, h: 0.32, fontSize: 16, bold: true, color: ragColor,
  });
  addPptText(slide, `${projectView.meanCompletion}% mean completion · ${projectView.open} open · ${projectView.overdue} overdue · ${projectView.unresolvedDefects} defects · ${projectView.blocked} blocked`, {
    x: 4.75, y: 1.12, w: 7.8, h: 0.24, fontSize: 8.8, color: palette.grey, align: 'right',
  });
  addPanel(slide, { x: 0.65, y: 1.55, w: 6.0, h: 2.2, title: 'Executive Summary', items: commentary.summary, accent: palette.blue, emptyText: 'No generated project summary is available.' });
  addPanel(slide, { x: 6.78, y: 1.55, w: 5.9, h: 2.2, title: 'Key Risks', items: commentary.risks, accent: palette.red, emptyText: 'No project-level risk currently breaches configured thresholds.' });
  addPanel(slide, { x: 0.65, y: 3.95, w: 6.0, h: 2.2, title: 'Recommended Actions', items: commentary.actions, accent: palette.amber, emptyText: 'Continue current delivery controls.' });
  addPanel(slide, { x: 6.78, y: 3.95, w: 5.9, h: 2.2, title: 'Release / Milestone Outlook', items: commentary.outlook, accent: palette.green, emptyText: 'No unreleased Jira milestone is available.' });

  slide = pptx.addSlide();
  addHeader(
    slide,
    'Cross-Team Delivery Health',
    `${projectView.teams.length} included Scrum ${projectView.teams.length === 1 ? 'board' : 'boards'} · completion and RAG remain team-level signals`
  );
  if (projectView.teams.length === 1) {
    const team = projectView.teams[0];
    const metrics = team.report?.metrics ?? {};
    const teamRagColor = team.rag.label === 'RED' ? palette.red : team.rag.label === 'AMBER' ? palette.amber : palette.green;
    slide.addShape(pptx.ShapeType.roundRect, {
      x: 0.68, y: 1.28, w: 12.0, h: 1.0,
      rectRadius: 0.05, fill: { color: palette.white },
      line: { color: palette.border, pt: 0.8 },
    });
    slide.addShape(pptx.ShapeType.rect, {
      x: 0.68, y: 1.28, w: 0.08, h: 1.0,
      fill: { color: teamRagColor }, line: { color: teamRagColor, transparency: 100 },
    });
    addPptText(slide, team.board.name, { x: 0.95, y: 1.48, w: 4.5, h: 0.26, fontSize: 17, bold: true, color: palette.navy });
    addPptText(slide, team.sprint?.name || 'No sprint', { x: 0.95, y: 1.82, w: 4.5, h: 0.2, fontSize: 8.5, color: palette.grey });
    addPptText(slide, team.rag.label, { x: 10.75, y: 1.48, w: 1.4, h: 0.28, fontSize: 15, bold: true, color: teamRagColor, align: 'right' });

    const singleTeamCards = [
      ['Completion', `${formatNumber(team.completion)}%`, palette.blue, `${formatNumber(metrics.completedStoryPoints ?? 0)} completed / ${formatNumber(metrics.committedStoryPoints ?? 0)} scope`],
      ['Open Work', formatNumber(metrics.open ?? 0), palette.blue, 'Current reporting sprint'],
      ['Overdue', formatNumber(team.overdue), team.overdue ? palette.amber : palette.green, team.overdue ? 'Needs owner/date review' : 'No overdue open work'],
      ['Defects', formatNumber(team.unresolvedDefects), team.unresolvedDefects ? palette.red : palette.green, 'Unresolved bug / defect items'],
      ['Blocked', formatNumber(team.blocked), team.blocked ? palette.red : palette.green, 'Blocked / waiting statuses'],
      ['Velocity', formatNumber(team.velocity?.averageCompleted ?? 0), palette.blue, `${team.report?.estimationSource?.unit ?? 'team units'} recent average`],
    ];
    singleTeamCards.forEach((card, index) => {
      const col = index % 3;
      const row = Math.floor(index / 3);
      addPptMetricCard(pptx, slide, {
        x: 0.68 + col * 4.05,
        y: 2.65 + row * 1.58,
        w: 3.72,
        h: 1.3,
        label: card[0], value: card[1], helper: card[3], accent: card[2],
      });
    });
    addPptText(slide, team.rag.reason || 'Within configured reporting thresholds.', {
      x: 0.78, y: 5.98, w: 11.8, h: 0.34,
      fontSize: 9.5, bold: true, color: teamRagColor,
    });
  } else {
    const completionEntries = projectView.teams.slice(0, 10).map((team) => ({
      label: team.board.name,
      value: Number(team.completion ?? 0),
      color: team.rag.label === 'RED' ? palette.red : team.rag.label === 'AMBER' ? palette.amber : palette.green,
    }));
    addPptHorizontalBars(pptx, slide, completionEntries, {
      x: 0.65, y: 1.28, w: 5.9, h: 4.9,
      labelWidth: 2.0, valueWidth: 0.65,
    });
    addPptText(slide, 'Team exceptions', {
      x: 6.85, y: 1.28, w: 2.2, h: 0.25, fontSize: 10, bold: true, color: palette.navy,
    });
    projectView.teams.slice(0, 9).forEach((team, index) => {
      const y = 1.72 + index * 0.5;
      addPptText(slide, team.board.name, { x: 6.85, y, w: 2.2, h: 0.2, fontSize: 8.5, bold: true, color: palette.navy });
      addPptText(slide, team.rag.label, { x: 9.0, y, w: 0.75, h: 0.2, fontSize: 8, bold: true, color: team.rag.label === 'RED' ? palette.red : team.rag.label === 'AMBER' ? palette.amber : palette.green });
      addPptText(slide, `${formatNumber(team.report?.metrics?.open ?? 0)} open · ${formatNumber(team.overdue)} overdue · ${formatNumber(team.unresolvedDefects)} defects · ${formatNumber(team.blocked)} blocked`, {
        x: 9.78, y, w: 2.9, h: 0.2, fontSize: 7.3, color: palette.grey,
      });
    });
  }

  slide = pptx.addSlide();
  addHeader(slide, 'Scope, Forecast & Predictability', 'Scope movement and effort-confidence signals by team');
  const scopeRows = projectView.teams.filter((team) => team.hasScopeBaseline).slice(0, 10);
  if (projectView.teams.length === 1) {
    const team = projectView.teams[0];
    const delta = Number(team.scopeDeltaPercentage ?? 0);
    const ready = !team.report?.metrics?.effort?.forecastProvisional &&
      Number(team.remainingCoverage ?? 0) >= Number(projectView.minimumRemainingCoverage ?? 80);
    const scopeAccent = delta > 0 ? palette.amber : delta < 0 ? palette.blue : palette.green;
    const forecastAccent = ready ? palette.green : palette.amber;

    slide.addShape(pptx.ShapeType.roundRect, {
      x: 0.7, y: 1.35, w: 5.85, h: 4.75,
      rectRadius: 0.06, fill: { color: palette.white }, line: { color: palette.border, pt: 0.8 },
    });
    slide.addShape(pptx.ShapeType.rect, {
      x: 0.7, y: 1.35, w: 0.08, h: 4.75,
      fill: { color: scopeAccent }, line: { color: scopeAccent, transparency: 100 },
    });
    addPptText(slide, 'Scope Change', { x: 1.0, y: 1.7, w: 2.4, h: 0.25, fontSize: 13, bold: true, color: palette.navy });
    addPptText(slide, team.hasScopeBaseline ? `${delta > 0 ? '+' : ''}${formatNumber(delta)}%` : '—', {
      x: 1.0, y: 2.15, w: 2.8, h: 0.6, fontSize: 34, bold: true, color: scopeAccent,
    });
    addPptText(slide, team.hasScopeBaseline
      ? `${formatNumber(team.originalItems ?? 0)} → ${formatNumber(team.currentItems ?? 0)} Jira items`
      : 'Reliable sprint-start scope baseline unavailable', {
        x: 1.0, y: 2.9, w: 4.8, h: 0.3, fontSize: 11, color: palette.grey,
      });
    addPptText(slide, delta > 0
      ? 'Scope increased after the sprint-start baseline. Validate additions and delivery expectations.'
      : delta < 0
        ? 'Scope decreased from the sprint-start baseline.'
        : 'Current item scope remains aligned to the sprint-start baseline.', {
        x: 1.0, y: 3.55, w: 4.8, h: 1.0, fontSize: 11, color: palette.navy, breakLine: true,
      });

    slide.addShape(pptx.ShapeType.roundRect, {
      x: 6.78, y: 1.35, w: 5.85, h: 4.75,
      rectRadius: 0.06, fill: { color: palette.white }, line: { color: palette.border, pt: 0.8 },
    });
    slide.addShape(pptx.ShapeType.rect, {
      x: 6.78, y: 1.35, w: 0.08, h: 4.75,
      fill: { color: forecastAccent }, line: { color: forecastAccent, transparency: 100 },
    });
    addPptText(slide, 'Forecast Confidence', { x: 7.08, y: 1.7, w: 2.8, h: 0.25, fontSize: 13, bold: true, color: palette.navy });
    addPptText(slide, ready ? 'READY' : 'PROVISIONAL', {
      x: 7.08, y: 2.15, w: 3.8, h: 0.55, fontSize: 28, bold: true, color: forecastAccent,
    });
    addPptText(slide, `${formatNumber(team.remainingCoverage ?? 0)}% Remaining Estimate coverage`, {
      x: 7.08, y: 2.9, w: 4.8, h: 0.3, fontSize: 11, color: palette.grey,
    });
    addPptText(slide, ready
      ? `Meets the configured ${formatNumber(projectView.minimumRemainingCoverage ?? 80)}% coverage threshold and is not marked provisional.`
      : `Does not yet meet the configured ${formatNumber(projectView.minimumRemainingCoverage ?? 80)}% coverage threshold or the effort forecast is provisional.`, {
        x: 7.08, y: 3.55, w: 4.8, h: 1.0, fontSize: 11, color: palette.navy, breakLine: true,
      });
    addPptText(slide, team.board.name, { x: 0.9, y: 6.35, w: 11.5, h: 0.22, fontSize: 8.5, color: palette.grey, align: 'center' });
  } else {
    addPptText(slide, 'Scope change from sprint-start item baseline', { x: 0.65, y: 1.2, w: 5.9, h: 0.24, fontSize: 10, bold: true, color: palette.navy });
    scopeRows.forEach((team, index) => {
      const y = 1.62 + index * 0.47;
      const delta = Number(team.scopeDeltaPercentage ?? 0);
      addPptText(slide, team.board.name, { x: 0.65, y, w: 2.1, h: 0.2, fontSize: 8.3, bold: true, color: palette.navy });
      addPptText(slide, `${delta > 0 ? '+' : ''}${formatNumber(delta)}%`, { x: 2.8, y, w: 0.8, h: 0.2, fontSize: 8.3, bold: true, color: delta > 0 ? palette.amber : delta < 0 ? palette.blue : palette.green });
      addPptText(slide, `${formatNumber(team.originalItems ?? 0)} → ${formatNumber(team.currentItems ?? 0)} items`, { x: 3.6, y, w: 2.4, h: 0.2, fontSize: 8, color: palette.grey });
    });
    if (!scopeRows.length) addPptText(slide, 'No reliable sprint-start scope baseline is available for the included teams.', { x: 0.7, y: 1.75, w: 5.7, h: 0.5, fontSize: 9, color: palette.grey });

    addPptText(slide, 'Forecast confidence', { x: 6.85, y: 1.2, w: 2.2, h: 0.24, fontSize: 10, bold: true, color: palette.navy });
    projectView.teams.slice(0, 10).forEach((team, index) => {
      const y = 1.62 + index * 0.47;
      const ready = !team.report?.metrics?.effort?.forecastProvisional && Number(team.remainingCoverage ?? 0) >= Number(projectView.minimumRemainingCoverage ?? 80);
      addPptText(slide, team.board.name, { x: 6.85, y, w: 2.25, h: 0.2, fontSize: 8.3, bold: true, color: palette.navy });
      addPptText(slide, ready ? 'Ready' : 'Provisional', { x: 9.1, y, w: 1.0, h: 0.2, fontSize: 8, bold: true, color: ready ? palette.green : palette.amber });
      addPptText(slide, `${formatNumber(team.remainingCoverage ?? 0)}% remaining-estimate coverage`, { x: 10.1, y, w: 2.5, h: 0.2, fontSize: 7.3, color: palette.grey });
    });
  }

  slide = pptx.addSlide();
  addHeader(slide, 'Operational Flow & Workload', 'Current Jira status, work type and assignee signals');
  const statusEntries = Object.entries(projectView.statusCounts ?? {}).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 8).map(([label, value]) => ({ label, value: Number(value), color: palette.blue }));
  const typeEntries = Object.entries(projectView.typeCounts ?? {}).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 8).map(([label, value]) => ({ label, value: Number(value), color: palette.purple ?? palette.blue }));
  addPptText(slide, 'Status Distribution', { x: 0.65, y: 1.18, w: 2, h: 0.24, fontSize: 10, bold: true, color: palette.navy });
  addPptHorizontalBars(pptx, slide, statusEntries, { x: 0.65, y: 1.55, w: 5.9, h: 2.15, labelWidth: 2.0, valueWidth: 0.5 });
  addPptText(slide, 'Work Type Distribution', { x: 6.85, y: 1.18, w: 2.4, h: 0.24, fontSize: 10, bold: true, color: palette.navy });
  addPptHorizontalBars(pptx, slide, typeEntries, { x: 6.85, y: 1.55, w: 5.8, h: 2.15, labelWidth: 2.0, valueWidth: 0.5 });
  addPptText(slide, 'Highest Open Workload', { x: 0.65, y: 4.0, w: 2.5, h: 0.24, fontSize: 10, bold: true, color: palette.navy });
  projectView.workload.slice(0, 8).forEach((person, index) => {
    const col = index % 4;
    const row = Math.floor(index / 4);
    addPptMetricCard(pptx, slide, {
      x: 0.65 + col * 3.02,
      y: 4.42 + row * 1.08,
      w: 2.72,
      h: 0.86,
      label: person.name,
      value: person.open,
      helper: person.overdue ? `${person.overdue} overdue` : 'open items',
      accent: person.overdue ? palette.amber : palette.blue,
    });
  });

  slide = pptx.addSlide();
  addHeader(slide, 'Quality, Risk & Release Outlook', 'Management exceptions, portfolio context and Jira milestones');
  const riskCards = [
    ['Overdue', projectView.overdue, projectView.overdue ? palette.amber : palette.green],
    ['Defects', projectView.unresolvedDefects, projectView.unresolvedDefects ? palette.red : palette.green],
    ['Blocked', projectView.blocked, projectView.blocked ? palette.red : palette.green],
    ['Scope Growth', projectView.scopeIncreasedTeams, projectView.scopeIncreasedTeams ? palette.amber : palette.green],
  ];
  riskCards.forEach((card, index) => addPptMetricCard(pptx, slide, {
    x: 0.65 + index * 3.05, y: 1.25, w: 2.75, h: 1.1,
    label: card[0], value: card[1], accent: card[2],
  }));
  addPptText(slide, 'Team exceptions', { x: 0.7, y: 2.72, w: 2.1, h: 0.24, fontSize: 10, bold: true, color: palette.navy });
  const exceptionLines = projectView.teams.filter((team) => team.rag.label !== 'GREEN').slice(0, 6).map((team) => `• ${team.board.name}: ${team.rag.reason}`);
  addPptText(slide, exceptionLines.join('\n') || '• No team is currently breaching configured project thresholds.', {
    x: 0.7, y: 3.08, w: 5.7, h: 2.55, fontSize: 9, color: palette.grey, breakLine: true, valign: 'top',
  });
  addPptText(slide, 'Release / milestone context', { x: 6.85, y: 2.72, w: 2.7, h: 0.24, fontSize: 10, bold: true, color: palette.navy });
  const versionLines = projectView.versions.slice(0, 7).map((version) =>
    `• ${version.name}: ${version.released ? 'Released' : version.overdue ? 'Release date passed' : 'Planned'}${version.releaseDate ? ` · ${formatDate(version.releaseDate)}` : ' · no release date'}`
  );
  addPptText(slide, versionLines.join('\n') || '• No Jira versions are available in the current project context.', {
    x: 6.85, y: 3.08, w: 5.8, h: 2.55, fontSize: 9, color: palette.grey, breakLine: true, valign: 'top',
  });

  if (projectView.epics.length) {
    slide = pptx.addSlide();
    addHeader(slide, 'Strategic Themes & Epics', 'Most recently updated Jira Epics in the current project context');
    projectView.epics.slice(0, 10).forEach((epic, index) => {
      const col = index % 2;
      const row = Math.floor(index / 2);
      const x = 0.65 + col * 6.15;
      const y = 1.18 + row * 1.08;
      const statusText = epic.status || 'No status';
      const statusCategory = String(epic.statusCategoryKey || '').toLowerCase();
      const accent = statusCategory === 'done' ? palette.green : /progress/i.test(statusText) ? palette.blue : palette.amber;
      slide.addShape(pptx.ShapeType.roundRect, {
        x, y, w: 5.75, h: 0.86, rectRadius: 0.04,
        fill: { color: palette.white }, line: { color: palette.border, pt: 0.7 },
      });
      slide.addShape(pptx.ShapeType.rect, {
        x, y, w: 0.06, h: 0.86,
        fill: { color: accent }, line: { color: accent, transparency: 100 },
      });
      addPptText(slide, epic.key, { x: x + 0.18, y: y + 0.1, w: 1.2, h: 0.18, fontSize: 8.2, bold: true, color: palette.blue });
      addPptText(slide, statusText, { x: x + 4.05, y: y + 0.1, w: 1.45, h: 0.18, fontSize: 7.5, bold: true, color: accent, align: 'right' });
      addPptText(slide, epic.summary || 'No summary', { x: x + 0.18, y: y + 0.36, w: 5.25, h: 0.28, fontSize: 9.2, bold: true, color: palette.navy });
      if (epic.dueDate) addPptText(slide, `Due ${formatDate(epic.dueDate)}`, { x: x + 0.18, y: y + 0.67, w: 2.0, h: 0.14, fontSize: 6.8, color: palette.grey });
    });
  }

  if (usableCustomKpis.length) {
    slide = pptx.addSlide();
    addHeader(slide, 'Organisation-defined KPIs', 'Saved Jira filters / custom JQL');
    usableCustomKpis.slice(0, 12).forEach((kpi, index) => {
      addPptMetricCard(pptx, slide, {
        x: 0.7 + (index % 4) * 3.05,
        y: 1.3 + Math.floor(index / 4) * 1.7,
        w: 2.75, h: 1.35,
        label: kpi.name,
        value: kpi.error ? '—' : formatNumber(kpi.value ?? kpi.matchedIssues ?? 0),
        helper: kpi.error ? String(kpi.error).slice(0, 80) : getCustomInsightEvidence(kpi),
        accent: kpi.error ? palette.red : palette.blue,
      });
    });
  }

  return pptx;
}

async function createProjectPdf({ projectReport, projectView, projectCommentaryText, customKpiResults = [] }) {
  const doc = new jsPDF({ orientation:'landscape', unit:'mm', format:'a4' }); let page=1;
  pdfAddPageHeader(doc, projectReport.projectName, 'PROJECT / PROGRAM REPORT', page++); doc.setFontSize(24); doc.text(`Overall RAG: ${projectView.rag.label}`,15,40); doc.setFontSize(13); doc.text(`Mean completion: ${projectView.meanCompletion}%   Teams on track: ${projectView.teamsOnTrack}   Teams at risk: ${projectView.teamsAtRisk}   Overdue: ${projectView.overdue}`,15,55);
  doc.addPage(); pdfAddPageHeader(doc,'Management summary','Generated from current Jira analysis',page++); doc.setFontSize(10); doc.text(doc.splitTextToSize(projectCommentaryText || projectNarrativeText(projectReport, DEFAULT_REPORTING_SETTINGS),260),15,35);
  doc.addPage(); pdfAddPageHeader(doc,'Delivery & Team Health',`${projectView.teams.length} included Scrum ${projectView.teams.length === 1 ? 'board' : 'boards'}`,page++); autoTable(doc,{startY:30,head:[['Board','Sprint','RAG','Progress','Open','Overdue','Defects']],body:projectView.teams.map(t=>[t.board.name,t.sprint?.name||'—',t.rag.label,`${t.completion}%`,t.report?.metrics?.open ?? 0,t.overdue,t.unresolvedDefects]),theme:'grid',headStyles:{fillColor:[16,42,67]}});
  if (customKpiResults.length) { doc.addPage(); pdfAddPageHeader(doc,'Organisation-defined KPIs','Saved Jira filters / custom JQL',page++); autoTable(doc,{startY:30,head:[['KPI','Value','Matching issues']],body:customKpiResults.map(k=>[k.name,k.error?'—':formatNumber(k.value),k.error||String(k.matchedIssues??0)]),theme:'grid',headStyles:{fillColor:[16,42,67]}}); }
  doc.addPage(); pdfAddPageHeader(doc,'Quality, risk & release outlook','Project-level management exceptions',page++); doc.setFontSize(12); doc.text([`Overdue work: ${projectView.overdue}`,`Unresolved defects: ${projectView.unresolvedDefects}`,`Blocked / impeded: ${projectView.blocked}`,`Teams with scope growth: ${projectView.scopeIncreasedTeams}`,`Jira versions: ${projectView.versions.length}`],15,40);
  return doc;
}

async function createPdfReport({
  report,
  velocityReport,
  nextSprintOutlook,
  projectKey,
  selectedSections,
  filteredIssues,
  readiness,
  deliveryStatus,
  planningAssessment,
  managementCommentaryText = '',
  customKpiResults = [],
  reportingSettings = DEFAULT_REPORTING_SETTINGS,
}) {
  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4',
    compress: true,
  });

  enablePdfSafeText(doc);

  const estimationDisplay = getEstimationDisplay(report);
  const overall = getOverallRag({ report, readiness, settings: reportingSettings });
  const narrative = getManagementNarrative({
    report,
    readiness,
    deliveryStatus,
    settings: reportingSettings,
  });
  const commentarySections = parseManagementCommentaryForExport(
    managementCommentaryText,
    narrative
  );
  const commentaryContinuationLines = getCommentaryContinuationLines(commentarySections);
  const outlookSummary = buildNextSprintOutlookSummary(
    nextSprintOutlook,
    velocityReport
  );
  const executiveSnapshot = getExecutiveCommentarySnapshot({
    report,
    effort: report.metrics?.effort,
    deliveryStatus,
    planningAssessment,
  });

  let page = 1;

  // Cover page
  doc.setFillColor(15, 39, 71);
  doc.rect(0, 0, 297, 210, 'F');
  doc.setFillColor(12, 102, 228);
  doc.rect(0, 0, 297, 4, 'F');

  pdfSetText(doc, [133, 184, 255], 11, 'bold');
  doc.text('EXECUTIVE SPRINT REPORTING', 18, 26);

  pdfSetText(doc, [255, 255, 255], 28, 'bold');
  doc.text(report.sprint.name, 18, 48);

  pdfSetText(doc, [221, 235, 255], 12, 'normal');
  doc.text(
    doc.splitTextToSize(
      report.sprint.goal || 'No sprint goal entered',
      240
    ),
    18,
    61
  );

  pdfSetText(doc, [255, 255, 255], 10, 'normal');
  doc.text(
    `${formatDate(report.sprint.startDate)} - ${formatDate(
      report.sprint.endDate
    )}`,
    18,
    80
  );

  pdfMetricCard(doc, {
    x: 18,
    y: 100,
    w: 54,
    h: 32,
    label: 'Delivery Progress',
    value: `${report.metrics.storyPointCompletionPercentage}%`,
    helper: `${formatNumber(report.metrics.completedStoryPoints)} of ${formatNumber(report.metrics.committedStoryPoints)} ${estimationDisplay.short}`,
    accent: [19, 121, 91],
  });

  pdfMetricCard(doc, {
    x: 78,
    y: 100,
    w: 54,
    h: 32,
    label: 'Delivery Health',
    value: `${readiness.score}%`,
    helper: readiness.label,
    accent: [36, 87, 166],
  });

  pdfMetricCard(doc, {
    x: 138,
    y: 100,
    w: 54,
    h: 32,
    label: 'Open Work',
    value: report.metrics.open,
    helper: `${report.metrics.overdue} overdue`,
    accent: [183, 121, 31],
  });

  pdfMetricCard(doc, {
    x: 198,
    y: 100,
    w: 54,
    h: 32,
    label: 'Defects',
    value: report.metrics.defects,
    helper: `${readiness.openDefects ?? 0} unresolved`,
    accent: [168, 59, 59],
  });

  pdfSetText(doc, [255, 255, 255], 15, 'bold');
  doc.text(deliveryStatus.label, 18, 154);

  pdfSetText(doc, [221, 235, 255], 9, 'normal');
  doc.text('Prepared from Jira | by QTI Labs', 279, 194, {
    align: 'right',
  });

  if (selectedSections.overview) {
    doc.addPage();
    page += 1;
    pdfAddPageHeader(
      doc,
      'Executive Overview',
      'Headline sprint delivery, risk and scope indicators',
      page
    );

    [
      ['Delivery Progress', `${report.metrics.storyPointCompletionPercentage}%`, `${report.metrics.completed} of ${report.metrics.total} items`, [19, 121, 91]],
      [`Completed ${estimationDisplay.short}`, report.metrics.completedStoryPoints, `${report.metrics.completed} completed items`, [19, 121, 91]],
      [`Remaining ${estimationDisplay.short}`, report.metrics.remainingStoryPoints, `${report.metrics.open} open items`, [183, 121, 31]],
      ['Delivery Risk', report.metrics.overdue, `${report.metrics.defects} defects | ${report.metrics.overdue} overdue`, [168, 59, 59]],
    ].forEach(([label, value, helper, accent], index) => {
      pdfMetricCard(doc, {
        x: 12 + index * 70,
        y: 30,
        w: 64,
        h: 30,
        label,
        value,
        helper,
        accent,
      });
    });

    const overviewColour = overall.label === 'RED' ? [248, 232, 232] : overall.label === 'AMBER' ? [251, 241, 221] : [231, 244, 239];
    doc.setFillColor(...overviewColour); doc.roundedRect(14, 65, 268, 9, 2, 2, 'F');
    pdfSetText(doc, [16, 42, 67], 7.5, 'bold');
    doc.text(`${overall.label} | ${deliveryStatus.label} | ${formatNumber(report.metrics.storyPointCompletionPercentage)}% Complete | ${formatNumber(report.metrics.overdue)} overdue | ${formatNumber(readiness?.openDefects ?? 0)} unresolved defects`, 18, 71);

    pdfSetText(doc, [16, 42, 67], 10, 'bold');
    doc.text('Delivery Progress', 14, 75);

    doc.setFillColor(233, 237, 243);
    doc.roundedRect(14, 82, 165, 6, 3, 3, 'F');

    doc.setFillColor(34, 160, 107);
    doc.roundedRect(
      14,
      82,
      165 *
        Math.max(
          0,
          Math.min(
            100,
            pdfNumber(
              report.metrics.storyPointCompletionPercentage
            )
          )
        ) /
        100,
      6,
      3,
      3,
      'F'
    );

    pdfSetText(doc, [83, 98, 115], 7.5, 'normal');
    doc.text(
      `${formatNumber(report.metrics.completedStoryPoints)} completed of ${formatNumber(report.metrics.committedStoryPoints)} ${estimationDisplay.short}`,
      14,
      95
    );

    pdfSetText(doc, [16, 42, 67], 10, 'bold');
    doc.text('Issues by Status', 190, 75);

    pdfHorizontalBars(
      doc,
      Object.entries(report.metrics.statusCounts ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 7)
        .map(([label, value], index) => ({
          label,
          value,
          color: [
            [19, 121, 91],
            [36, 87, 166],
            [183, 121, 31],
            [168, 59, 59],
            [101, 84, 192],
          ][index % 5],
        })),
      {
        x: 190,
        y: 82,
        w: 92,
        rowHeight: 8,
        labelWidth: 30,
      }
    );

    const scopeCards = [
      [`Scope ${estimationDisplay.short}`, report.metrics.committedStoryPoints],
      ['Completed Items', report.metrics.completed],
      ['Open Items', report.metrics.open],
      ['Defects', report.metrics.defects],
      ['Overdue', report.metrics.overdue],
    ];

    scopeCards.forEach(([label, value], index) => {
      pdfMetricCard(doc, {
        x: 14 + index * 54,
        y: 145,
        w: 49,
        h: 25,
        label,
        value,
        accent:
          index >= 3
            ? [168, 59, 59]
            : [36, 87, 166],
      });
    });
  }

  const customJiraPdfPageRef = { value: page + 1 };
  addPdfCustomJiraInsightPages(doc, customKpiResults, customJiraPdfPageRef);
  page = customJiraPdfPageRef.value - 1;

  // Executive commentary
  doc.addPage();
  page += 1;
  pdfAddPageHeader(
    doc,
    'Executive Commentary',
    'At-a-glance sprint status, risks, actions and next-sprint outlook',
    page
  );

  const pdfStatus = executiveSnapshot.tone === 'negative'
    ? { ink: [168, 59, 59], fill: [255, 240, 237] }
    : executiveSnapshot.tone === 'warning'
      ? { ink: [183, 121, 31], fill: [255, 247, 214] }
      : executiveSnapshot.tone === 'positive'
        ? { ink: [19, 121, 91], fill: [220, 255, 241] }
        : { ink: [36, 87, 166], fill: [233, 242, 255] };

  doc.setFillColor(...pdfStatus.fill);
  doc.setDrawColor(...pdfStatus.ink);
  doc.roundedRect(14, 30, 104, 12, 3, 3, 'FD');
  pdfSetText(doc, pdfStatus.ink, 8.5, 'bold');
  doc.text(
    `${String(executiveSnapshot.statusPrefix).toUpperCase()}  ·  ${String(executiveSnapshot.statusLabel).toUpperCase()}`,
    20,
    37.5
  );

  const pdfExecutiveCallout = ({ callout, x, y, w, accent }) => {
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(213, 217, 224);
    doc.roundedRect(x, y, w, 31, 2.5, 2.5, 'FD');
    doc.setFillColor(...accent);
    doc.rect(x, y, 2, 31, 'F');

    pdfSetText(doc, [98, 111, 134], 6.7, 'bold');
    doc.text(String(callout.label).toUpperCase(), x + 6, y + 7);

    pdfSetText(doc, [23, 43, 77], 15, 'bold');
    doc.text(String(callout.value), x + 6, y + 16);

    pdfSetText(doc, [68, 84, 111], 7.2, 'bold');
    doc.text(doc.splitTextToSize(String(callout.detail), w - 12), x + 6, y + 22);

    if (callout.meta) {
      pdfSetText(doc, [98, 111, 134], 6.3, 'normal');
      doc.text(doc.splitTextToSize(String(callout.meta), w - 12), x + 6, y + 27);
    }
  };

  pdfExecutiveCallout({
    callout: executiveSnapshot.progress,
    x: 14,
    y: 48,
    w: 132,
    accent: [36, 87, 166],
  });
  pdfExecutiveCallout({
    callout: executiveSnapshot.forecast,
    x: 151,
    y: 48,
    w: 132,
    accent: executiveSnapshot.forecast.provisional ? [183, 121, 31] : [19, 121, 91],
  });

  const addPdfExecutivePanel = ({ title, items, x, y, w, h, ink, fill }) => {
    doc.setFillColor(...fill);
    doc.setDrawColor(...ink);
    doc.roundedRect(x, y, w, h, 2.5, 2.5, 'FD');
    pdfSetText(doc, ink, 7.5, 'bold');
    doc.text(title, x + 6, y + 7);

    pdfSetText(doc, [68, 84, 111], 6.9, 'normal');
    let currentY = y + 13;
    const visible = (items ?? []).slice(0, 4);
    if (!visible.length) {
      doc.text('No material items identified.', x + 7, currentY);
      return;
    }
    visible.forEach((item) => {
      const lines = doc.splitTextToSize(`- ${item}`, w - 14);
      doc.text(lines, x + 7, currentY);
      currentY += lines.length * 3.8 + 1.1;
    });
  };

  addPdfExecutivePanel({
    title: 'KEY RISKS',
    items: commentarySections.risks,
    x: 14,
    y: 85,
    w: 132,
    h: 42,
    ink: [168, 59, 59],
    fill: [255, 247, 245],
  });
  addPdfExecutivePanel({
    title: 'RECOMMENDED ACTIONS',
    items: commentarySections.actions,
    x: 151,
    y: 85,
    w: 132,
    h: 42,
    ink: [19, 121, 91],
    fill: [242, 251, 247],
  });

  const pdfOutlookLines = commentarySections.outlook?.length
    ? commentarySections.outlook
    : outlookSummary
      ? [
          `Load: ${outlookSummary.sprintName} · ${formatNumber(outlookSummary.plannedPoints)} planned ${estimationDisplay.short} / ${formatNumber(outlookSummary.plannedItems)} items / ${formatNumber(outlookSummary.carryOverItems)} carry-over`,
          `Goal: ${outlookSummary.goal}`,
        ]
      : [];
  const pdfPlanningLines = commentarySections.planning?.length
    ? commentarySections.planning
    : (outlookSummary?.risks ?? []).map((item) => `Check: ${item}`);

  if (pdfOutlookLines.length || pdfPlanningLines.length) {
    doc.setFillColor(244, 248, 255);
    doc.setDrawColor(133, 184, 255);
    doc.roundedRect(14, 133, 269, 47, 2.5, 2.5, 'FD');
    pdfSetText(doc, [36, 87, 166], 7.5, 'bold');
    doc.text('NEXT SPRINT OUTLOOK', 20, 141);

    pdfSetText(doc, [68, 84, 111], 7, 'normal');
    let outlookY = 148;
    [...pdfOutlookLines.slice(0, 3), ...pdfPlanningLines.slice(0, 2)].forEach((item) => {
      const lines = doc.splitTextToSize(`- ${item}`, 253);
      doc.text(lines, 21, outlookY);
      outlookY += lines.length * 4 + 1;
    });
  }

  const pdfOverflowLines = [];
  const appendPdfOverflow = (title, items) => {
    if (!items?.length) return;
    pdfOverflowLines.push(title);
    items.forEach((item) => pdfOverflowLines.push(`• ${item}`));
    pdfOverflowLines.push('');
  };
  if (String(managementCommentaryText ?? '').trim()) {
    appendPdfOverflow('PUBLISHED SUMMARY / NOTES', commentarySections.summary);
  }
  appendPdfOverflow('KEY RISKS · CONTINUED', commentarySections.risks?.slice(4));
  appendPdfOverflow('RECOMMENDED ACTIONS · CONTINUED', commentarySections.actions?.slice(4));
  appendPdfOverflow('NEXT SPRINT OUTLOOK · CONTINUED', pdfOutlookLines.slice(3));
  appendPdfOverflow('PLANNING CHECKS · CONTINUED', pdfPlanningLines.slice(2));
  if (commentaryContinuationLines.length) pdfOverflowLines.push(...commentaryContinuationLines);

  if (pdfOverflowLines.filter(Boolean).length) {
    doc.addPage();
    page += 1;
    pdfAddPageHeader(
      doc,
      'Executive Commentary · Continued',
      'Additional published commentary and overflow details',
      page
    );
    pdfSetText(doc, [68, 84, 111], 8.5, 'normal');
    const continuationLines = doc.splitTextToSize(pdfOverflowLines.join('\n'), 260);
    doc.text(continuationLines, 18, 34);
  }


  const pdfTraceability = report.metrics?.traceability ?? null;
  if (selectedSections.traceability && pdfTraceability?.eligibleStories > 0) {
    doc.addPage(); page += 1;
    pdfAddPageHeader(doc, 'Traceability & Quality Evidence', 'Story-level Jira links, Acceptance Criteria, test evidence, defects and release mapping', page);
    const traceCards = [
      ['Parent / Requirement', `${formatNumber(pdfTraceability.parentCoveragePercentage)}%`, `${pdfTraceability.parentLinkedStories}/${pdfTraceability.eligibleStories} Stories`, [36,87,166]],
      ['Acceptance Criteria', `${formatNumber(report.metrics?.acceptanceCriteria?.coveragePercentage ?? 0)}%`, `${report.metrics?.acceptanceCriteria?.detectedStories ?? 0}/${report.metrics?.acceptanceCriteria?.eligibleStories ?? 0} Stories`, [19,121,91]],
      ['Linked Test Evidence', `${formatNumber(pdfTraceability.testEvidenceCoveragePercentage)}%`, `${pdfTraceability.testEvidenceStories}/${pdfTraceability.eligibleStories} Stories`, [90,74,138]],
      ['Release Mapping', `${formatNumber(pdfTraceability.releaseCoveragePercentage)}%`, `${pdfTraceability.releaseMappedStories}/${pdfTraceability.eligibleStories} Stories`, [183,121,31]],
      ['Open Linked Defects', pdfTraceability.storiesWithOpenLinkedDefects, `${pdfTraceability.storiesWithLinkedDefects} Stories have linked defects`, pdfTraceability.storiesWithOpenLinkedDefects ? [168,59,59] : [19,121,91]],
    ];
    traceCards.forEach(([label,value,helper,accent], index) => pdfMetricCard(doc,{x:12+index*55,y:32,w:50,h:30,label,value,helper,accent}));
    doc.setFillColor(233,242,255); doc.setDrawColor(133,184,255); doc.roundedRect(14,78,268,34,2.5,2.5,'FD');
    pdfSetText(doc,[36,87,166],8,'bold'); doc.text('CORE TRACEABILITY GAPS',20,88);
    pdfSetText(doc,[16,42,67],11,'bold'); doc.text(`${pdfTraceability.criticalGapKeys.length} Stories are missing a parent/requirement link or identifiable Acceptance Criteria.`,20,99);
    pdfSetText(doc,[83,98,115],7,'normal'); doc.text(doc.splitTextToSize(`Acceptance Criteria source: ${report.acceptanceCriteriaSource?.name || 'Jira Description'} | ${pdfTraceability.methodology}`,250),20,121);
  }

  if (selectedSections.effort && report.metrics.effort) {
    const effort = report.metrics.effort;

    doc.addPage();
    page += 1;
    pdfAddPageHeader(
      doc,
      'Effort Estimate and Variance',
      'Original Estimate, Time Spent and Remaining Estimate normalised to hours',
      page
    );

    [
      ['Original Estimate', `${effort.originalEstimateHours}h`, [36, 87, 166]],
      ['Time Spent', `${effort.timeSpentHours}h`, [19, 121, 91]],
      ['Remaining Estimate', `${effort.remainingEstimateHours}h`, [183, 121, 31]],
      ['Forecast Effort', `${effort.forecastHours}h`, [101, 84, 192]],
      ['Effort Variance', `${effort.varianceHours}h`, [168, 59, 59]],
    ].forEach(([label, value, accent], index) => {
      pdfMetricCard(doc, {
        x: 12 + index * 56,
        y: 31,
        w: 51,
        h: 30,
        label,
        value,
        helper:
          label === 'Effort Variance'
            ? `${effort.variancePercentage}%`
            : undefined,
        accent,
      });
    });

    pdfSetText(doc, [16, 42, 67], 10, 'bold');
    doc.text('Coverage', 14, 78);

    pdfHorizontalBars(
      doc,
      [
        {
          label: 'Original Estimate Coverage',
          value:
            effort.coverage
              ?.originalEstimateCoveragePercentage ?? 0,
          color: [36, 87, 166],
        },
        {
          label: 'Remaining Estimate Coverage',
          value:
            effort.coverage
              ?.remainingEstimateCoveragePercentage ?? 0,
          color: [183, 121, 31],
        },
        {
          label: 'Time-Spent Coverage',
          value:
            effort.coverage
              ?.timeSpentCoveragePercentage ?? 0,
          color: [19, 121, 91],
        },
      ],
      {
        x: 14,
        y: 87,
        w: 125,
        rowHeight: 17,
        labelWidth: 58,
      }
    );

    doc.setFillColor(
      ...(effort.forecastProvisional
        ? [255, 247, 214]
        : [227, 252, 239])
    );
    doc.setDrawColor(
      ...(effort.forecastProvisional
        ? [245, 205, 71]
        : [75, 206, 151])
    );
    doc.roundedRect(153, 80, 130, 64, 3, 3, 'FD');

    pdfSetText(
      doc,
      effort.forecastProvisional
        ? [127, 95, 1]
        : [22, 75, 53],
      14,
      'bold'
    );
    doc.text(
      effort.forecastProvisional
        ? 'Low estimate confidence'
        : 'Forecast Confidence',
      161,
      95
    );

    pdfSetText(doc, [68, 84, 111], 9, 'normal');
    doc.text(
      doc.splitTextToSize(
        effort.forecastProvisional
          ? 'Remaining Estimate coverage is incomplete. Forecast effort and favourable variance may be understated.'
          : 'Forecast and variance are supported by current remaining-estimate data.',
        112
      ),
      161,
      108
    );
  }

  if (selectedSections.scopeHistory && report.history?.available) {
    const history = report.history;

    doc.addPage();
    page += 1;
    pdfAddPageHeader(
      doc,
      'Sprint Scope History',
      'Original commitment, scope movement and estimate revisions',
      page
    );

    const original = Number(
      history.originalCommitment?.storyPoints ?? 0
    );
    const added = Number(
      history.scopeChange?.addedStoryPoints ?? 0
    );
    const removed = Number(
      history.scopeChange?.removedStoryPoints ?? 0
    );
    const estimateChange = Number(
      history.scopeChange?.estimateChangeStoryPoints ?? 0
    );
    const current = Number(report.metrics.committedStoryPoints ?? history.currentScope?.storyPoints ?? 0);
    const baselineReliable = original > 0 || current === 0;

    pdfHorizontalBars(
      doc,
      [
        { label: baselineReliable ? 'Original Commitment' : 'Commitment baseline unavailable', value: baselineReliable ? original : 0, color: [36, 87, 166] },
        { label: 'Scope Added', value: added, prefix: '+', color: [19, 121, 91] },
        { label: 'Scope Removed', value: removed, prefix: '-', color: [168, 59, 59] },
        { label: 'Estimate Revisions', value: estimateChange, prefix: estimateChange > 0 ? '+' : '', color: [183, 121, 31] },
        { label: 'Current Scope', value: current, color: [101, 84, 192] },
      ],
      {
        x: 16,
        y: 38,
        w: 266,
        rowHeight: 18,
        labelWidth: 62,
      }
    );

    pdfSetText(doc, [16, 42, 67], 11, 'bold');
    doc.text(
      baselineReliable
        ? `${formatNumber(original)} committed + ${formatNumber(added)} added - ${formatNumber(removed)} removed ${estimateChange >= 0 ? '+' : '-'} ${formatNumber(Math.abs(estimateChange))} estimate revision = ${formatNumber(current)} current ${estimationDisplay.short}`
        : `Current scope: ${formatNumber(current)} ${estimationDisplay.short} | sprint-start commitment baseline unavailable; StatusDeck does not classify the whole sprint as added scope.`,
      148.5,
      145,
      { align: 'center' }
    );

    [
      ['Original Items', history.originalCommitment?.items ?? 0],
      ['Current Items', history.currentScope?.items ?? 0],
      ['Added Items', history.scopeChange?.addedItems ?? 0],
      ['Removed Items', history.scopeChange?.removedItems ?? 0],
      [`Completed ${estimationDisplay.short}`, history.currentScope?.completedStoryPoints ?? 0],
      [`Remaining ${estimationDisplay.short}`, history.currentScope?.remainingStoryPoints ?? 0],
    ].forEach(([label, value], index) => {
      pdfMetricCard(doc, {
        x: 13 + index * 46,
        y: 160,
        w: 42,
        h: 24,
        label,
        value,
        accent: [36, 87, 166],
      });
    });
  }

  if (selectedSections.burndown && report.history?.available) {
    doc.addPage();
    page += 1;
    pdfAddPageHeader(
      doc,
      'Sprint Burndown',
      `Daily ${estimationDisplay.noun} burndown compared with ideal sprint trajectory`,
      page
    );

    pdfBurndown(
      doc,
      report.history.burndownDaily ??
        report.history.burndown ??
        [],
      {
        basis: estimationDisplay.short === 'hours' ? 'effort' : 'points',
      }
    );
  }

  if (selectedSections.statusTypes) {
    doc.addPage();
    page += 1;
    pdfAddPageHeader(
      doc,
      'Status and Work-Item Distribution',
      'Current sprint distribution by status, issue type and priority',
      page
    );

    pdfSetText(doc, [16, 42, 67], 10, 'bold');
    doc.text('Issues by Status', 14, 34);

    pdfHorizontalBars(
      doc,
      Object.entries(report.metrics.statusCounts ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([label, value], index) => ({
          label,
          value,
          color: [
            [19, 121, 91],
            [36, 87, 166],
            [183, 121, 31],
            [168, 59, 59],
            [101, 84, 192],
          ][index % 5],
        })),
      {
        x: 14,
        y: 42,
        w: 126,
        rowHeight: 11,
        labelWidth: 43,
      }
    );

    pdfSetText(doc, [16, 42, 67], 10, 'bold');
    doc.text('Work-Item Types', 155, 34);

    pdfHorizontalBars(
      doc,
      Object.entries(report.metrics.typeCounts ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([label, value], index) => ({
          label,
          value,
          color: [
            [36, 87, 166],
            [183, 121, 31],
            [101, 84, 192],
            [168, 59, 59],
            [19, 121, 91],
          ][index % 5],
        })),
      {
        x: 155,
        y: 42,
        w: 128,
        rowHeight: 11,
        labelWidth: 43,
      }
    );

    pdfSetText(doc, [16, 42, 67], 10, 'bold');
    doc.text('Priority Profile', 14, 132);

    pdfHorizontalBars(
      doc,
      Object.entries(getPriorityCounts(filteredIssues))
        .sort((a, b) => b[1] - a[1])
        .map(([label, value], index) => ({
          label,
          value,
          color: [
            [168, 59, 59],
            [227, 73, 53],
            [245, 165, 36],
            [36, 87, 166],
            [19, 121, 91],
          ][index % 5],
        })),
      {
        x: 14,
        y: 140,
        w: 126,
        rowHeight: 10,
        labelWidth: 43,
      }
    );
  }

  if (selectedSections.sprintReport) {
    doc.addPage();
    page += 1;
    pdfAddPageHeader(
      doc,
      'Sprint Report',
      'Completed and incomplete delivery summary',
      page
    );

    [
      ['Completed Items', report.sprintReport.completedCount, [19, 121, 91]],
      ['Incomplete Items', report.sprintReport.incompleteCount, [183, 121, 31]],
      [`Completed ${estimationDisplay.short}`, report.sprintReport.completedStoryPoints, [19, 121, 91]],
      [`Incomplete ${estimationDisplay.short}`, report.sprintReport.incompleteStoryPoints, [183, 121, 31]],
    ].forEach(([label, value, accent], index) => {
      pdfMetricCard(doc, {
        x: 18 + index * 68,
        y: 38,
        w: 60,
        h: 34,
        label,
        value,
        accent,
      });
    });

    const committed =
      report.history?.available
        ? report.history.originalCommitment?.storyPoints
        : report.metrics.committedStoryPoints;

    pdfSetText(doc, [16, 42, 67], 11, 'bold');
    doc.text(
      'Completion against sprint-start commitment',
      18,
      100
    );

    doc.setFillColor(233, 237, 243);
    doc.roundedRect(18, 112, 246, 8, 4, 4, 'F');

    doc.setFillColor(34, 160, 107);
    doc.roundedRect(
      18,
      112,
      246 *
        Math.min(
          1,
          pdfNumber(
            report.sprintReport.completedStoryPoints
          ) /
            Math.max(1, pdfNumber(committed, 1))
        ),
      8,
      4,
      4,
      'F'
    );

    pdfSetText(doc, [83, 98, 115], 9, 'normal');
    doc.text(
      `${formatNumber(
        report.sprintReport.completedStoryPoints
      )} completed of ${formatNumber(committed)} committed ${estimationDisplay.short}`,
      18,
      132
    );
  }

  if (selectedSections.velocity && velocityReport?.velocity?.length) {
    doc.addPage();
    page += 1;
    pdfAddPageHeader(
      doc,
      'Velocity & Team Workload',
      `Recent closed sprints | Average completed: ${velocityReport.averageCompleted} ${velocityReport.usesStoryPoints ? estimationDisplay.noun : 'work items'}`,
      page
    );

    const maximum = Math.max(
      1,
      ...velocityReport.velocity.flatMap((item) => [
        Number(item.committedStoryPoints ?? 0),
        Number(item.completedStoryPoints ?? 0),
      ])
    );

    velocityReport.velocity.forEach((item, index) => {
      const y = 38 + index * 22;

      pdfSetText(doc, [16, 42, 67], 8, 'bold');
      doc.text(item.sprintName, 14, y + 3);

      pdfSetText(doc, [83, 98, 115], 6.5, 'normal');
      doc.text('Committed', 56, y + 2);

      doc.setFillColor(233, 237, 243);
      doc.roundedRect(76, y, 170, 4, 2, 2, 'F');

      doc.setFillColor(12, 102, 228);
      doc.roundedRect(
        76,
        y,
        170 *
          pdfNumber(item.committedStoryPoints) /
          Math.max(1, pdfNumber(maximum, 1)),
        4,
        2,
        2,
        'F'
      );

      pdfSetText(doc, [83, 98, 115], 6.5, 'normal');
      doc.text('Completed', 56, y + 10);

      doc.setFillColor(233, 237, 243);
      doc.roundedRect(76, y + 8, 170, 4, 2, 2, 'F');

      doc.setFillColor(34, 160, 107);
      doc.roundedRect(
        76,
        y + 8,
        170 *
          pdfNumber(item.completedStoryPoints) /
          Math.max(1, pdfNumber(maximum, 1)),
        4,
        2,
        2,
        'F'
      );

      pdfSetText(doc, [16, 42, 67], 7, 'bold');
      doc.text(
        `${formatNumber(item.committedStoryPoints)} / ${formatNumber(
          item.completedStoryPoints
        )}`,
        275,
        y + 7,
        { align: 'right' }
      );
    });

    const workloadStartY = Math.min(164, 42 + velocityReport.velocity.length * 22);
    autoTable(doc, {
      startY: workloadStartY,
      head: [['Team Workload', 'Total', 'Remaining', 'Overdue']],
      body: (report.metrics.workload ?? []).slice(0, 6).map((person) => [
        person.name,
        formatNumber(person.storyPoints),
        formatNumber(person.remainingStoryPoints),
        person.overdue,
      ]),
      theme: 'grid',
      styles: { font: 'helvetica', fontSize: 6.5, cellPadding: 1.1, textColor: [16, 42, 67], lineColor: [201, 211, 223], lineWidth: 0.15 },
      headStyles: { fillColor: [16, 42, 67], textColor: [255, 255, 255], fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [247, 245, 241] },
      margin: { left: 14, right: 14 },
    });
  }

  if (selectedSections.teamWorkload && !(selectedSections.velocity && velocityReport?.velocity?.length)) {
    doc.addPage();
    page += 1;
    pdfAddPageHeader(
      doc,
      'Team Workload',
      `Assignee-level workload, remaining ${estimationDisplay.short} and overdue work`,
      page
    );

    autoTable(doc, {
      startY: 29,
      head: [[
        'Assignee',
        'Total',
        'Open',
        'Completed',
        estimationDisplay.noun,
        `Remaining ${estimationDisplay.short}`,
        'Original Estimate',
        'Time Spent',
        'Remaining Estimate',
        'Forecast',
        'Overdue',
      ]],
      body: (report.metrics.workload ?? []).map((person) => [
        person.name,
        person.total,
        person.open,
        person.completed,
        formatNumber(person.storyPoints),
        formatNumber(person.remainingStoryPoints),
        formatHours(person.originalEstimateHours),
        formatHours(person.timeSpentHours),
        formatHours(person.remainingEstimateHours),
        formatHours(person.forecastHours),
        person.overdue,
      ]),
      theme: 'grid',
      margin: { left: 10, right: 10, bottom: 12 },
      styles: {
        font: 'helvetica',
        fontSize: 6.2,
        cellPadding: 1.4,
        textColor: [16, 42, 67],
        lineColor: [217, 226, 236],
        lineWidth: 0.2,
        overflow: 'linebreak',
      },
      headStyles: {
        fillColor: [16, 42, 67],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
      },
      alternateRowStyles: {
        fillColor: [247, 249, 252],
      },
    });
  }

  if (selectedSections.changeLog && report.history?.events?.length) {
    doc.addPage();
    page += 1;
    pdfAddPageHeader(
      doc,
      'Scope, Estimate and Effort Changes',
      `Executive change summary · ${report.history.events.length} history events detected · showing 5 latest/material entries`,
      page
    );

    autoTable(doc, {
      startY: 29,
      head: [['Date', 'Key', 'Change']],
      body: [...report.history.events].slice(0, 5)
        .sort(
          (a, b) =>
            new Date(b.time).getTime() -
            new Date(a.time).getTime()
        )
        .map((event) => {
          let description = event.type;

          if (event.type === 'scope-added') {
            description = `Added to sprint with ${formatNumber(
              event.storyPoints
            )} points`;
          } else if (event.type === 'scope-removed') {
            description = `Removed from sprint with ${formatNumber(
              event.storyPoints
            )} points`;
          } else if (event.type === 'estimate-changed') {
            description = `Story points ${formatNumber(
              event.beforeEstimate
            )} -> ${formatNumber(event.afterEstimate)}`;
          } else if (
            event.type === 'original-estimate-changed'
          ) {
            description = `Original estimate ${formatHours(
              event.beforeHours
            )} -> ${formatHours(event.afterHours)}`;
          } else if (
            event.type === 'remaining-estimate-changed'
          ) {
            description = `Remaining estimate ${formatHours(
              event.beforeHours
            )} -> ${formatHours(event.afterHours)}`;
          } else if (event.type === 'time-spent-changed') {
            description = `Time spent ${formatHours(
              event.beforeHours
            )} -> ${formatHours(event.afterHours)}`;
          } else if (event.type === 'status-changed') {
            description = `Status ${event.beforeStatus ?? 'Unknown'} -> ${
              event.afterStatus ?? 'Unknown'
            }`;
          }

          return [
            formatShortDate(event.time, true),
            event.key,
            description,
          ];
        }),
      theme: 'grid',
      margin: { left: 12, right: 12, bottom: 12 },
      styles: {
        font: 'helvetica',
        fontSize: 7,
        cellPadding: 1.5,
        textColor: [16, 42, 67],
        lineColor: [217, 226, 236],
        lineWidth: 0.2,
        overflow: 'linebreak',
      },
      headStyles: {
        fillColor: [16, 42, 67],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
      },
      alternateRowStyles: {
        fillColor: [247, 249, 252],
      },
      columnStyles: {
        0: { cellWidth: 33 },
        1: { cellWidth: 25 },
        2: { cellWidth: 210 },
      },
    });
  }

  if (selectedSections.workItems && filteredIssues.length) {
    doc.addPage();
    page += 1;
    pdfAddPageHeader(
      doc,
      'Sprint Work Items',
      `${filteredIssues.length} items in the selected report scope`,
      page
    );

    autoTable(doc, {
      startY: 29,
      head: [[
        'Key',
        'Summary',
        'Type',
        'Status',
        'SP',
        'Original',
        'Spent',
        'Remaining',
        'Forecast',
        'Assignee',
        'Due',
        'Overdue',
      ]],
      body: filteredIssues.map((issue) => [
        issue.key,
        issue.summary,
        issue.issueType,
        issue.status,
        formatNumber(issue.storyPoints),
        formatHours(issue.originalEstimateHours),
        formatHours(issue.timeSpentHours),
        formatHours(issue.remainingEstimateHours),
        formatHours(issue.forecastHours),
        issue.assignee,
        formatDate(issue.dueDate),
        issue.daysOverdue > 0
          ? `${issue.daysOverdue} days`
          : '-',
      ]),
      theme: 'grid',
      margin: { left: 6, right: 6, bottom: 12 },
      styles: {
        font: 'helvetica',
        fontSize: 5.6,
        cellPadding: 1.1,
        textColor: [16, 42, 67],
        lineColor: [217, 226, 236],
        lineWidth: 0.15,
        overflow: 'linebreak',
        valign: 'middle',
      },
      headStyles: {
        fillColor: [16, 42, 67],
        textColor: [255, 255, 255],
        fontStyle: 'bold',
      },
      alternateRowStyles: {
        fillColor: [247, 249, 252],
      },
      columnStyles: {
        0: { cellWidth: 18 },
        1: { cellWidth: 57 },
        2: { cellWidth: 18 },
        3: { cellWidth: 22 },
        4: { cellWidth: 9 },
        5: { cellWidth: 16 },
        6: { cellWidth: 14 },
        7: { cellWidth: 17 },
        8: { cellWidth: 15 },
        9: { cellWidth: 28 },
        10: { cellWidth: 22 },
        11: { cellWidth: 15 },
      },
    });
  }

  addPdfFinalFooters(doc);

  return doc;
}

const REPORT_SECTIONS = [
  {
    id: 'overview',
    label: 'Executive Overview',
    description: 'Headline sprint health and delivery metrics',
    defaultVisible: true,
  },
  {
    id: 'customJiraInsights',
    label: 'Custom Jira Insights',
    description: 'Saved Jira filters and dashboard visuals',
    defaultVisible: true,
  },
  {
    id: 'traceability',
    label: 'Traceability & Quality',
    description: 'Story links, Acceptance Criteria, test evidence, defects and release mapping',
    defaultVisible: true,
  },
  {
    id: 'effort',
    label: 'Effort & Variance',
    description: 'Original estimate, time spent and forecast',
    defaultVisible: true,
  },
  {
    id: 'scopeHistory',
    label: 'Sprint Scope History',
    description: 'Commitment, scope movement and estimate change',
    defaultVisible: false,
  },
  {
    id: 'burndown',
    label: 'Detailed Burndown',
    description: 'Full-sprint daily or live-event story-point / effort trajectory',
    defaultVisible: true,
  },
  {
    id: 'changeLog',
    label: 'Change Log',
    description: 'Detailed scope, estimate and status changes',
    defaultVisible: false,
  },
  {
    id: 'statusTypes',
    label: 'Status & Work Types',
    description: 'Current distribution by status and issue type',
    defaultVisible: false,
  },
  {
    id: 'sprintReport',
    label: 'Sprint Report',
    description: 'Completed and incomplete delivery summary',
    defaultVisible: true,
  },
  {
    id: 'velocity',
    label: 'Velocity',
    description: 'Recent closed-sprint commitment and completion',
    defaultVisible: true,
  },
  {
    id: 'teamWorkload',
    label: 'Team Workload',
    description: 'Assignee-level load, effort and overdue work',
    defaultVisible: false,
  },
  {
    id: 'workItems',
    label: 'Sprint Work Items',
    description: 'Detailed issue-level report',
    defaultVisible: false,
  },
];

const DEFAULT_VISIBLE_SECTIONS = REPORT_SECTIONS.reduce(
  (selection, section) => ({
    ...selection,
    [section.id]: section.defaultVisible,
  }),
  {}
);


const PROJECT_REPORT_SECTIONS = [
  { id: 'projectHealth', label: 'Executive & Program Health' },
  { id: 'projectCustomJiraInsights', label: 'Custom Jira Insights' },
  { id: 'projectCommentary', label: 'Management Commentary' },
  { id: 'projectStrategic', label: 'Strategic Themes & Epics' },
  { id: 'projectDelivery', label: 'Delivery & Team Health' },
  { id: 'projectOperational', label: 'Operational Flow & Capacity' },
  { id: 'projectQuality', label: 'Quality, Risks & Dependencies' },
  { id: 'projectRelease', label: 'Release & Milestone Readiness' },
  { id: 'projectTeams', label: 'Detailed Team / Board Health' },
];

const PROJECT_REPORT_SECTION_IDS = PROJECT_REPORT_SECTIONS.map((section) => section.id);

// Mirrors the Sprint Executive Overview movement model: narrative / dense evidence
// blocks stay full-width; paired analytical blocks can move Left / Right.
const PROJECT_FULL_WIDTH_SECTION_IDS = new Set([
  'projectHealth',
  'projectCustomJiraInsights',
  'projectCommentary',
  'projectDelivery',
  'projectTeams',
]);

function projectRagRank(label) {
  return label === 'RED' ? 3 : label === 'AMBER' ? 2 : label === 'GREEN' ? 1 : 0;
}

function projectToneFromRag(label) {
  if (label === 'RED') return 'negative';
  if (label === 'AMBER') return 'warning';
  if (label === 'GREEN') return 'positive';
  return 'neutral';
}

function unresolvedDefectCount(metrics) {
  return (metrics?.reportingIssues ?? []).filter((issue) => {
    const type = String(issue?.issueType ?? '').toLowerCase();
    return issue?.statusCategoryKey !== 'done' && (type === 'bug' || type === 'defect' || type.includes('defect'));
  }).length;
}

function blockedStatusCount(metrics) {
  return (metrics?.reportingIssues ?? []).filter((issue) => {
    if (issue?.statusCategoryKey === 'done') return false;
    return /block|impediment|waiting|on hold/i.test(String(issue?.status ?? ''));
  }).length;
}

function deriveProjectTeamHealth(item, settings = DEFAULT_REPORTING_SETTINGS) {
  const metrics = item?.report?.metrics ?? {};
  const rag = settings?.rag ?? DEFAULT_REPORTING_SETTINGS.rag;
  const completion = Number(metrics.storyPointCompletionPercentage ?? metrics.completionPercentage ?? 0);
  const overdue = Number(metrics.overdue ?? 0);
  const unresolvedDefects = unresolvedDefectCount(metrics);
  const remainingCoverage = Number(metrics?.effort?.coverage?.remainingEstimateCoveragePercentage ?? 100);
  const provisional = Boolean(metrics?.effort?.forecastProvisional);
  let label = 'GREEN';
  let reason = 'Within configured reporting thresholds.';

  if (
    overdue >= Number(rag.redOverdue ?? 4) ||
    unresolvedDefects >= Number(rag.redOpenDefects ?? 4) ||
    completion < Number(rag.amberCompletion ?? 65)
  ) {
    label = 'RED';
    const reasons = [];
    if (completion < Number(rag.amberCompletion ?? 65)) reasons.push(`${completion}% completion`);
    if (overdue >= Number(rag.redOverdue ?? 4)) reasons.push(`${overdue} overdue`);
    if (unresolvedDefects >= Number(rag.redOpenDefects ?? 4)) reasons.push(`${unresolvedDefects} unresolved defects`);
    reason = reasons.join(' · ') || 'Immediate management attention required.';
  } else if (
    overdue >= Number(rag.amberOverdue ?? 1) ||
    unresolvedDefects >= Number(rag.amberOpenDefects ?? 1) ||
    completion < Number(rag.greenCompletion ?? 85) ||
    provisional ||
    remainingCoverage < Number(rag.minimumRemainingEstimateCoverage ?? 80)
  ) {
    label = 'AMBER';
    const reasons = [];
    if (completion < Number(rag.greenCompletion ?? 85)) reasons.push(`${completion}% completion`);
    if (overdue >= Number(rag.amberOverdue ?? 1)) reasons.push(`${overdue} overdue`);
    if (unresolvedDefects >= Number(rag.amberOpenDefects ?? 1)) reasons.push(`${unresolvedDefects} unresolved defects`);
    if (provisional) reasons.push(`${formatNumber(remainingCoverage)}% remaining-estimate coverage`);
    reason = reasons.join(' · ') || 'Delivery has concerns that require follow-up.';
  }

  const history = item?.report?.history;
  const originalCandidate = Number(history?.originalCommitment?.items);
  const currentCandidate = Number(history?.currentScope?.items ?? metrics.total);
  const hasScopeBaseline = Number.isFinite(originalCandidate) && originalCandidate > 0 && Number.isFinite(currentCandidate);
  const originalItems = hasScopeBaseline ? originalCandidate : null;
  const currentItems = Number.isFinite(currentCandidate) ? currentCandidate : Number(metrics.total ?? 0);
  const scopeDeltaItems = hasScopeBaseline ? currentItems - originalItems : null;
  const scopeDeltaPercentage = hasScopeBaseline && originalItems > 0 ? Math.round((scopeDeltaItems / originalItems) * 100) : null;

  return {
    ...item,
    rag: { label, tone: projectToneFromRag(label), reason },
    completion,
    overdue,
    unresolvedDefects,
    blocked: blockedStatusCount(metrics),
    remainingCoverage,
    hasScopeBaseline,
    originalItems,
    currentItems,
    scopeDeltaItems,
    scopeDeltaPercentage,
  };
}

function sprintSequenceNumber(name) {
  const matches = String(name ?? '').match(/(?:sprint\s*)?(\d+)(?!.*\d)/i);
  return matches ? Number(matches[1]) : null;
}

function deriveProjectReportView(projectReport, settings = DEFAULT_REPORTING_SETTINGS) {
  const available = (projectReport?.boards ?? [])
    .filter((item) => item?.available && item?.report)
    .map((item) => deriveProjectTeamHealth(item, settings));

  const ragCounts = { GREEN: 0, AMBER: 0, RED: 0 };
  available.forEach((item) => { ragCounts[item.rag.label] = (ragCounts[item.rag.label] ?? 0) + 1; });
  const overall = available.reduce((worst, item) => projectRagRank(item.rag.label) > projectRagRank(worst) ? item.rag.label : worst, 'GREEN');
  const meanCompletion = available.length
    ? Math.round(available.reduce((sum, item) => sum + item.completion, 0) / available.length)
    : 0;
  const overdue = available.reduce((sum, item) => sum + item.overdue, 0);
  const unresolvedDefects = available.reduce((sum, item) => sum + item.unresolvedDefects, 0);
  const blocked = available.reduce((sum, item) => sum + item.blocked, 0);
  const open = available.reduce((sum, item) => sum + Number(item.report?.metrics?.open ?? 0), 0);
  const totalItems = available.reduce((sum, item) => sum + Number(item.report?.metrics?.total ?? 0), 0);
  const scopeChangedTeams = available.filter((item) => item.hasScopeBaseline && item.scopeDeltaItems !== 0).length;
  const scopeIncreasedTeams = available.filter((item) => item.hasScopeBaseline && item.scopeDeltaItems > 0).length;
  const scopeDecreasedTeams = available.filter((item) => item.hasScopeBaseline && item.scopeDeltaItems < 0).length;
  const scopeBaselineUnavailableTeams = available.filter((item) => !item.hasScopeBaseline).length;
  const minimumRemainingCoverage = Number(settings?.rag?.minimumRemainingEstimateCoverage ?? 80);
  const forecastReadyTeams = available.filter((item) =>
    !item.report?.metrics?.effort?.forecastProvisional &&
    Number(item.remainingCoverage ?? 0) >= minimumRemainingCoverage
  ).length;
  const forecastAttentionTeams = Math.max(0, available.length - forecastReadyTeams);
  const averageRemainingEstimateCoverage = available.length
    ? Math.round(available.reduce((sum, item) => sum + Number(item.remainingCoverage ?? 0), 0) / available.length)
    : 0;

  const cadenceNumbers = available.map((item) => sprintSequenceNumber(item.sprint?.name)).filter((value) => Number.isFinite(value));
  const cadenceMismatch = cadenceNumbers.length > 1 && Math.max(...cadenceNumbers) - Math.min(...cadenceNumbers) >= 2;

  const statusCounts = {};
  const typeCounts = {};
  const workloadMap = new Map();
  available.forEach((item) => {
    const metrics = item.report?.metrics ?? {};
    Object.entries(metrics.statusCounts ?? {}).forEach(([status, count]) => { statusCounts[status] = (statusCounts[status] ?? 0) + Number(count ?? 0); });
    Object.entries(metrics.typeCounts ?? {}).forEach(([type, count]) => { typeCounts[type] = (typeCounts[type] ?? 0) + Number(count ?? 0); });
    (metrics.workload ?? []).forEach((person) => {
      const key = person.name || 'Unassigned';
      const existing = workloadMap.get(key) ?? { name: key, total: 0, open: 0, completed: 0, overdue: 0, remainingStoryPoints: 0 };
      existing.total += Number(person.total ?? 0);
      existing.open += Number(person.open ?? 0);
      existing.completed += Number(person.completed ?? 0);
      existing.overdue += Number(person.overdue ?? 0);
      existing.remainingStoryPoints += Number(person.remainingStoryPoints ?? 0);
      workloadMap.set(key, existing);
    });
  });
  const workload = [...workloadMap.values()].sort((a, b) => b.open - a.open || b.overdue - a.overdue).slice(0, 8);
  const unassignedOpen = Number(workloadMap.get('Unassigned')?.open ?? 0);

  const activeVersions = (projectReport?.portfolioContext?.versions ?? [])
    .filter((version) => !version.archived)
    .sort((a, b) => {
      if (a.released !== b.released) return Number(a.released) - Number(b.released);
      const aDate = a.releaseDate ? new Date(a.releaseDate).getTime() : Number.MAX_SAFE_INTEGER;
      const bDate = b.releaseDate ? new Date(b.releaseDate).getTime() : Number.MAX_SAFE_INTEGER;
      return aDate - bDate;
    })
    .slice(0, 8);
  const unreleasedVersions = activeVersions.filter((version) => !version.released);
  const overdueVersions = unreleasedVersions.filter((version) => version.overdue);
  const epics = (projectReport?.portfolioContext?.epics ?? []).slice(0, 12);
  const openEpics = epics.filter((epic) => epic.statusCategoryKey !== 'done');

  return {
    teams: available,
    rag: { label: overall, tone: projectToneFromRag(overall), counts: ragCounts },
    meanCompletion,
    overdue,
    unresolvedDefects,
    blocked,
    open,
    totalItems,
    unassignedOpen,
    scopeChangedTeams,
    scopeIncreasedTeams,
    scopeDecreasedTeams,
    scopeBaselineUnavailableTeams,
    forecastReadyTeams,
    forecastAttentionTeams,
    averageRemainingEstimateCoverage,
    minimumRemainingCoverage,
    cadenceMismatch,
    statusCounts,
    typeCounts,
    workload,
    versions: activeVersions,
    unreleasedVersions,
    overdueVersions,
    epics,
    openEpics,
    teamsOnTrack: ragCounts.GREEN,
    teamsAtRisk: ragCounts.AMBER + ragCounts.RED,
  };
}

function buildProjectManagementNarrative(projectReport, settings = DEFAULT_REPORTING_SETTINGS) {
  const view = deriveProjectReportView(projectReport, settings);
  const summary = [];
  const risks = [];
  const actions = [];
  const outlook = [];

  summary.push(`${view.teams.length} Scrum team${view.teams.length === 1 ? '' : 's'} ${view.teams.length === 1 ? 'is' : 'are'} included in the current project view; ${view.teamsOnTrack} ${view.teamsOnTrack === 1 ? 'is' : 'are'} Green and ${view.teamsAtRisk} ${view.teamsAtRisk === 1 ? 'requires' : 'require'} follow-up.`);
  summary.push(`Mean team completion is ${view.meanCompletion}% with ${view.open} open work item${view.open === 1 ? '' : 's'} across the latest active/closed reporting sprint for each board.`);
  if (view.totalItems > 0) summary.push(`The current cross-team reporting scope contains ${view.totalItems} Jira work item${view.totalItems === 1 ? '' : 's'}.`);
  if (view.scopeChangedTeams > 0) summary.push(`${view.scopeChangedTeams} team${view.scopeChangedTeams === 1 ? ' has' : 's have'} changed scope from a reliable sprint-start baseline; ${view.scopeIncreasedTeams} increased scope and ${view.scopeDecreasedTeams} reduced scope.`);
  if (view.scopeBaselineUnavailableTeams > 0) summary.push(`Sprint-start item scope could not be reconstructed reliably for ${view.scopeBaselineUnavailableTeams} team${view.scopeBaselineUnavailableTeams === 1 ? '' : 's'}; StatusDeck omits scope-growth claims for those teams.`);
  if (view.teams.length > 0) summary.push(`${view.forecastReadyTeams} of ${view.teams.length} team${view.teams.length === 1 ? '' : 's'} ${view.teams.length === 1 ? 'has' : 'have'} a non-provisional effort forecast with at least ${view.minimumRemainingCoverage}% Remaining Estimate coverage.`);
  if (view.openEpics.length > 0) summary.push(`${view.openEpics.length} open Epic${view.openEpics.length === 1 ? '' : 's'} are visible in the current Jira portfolio context.`);

  const redTeams = view.teams.filter((item) => item.rag.label === 'RED');
  const amberTeams = view.teams.filter((item) => item.rag.label === 'AMBER');
  if (redTeams.length) risks.push(`Immediate delivery attention is required for ${redTeams.map((item) => `${item.board.name} (${item.rag.reason})`).join('; ')}.`);
  if (amberTeams.length) risks.push(`${amberTeams.map((item) => item.board.name).join(', ')} ${amberTeams.length === 1 ? 'is' : 'are'} Amber and should be monitored against the configured thresholds.`);
  if (view.overdue > 0) risks.push(`${view.overdue} overdue open item${view.overdue === 1 ? '' : 's'} ${view.overdue === 1 ? 'exists' : 'exist'} across the included teams.`);
  if (view.unresolvedDefects > 0) risks.push(`${view.unresolvedDefects} unresolved defect${view.unresolvedDefects === 1 ? '' : 's'} remain across current reporting-sprint scope.`);
  if (view.blocked > 0) risks.push(`${view.blocked} open item${view.blocked === 1 ? ' is' : 's are'} in blocked / impediment-like statuses.`);
  if (view.scopeIncreasedTeams > 0) risks.push(`${view.scopeIncreasedTeams} team${view.scopeIncreasedTeams === 1 ? ' has' : 's have'} increased scope since the sprint-start baseline.`);
  if (view.forecastAttentionTeams > 0) risks.push(`${view.forecastAttentionTeams} team${view.forecastAttentionTeams === 1 ? ' does' : 's do'} not yet meet the configured Remaining Estimate coverage needed for a non-provisional effort forecast.`);
  if (view.unassignedOpen > 0) risks.push(`${view.unassignedOpen} open work item${view.unassignedOpen === 1 ? ' is' : 's are'} currently unassigned across the included teams.`);
  if (view.cadenceMismatch) risks.push('Sprint numbering/cadence is materially different across boards, so like-for-like period comparison needs care.');
  if (view.overdueVersions.length > 0) risks.push(`${view.overdueVersions.length} unreleased Jira version${view.overdueVersions.length === 1 ? ' is' : 's are'} past the recorded release date.`);

  if (redTeams.length) actions.push(`Recovery ownership: confirm a named owner and dated recovery plan for ${redTeams.map((item) => item.board.name).join(', ')}.`);
  if (view.unresolvedDefects > 0) actions.push('Defect decision: review severity, ownership and release impact for the unresolved defects before the next management checkpoint.');
  if (view.overdue > 0) actions.push('Overdue recovery: confirm owners and recovery dates for overdue work, prioritising the teams with the largest overdue backlog.');
  if (view.blocked > 0) actions.push('Dependency escalation: review blocked / impeded items and escalate dependencies that cannot be cleared within the team.');
  if (view.scopeIncreasedTeams > 0) actions.push('Scope control: validate mid-sprint additions with Product Owners and confirm whether delivery expectations need to be re-baselined.');
  if (view.forecastAttentionTeams > 0) actions.push('Forecast confidence: improve Remaining Estimate coverage before relying on project effort forecasts for management commitments.');
  if (view.unassignedOpen > 0) actions.push('Ownership check: assign accountable owners to currently unassigned open work.');
  if (view.overdueVersions.length > 0) actions.push('Release decision: review Jira versions whose target date has passed and either re-plan or close the milestone explicitly.');
  if (!actions.length) actions.push('Continue current delivery controls and monitor cross-team exceptions at the next management checkpoint.');

  if (view.unreleasedVersions.length) {
    const nearest = view.unreleasedVersions[0];
    outlook.push(`${nearest.name}${nearest.releaseDate ? ` is targeted for ${formatDate(nearest.releaseDate)}` : ' is the next unreleased Jira version with no release date recorded'}.`);
    if (view.overdueVersions.length) outlook.push(`${view.overdueVersions.length} unreleased version${view.overdueVersions.length === 1 ? ' is' : 's are'} currently past the Jira release date.`);
  } else {
    outlook.push('No unreleased Jira version is currently available for milestone outlook.');
  }
  if (view.openEpics.length) outlook.push(`${view.openEpics.length} open Epic${view.openEpics.length === 1 ? ' remains' : 's remain'} in the current project portfolio context.`);

  return { summary, risks, actions, outlook, view };
}

function projectNarrativeText(projectReport, settings) {
  const narrative = buildProjectManagementNarrative(projectReport, settings);
  return [
    'Summary', ...narrative.summary.map((item) => `• ${item}`),
    '', 'Key Risks', ...(narrative.risks.length ? narrative.risks : ['No project-level exception is currently breaching the configured reporting thresholds.']).map((item) => `• ${item}`),
    '', 'Recommended Actions', ...narrative.actions.map((item) => `• ${item}`),
    ...(narrative.outlook.length ? ['', 'Release / Milestone Outlook', ...narrative.outlook.map((item) => `• ${item}`)] : []),
  ].join('\n');
}


function buildProjectExecutiveCommentarySnapshot(projectReport, settings = DEFAULT_REPORTING_SETTINGS) {
  const narrative = buildProjectManagementNarrative(projectReport, settings);
  const view = narrative.view;
  const redOverdue = Number(settings?.rag?.redOverdue ?? 4);
  const amberOverdue = Number(settings?.rag?.amberOverdue ?? 1);
  const redDefects = Number(settings?.rag?.redOpenDefects ?? 4);
  const amberDefects = Number(settings?.rag?.amberOpenDefects ?? 1);
  const statusLabel = view.rag.label === 'RED' ? 'At Risk' : view.rag.label === 'AMBER' ? 'Watch Closely' : 'On Track';
  const riskTone = view.rag.counts.RED > 0 ? 'negative' : view.rag.counts.AMBER > 0 ? 'warning' : 'positive';

  return {
    narrative,
    snapshot: {
      statusPrefix: 'Project Status',
      statusLabel,
      tone: view.rag.tone ?? projectToneFromRag(view.rag.label),
      progress: {
        label: 'Mean Completion',
        value: `${formatNumber(view.meanCompletion)}%`,
        detail: `${formatNumber(view.teamsOnTrack)} / ${formatNumber(view.teams.length)} teams Green`,
        meta: view.teamsAtRisk > 0
          ? `${formatNumber(view.teamsAtRisk)} team${view.teamsAtRisk === 1 ? '' : 's'} require follow-up`
          : 'All included teams are within configured Green thresholds',
      },
      forecast: {
        label: 'Open Work',
        value: formatNumber(view.open),
        detail: `across ${formatNumber(view.teams.length)} current reporting team${view.teams.length === 1 ? '' : 's'}`,
        meta: `${formatNumber(view.overdue)} overdue · ${formatNumber(view.unresolvedDefects)} defects · ${formatNumber(view.blocked)} blocked`,
        provisional: view.forecastAttentionTeams > 0,
      },
      glance: [
        {
          label: 'Teams at Risk',
          value: formatNumber(view.teamsAtRisk),
          meta: `${formatNumber(view.rag.counts.RED)} Red · ${formatNumber(view.rag.counts.AMBER)} Amber`,
          tone: riskTone,
        },
        {
          label: 'Overdue',
          value: formatNumber(view.overdue),
          meta: view.overdue ? 'Open items past due date' : 'No overdue open work',
          tone: view.overdue >= redOverdue ? 'negative' : view.overdue >= amberOverdue ? 'warning' : 'positive',
        },
        {
          label: 'Unresolved Defects',
          value: formatNumber(view.unresolvedDefects),
          meta: view.unresolvedDefects ? 'Across current sprint scope' : 'No unresolved defects',
          tone: view.unresolvedDefects >= redDefects ? 'negative' : view.unresolvedDefects >= amberDefects ? 'warning' : 'positive',
        },
        {
          label: 'Blocked / Impeded',
          value: formatNumber(view.blocked),
          meta: view.blocked ? 'Open blocked / waiting work' : 'No blocked work',
          tone: view.blocked ? 'negative' : 'positive',
        },
        {
          label: 'Scope Growth',
          value: formatNumber(view.scopeIncreasedTeams),
          meta: view.scopeIncreasedTeams ? 'Teams above sprint-start item baseline' : 'No measured team scope growth',
          tone: view.scopeIncreasedTeams ? 'warning' : 'positive',
        },
        {
          label: 'Forecast Ready',
          value: `${formatNumber(view.forecastReadyTeams)}/${formatNumber(view.teams.length)}`,
          meta: view.forecastAttentionTeams
            ? `${formatNumber(view.forecastAttentionTeams)} team${view.forecastAttentionTeams === 1 ? '' : 's'} need estimate coverage`
            : 'All included teams have non-provisional effort forecasts',
          tone: view.forecastAttentionTeams ? 'warning' : 'positive',
        },
      ],
    },
  };
}

function getSemanticTone(value) {
  const text = String(value ?? '').toLowerCase();

  if (
    text.includes('done') ||
    text.includes('complete') ||
    text.includes('closed') ||
    text.includes('resolved')
  ) {
    return 'positive';
  }

  if (
    text.includes('block') ||
    text.includes('defect') ||
    text.includes('bug') ||
    text.includes('overdue') ||
    text.includes('remove')
  ) {
    return 'negative';
  }

  if (
    text.includes('progress') ||
    text.includes('review') ||
    text.includes('open') ||
    text.includes('remaining') ||
    text.includes('risk') ||
    text.includes('task')
  ) {
    return 'warning';
  }

  return 'neutral';
}

function SectionSelector({
  visibleSections,
  onToggle,
  onExecutiveView,
  onSelectAll,
  visibleCount,
  activePreset,
  collapsed,
  onToggleCollapsed,
  sectionOrder,
  onReorder,
  includeSubtasks,
  onIncludeSubtasksChange,
}) {
  const [draggedSection, setDraggedSection] = useState('');
  const orderedSections = (sectionOrder ?? REPORT_SECTIONS.map((section) => section.id))
    .map((id) => REPORT_SECTIONS.find((section) => section.id === id))
    .filter(Boolean);

  function dropSection(targetId) {
    if (!draggedSection || draggedSection === targetId) return;
    const current = orderedSections.map((section) => section.id);
    const from = current.indexOf(draggedSection);
    const to = current.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = [...current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorder(next);
    setDraggedSection('');
  }

  return (
    <section
      className={[
        'section-selector',
        'section-selector-top',
        collapsed ? 'section-selector-collapsed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label="Report sections"
    >
      <button
        type="button"
        className="section-selector-collapse"
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand report sections' : 'Collapse report sections'}
        title={collapsed ? 'Expand report sections' : 'Collapse report sections'}
      >
        <span aria-hidden="true">{collapsed ? '▾' : '▴'}</span>
        <span>Report Sections</span>
        <span className="selection-count">{visibleCount}</span>
      </button>

      {!collapsed ? (
        <div className="section-selector-body">
          <div className="section-selector-toolbar">
            <p>Choose what appears in the report. Drag the small six-dot handles to set the default sequence; the same sections can also be repositioned directly in the report.</p>
            <div className="section-selector-actions">
              <button
                type="button"
                className={activePreset === 'executive' ? 'active' : ''}
                onClick={onExecutiveView}
                aria-pressed={activePreset === 'executive'}
              >
                Executive
              </button>
              <button
                type="button"
                className={activePreset === 'detailed' ? 'active' : ''}
                onClick={onSelectAll}
                aria-pressed={activePreset === 'detailed'}
              >
                Detailed
              </button>
            </div>
          </div>

          <div className="section-selector-list compact-section-list">
            {orderedSections.map((section) => (
              <label
                className={[
                  'section-selector-item',
                  visibleSections[section.id] ? 'selected' : '',
                  draggedSection === section.id ? 'dragging' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                key={section.id}
                draggable
                onDragStart={() => setDraggedSection(section.id)}
                onDragEnd={() => setDraggedSection('')}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => { event.preventDefault(); dropSection(section.id); }}
              >
                <span className="section-drag-handle" aria-hidden="true" title="Drag to reorder">⠿</span>
                <input
                  type="checkbox"
                  checked={Boolean(visibleSections[section.id])}
                  onChange={() => onToggle(section.id)}
                />
                <span className="section-selector-copy">
                  <strong>{section.label}</strong>
                </span>
              </label>
            ))}

            <label className={['section-selector-item', 'report-option-item', includeSubtasks ? 'selected' : ''].filter(Boolean).join(' ')}>
              <span className="section-option-icon" aria-hidden="true">↳</span>
              <input
                type="checkbox"
                checked={includeSubtasks}
                onChange={onIncludeSubtasksChange}
              />
              <span className="section-selector-copy">
                <strong>Include Subtasks in Management Totals</strong>
              </span>
            </label>
          </div>
        </div>
      ) : null}
    </section>
  );
}


function ProjectSectionSelector({
  visibleSections,
  onToggle,
  collapsed,
  onToggleCollapsed,
  sectionOrder,
}) {
  const ordered = (sectionOrder ?? PROJECT_REPORT_SECTION_IDS)
    .map((id) => PROJECT_REPORT_SECTIONS.find((section) => section.id === id))
    .filter(Boolean);
  const visibleCount = ordered.filter((section) => visibleSections[section.id]).length;
  return (
    <section className={['section-selector', 'section-selector-top', collapsed ? 'section-selector-collapsed' : ''].filter(Boolean).join(' ')} aria-label="Project report sections">
      <button type="button" className="section-selector-collapse" onClick={onToggleCollapsed} aria-expanded={!collapsed}>
        <span aria-hidden="true">{collapsed ? '▾' : '▴'}</span>
        <span>Project Report Sections</span>
        <span className="selection-count">{visibleCount}</span>
      </button>
      {!collapsed ? (
        <div className="section-selector-body">
          <div className="section-selector-toolbar">
            <p>Choose the project-level sections to show. Use each section's six-dot menu in the report to move it Up / Down and, for paired sections, Left / Right.</p>
          </div>
          <div className="section-selector-list compact-section-list">
            {ordered.map((section) => (
              <label className={['section-selector-item', visibleSections[section.id] ? 'selected' : ''].filter(Boolean).join(' ')} key={section.id}>
                <span className="section-drag-handle" aria-hidden="true">⠿</span>
                <input type="checkbox" checked={Boolean(visibleSections[section.id])} onChange={() => onToggle(section.id)} />
                <span className="section-selector-copy"><strong>{section.label}</strong></span>
              </label>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function MetricCard({
  label,
  value,
  helper,
  onClick,
  tone = 'default',
  formatter = formatNumber,
  calculationKey,
  calculationContext,
}) {
  const clickable = typeof onClick === 'function';

  function handleKeyDown(event) {
    if (
      clickable &&
      (event.key === 'Enter' || event.key === ' ')
    ) {
      event.preventDefault();
      onClick();
    }
  }

  return (
    <div
      className={[
        'metric-card',
        clickable ? 'metric-card-clickable' : '',
        tone !== 'default' ? `metric-card-${tone}` : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={clickable ? onClick : undefined}
      onKeyDown={handleKeyDown}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
    >
      <span className="metric-label metric-label-with-help">
        <span>{label}</span>
        {calculationKey ? (
          <CalculationButton calculationKey={calculationKey} context={calculationContext} />
        ) : null}
      </span>

      <strong className="metric-value">
        {formatter(value)}
      </strong>

      {helper ? (
        <span className="metric-helper">{helper}</span>
      ) : null}
    </div>
  );
}


function ProgressRing({
  percentage,
  label,
  value,
  tone = 'positive',
}) {
  const safePercentage = Math.max(
    0,
    Math.min(100, Number(percentage) || 0)
  );

  return (
    <div className={`progress-ring progress-ring-${tone}`}>
      <div
        className="progress-ring-circle"
        style={{
          '--progress': `${safePercentage * 3.6}deg`,
        }}
      >
        <div className="progress-ring-centre">
          <strong>{formatNumber(safePercentage)}%</strong>
          <span>{label}</span>
        </div>
      </div>

      {value ? <small>{value}</small> : null}
    </div>
  );
}

function StatusDonut({ statusCounts, total }) {
  const entries = Object.entries(statusCounts ?? {});
  const palette = [
    '#22a06b',
    '#0c66e4',
    '#e2b203',
    '#c9372c',
    '#6554c0',
    '#2898bd',
    '#fca700',
  ];

  let cursor = 0;
  const segments = entries.map(([label, count], index) => {
    const percentage = total > 0 ? (Number(count) / total) * 100 : 0;
    const start = cursor;
    cursor += percentage;

    return {
      label,
      count,
      percentage,
      color: palette[index % palette.length],
      start,
      end: cursor,
    };
  });

  const gradient = segments.length
    ? `conic-gradient(${segments
        .map(
          (segment) =>
            `${segment.color} ${segment.start}% ${segment.end}%`
        )
        .join(', ')})`
    : '#dcdfe4';

  return (
    <div className="status-donut-layout">
      <div
        className="status-donut"
        style={{ background: gradient }}
        role="img"
        aria-label="Status Distribution"
      >
        <div className="status-donut-centre">
          <strong>{formatNumber(total)}</strong>
          <span>items</span>
        </div>
      </div>

      <div className="status-donut-legend">
        {segments.map((segment) => (
          <div className="donut-legend-row" key={segment.label}>
            <span
              className="donut-dot"
              style={{ background: segment.color }}
            />
            <span>{segment.label}</span>
            <strong>{segment.count}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function DeliveryProgress({ metrics }) {
  const completed = Number(metrics.completedStoryPoints ?? metrics.completed ?? 0);
  const remaining = Number(metrics.remainingStoryPoints ?? metrics.open ?? 0);
  const total = Math.max(1, completed + remaining);
  const completedWidth = (completed / total) * 100;
  const remainingWidth = (remaining / total) * 100;

  return (
    <div className="delivery-progress">
      <div className="delivery-progress-summary">
        <div>
          <span>Completed</span>
          <strong>{formatNumber(completed)}</strong>
        </div>
        <div>
          <span>Remaining</span>
          <strong>{formatNumber(remaining)}</strong>
        </div>
      </div>

      <div className="delivery-progress-track" aria-label="Delivery Progress">
        <span
          className="delivery-progress-completed"
          style={{ width: `${completedWidth}%` }}
        />
        <span
          className="delivery-progress-remaining"
          style={{ width: `${remainingWidth}%` }}
        />
      </div>

      <div className="delivery-progress-scale">
        <span>0</span>
        <span>{formatNumber(total)}</span>
      </div>
    </div>
  );
}


function AcceptanceCriteriaSummary({ summary, calculationContext, title = 'Acceptance Criteria Tracking' }) {
  if (!summary || Number(summary.eligibleStories ?? 0) <= 0) return null;

  const totalCriteria = Number(summary.totalCriteria ?? 0);
  const metCriteria = Number(summary.metCriteria ?? 0);
  const notMetCriteria = Number(summary.notMetCriteria ?? 0);
  const unrecordedCriteria = Number(summary.unrecordedCriteria ?? 0);
  const trackableCriteria = Number(summary.trackableCriteria ?? 0);

  return (
    <div className="acceptance-criteria-summary">
      <div className="overview-subheading acceptance-criteria-heading">
        <div>
          <p className="eyebrow">Story Readiness & Verification</p>
          <h4 className="heading-with-calculation-help">
            <span>{title}</span>
            <CalculationButton calculationKey="acceptanceCriteriaCompletion" context={calculationContext} />
          </h4>
        </div>
        <span className="dashboard-chip">{totalCriteria} Criteria</span>
      </div>

      <div className="acceptance-criteria-kpi-grid">
        <div className="acceptance-criteria-kpi acceptance-criteria-kpi-info">
          <span>Stories With AC</span>
          <strong>{summary.detectedStories}/{summary.eligibleStories}</strong>
          <small>{formatNumber(summary.coveragePercentage)}% coverage</small>
        </div>
        <div className="acceptance-criteria-kpi acceptance-criteria-kpi-neutral">
          <span>Criteria Identified</span>
          <strong>{totalCriteria}</strong>
          <small>individual criteria</small>
        </div>
        <div className="acceptance-criteria-kpi acceptance-criteria-kpi-good">
          <span>✓ Met</span>
          <strong>{metCriteria}</strong>
          <small>explicitly completed</small>
        </div>
        <div className="acceptance-criteria-kpi acceptance-criteria-kpi-danger">
          <span>× Not Met</span>
          <strong>{notMetCriteria}</strong>
          <small>explicitly incomplete</small>
        </div>
        <div className="acceptance-criteria-kpi acceptance-criteria-kpi-warning">
          <span>○ Status Not Recorded</span>
          <strong>{unrecordedCriteria}</strong>
          <small>plain text / no task state</small>
        </div>
      </div>

      <div className="acceptance-criteria-footnote">
        {trackableCriteria > 0 ? (
          <span><strong>{formatNumber(summary.completionPercentage)}%</strong> of trackable criteria are explicitly Met ({metCriteria}/{trackableCriteria}).</span>
        ) : (
          <span>No criteria have an explicit checkbox/task state, so StatusDeck does not infer a Met/Not met percentage.</span>
        )}
        <span>Plain-text Acceptance Criteria remain <strong>Status Not Recorded</strong> until Jira contains an explicit completion state.</span>
      </div>
    </div>
  );
}


function ExecutiveBriefing({ report, readiness, overallRag, deliveryStatus, settings }) {
  if (!report) return null;
  const estimationDisplay = getEstimationDisplay(report);
  const ac = report.metrics?.acceptanceCriteria ?? {};
  const trace = report.metrics?.traceability ?? {};
  const minimumAc = Number(settings?.readiness?.minimumAcceptanceCriteriaCoverage ?? 80);
  const acCoverage = Number(ac.coveragePercentage ?? 0);
  const openDefects = Number(readiness?.openDefects ?? 0);
  const overdue = Number(report.metrics?.overdue ?? 0);
  const traceGaps = Number(trace.criticalGapKeys?.length ?? 0);
  let takeaway = `${report.metrics.storyPointCompletionPercentage}% of ${estimationDisplay.noun} are complete.`;
  if (overdue > 0) takeaway += ` ${overdue} overdue open item${overdue === 1 ? '' : 's'} require attention.`;
  else if (openDefects > 0) takeaway += ` ${openDefects} unresolved defect${openDefects === 1 ? '' : 's'} remain.`;
  else takeaway += ' No overdue open work or unresolved defects are currently driving delivery risk.';
  if (ac.eligibleStories > 0 && acCoverage < minimumAc) takeaway += ` Acceptance Criteria coverage is ${formatNumber(acCoverage)}%, below the configured ${minimumAc}% minimum.`;
  if (traceGaps > 0) takeaway += ` ${traceGaps} Stor${traceGaps === 1 ? 'y has' : 'ies have'} a parent/requirement or Acceptance Criteria traceability gap.`;

  return (
    <article className={`executive-briefing-card executive-briefing-${overallRag?.tone || 'neutral'}`}>
      <div className="executive-briefing-main">
        <div className="executive-briefing-heading">
          <span className={`executive-rag-badge executive-rag-${overallRag?.tone || 'neutral'}`}>{overallRag?.label || 'NOT SET'}</span>
          <div>
            <p className="eyebrow">Executive Summary</p>
            <h2>{titleCaseUiLabel(deliveryStatus?.label || 'Sprint Delivery Status')}</h2>
          </div>
        </div>
        <p className="executive-takeaway">{takeaway}</p>
        <div className="executive-reporting-basis">Reporting Basis: <strong>{report.estimationSource?.name || estimationDisplay.noun}</strong> · Acceptance Criteria: <strong>{report.acceptanceCriteriaSource?.name || 'Description'}</strong></div>
      </div>
      <div className="executive-briefing-kpis">
        <div><span>Delivery Progress</span><strong>{formatNumber(report.metrics.storyPointCompletionPercentage)}%</strong><small>{formatNumber(report.metrics.completedStoryPoints)} / {formatNumber(report.metrics.committedStoryPoints)} {estimationDisplay.short}</small></div>
        <div><span>Delivery Health</span><strong>{formatNumber(readiness?.score ?? 0)}%</strong><small>{titleCaseUiLabel(readiness?.label || 'Not Calculated')}</small></div>
        <div><span>Acceptance Criteria</span><strong>{ac.eligibleStories > 0 ? `${formatNumber(acCoverage)}%` : '—'}</strong><small>{ac.eligibleStories > 0 ? `${ac.detectedStories}/${ac.eligibleStories} Stories` : 'No Stories to assess'}</small></div>
        <div><span>Traceability Gaps</span><strong>{trace.eligibleStories > 0 ? traceGaps : '—'}</strong><small>{trace.eligibleStories > 0 ? `${trace.parentLinkedStories || 0}/${trace.eligibleStories} parent/requirement linked` : 'No Stories to assess'}</small></div>
      </div>
    </article>
  );
}

function TraceabilitySection({ report, settings, layoutProps, handleProps }) {
  const trace = report?.metrics?.traceability;
  if (!trace || Number(trace.eligibleStories ?? 0) <= 0) return null;
  const ac = report.metrics?.acceptanceCriteria ?? {};
  const minimumAc = Number(settings?.readiness?.minimumAcceptanceCriteriaCoverage ?? 80);
  const coverageTone = (value) => Number(value ?? 0) >= minimumAc ? 'good' : 'warning';
  return (
    <section {...layoutProps} className={`${layoutProps?.className || ''} dashboard-card content-card traceability-section executive-section-card`.trim()}>
      <span className="report-section-drag-handle no-export" aria-hidden="false" title="Move section" {...handleProps}>⠿</span>
      <div className="section-heading traceability-heading">
        <div>
          <p className="eyebrow">Traceability & Quality Evidence</p>
          <h3>Story-to-Delivery Traceability</h3>
          <p>Evidence is derived only from Jira parent/issue links, Acceptance Criteria, linked test-type work items, defects and Fix Version mapping. Missing Jira links are shown as gaps rather than inferred.</p>
        </div>
        <span className="dashboard-chip">{trace.eligibleStories} Stories Assessed</span>
      </div>
      <div className="traceability-kpi-grid">
        <button type="button" className={`traceability-kpi traceability-kpi-${coverageTone(trace.parentCoveragePercentage)}`} onClick={() => openJiraIssues(trace.criticalGapKeys)}>
          <span>Parent / Requirement Linked</span><strong>{formatNumber(trace.parentCoveragePercentage)}%</strong><small>{trace.parentLinkedStories}/{trace.eligibleStories} Stories</small>
        </button>
        <button type="button" className={`traceability-kpi traceability-kpi-${coverageTone(ac.coveragePercentage)}`} onClick={() => openJiraIssues(ac.missingKeys || [])}>
          <span>Acceptance Criteria</span><strong>{formatNumber(ac.coveragePercentage ?? 0)}%</strong><small>{ac.detectedStories || 0}/{ac.eligibleStories || 0} Stories · Source: {report.acceptanceCriteriaSource?.name || 'Description'}</small>
        </button>
        <div className="traceability-kpi traceability-kpi-neutral"><span>Linked Test Evidence</span><strong>{formatNumber(trace.testEvidenceCoveragePercentage)}%</strong><small>{trace.testEvidenceStories}/{trace.eligibleStories} Stories</small></div>
        <div className="traceability-kpi traceability-kpi-neutral"><span>Release / Fix Version Mapped</span><strong>{formatNumber(trace.releaseCoveragePercentage)}%</strong><small>{trace.releaseMappedStories}/{trace.eligibleStories} Stories</small></div>
        <div className={trace.storiesWithOpenLinkedDefects > 0 ? 'traceability-kpi traceability-kpi-danger' : 'traceability-kpi traceability-kpi-good'}><span>Open Linked Defects</span><strong>{trace.storiesWithOpenLinkedDefects}</strong><small>{trace.storiesWithLinkedDefects} Stories have linked defects</small></div>
      </div>
      <div className="traceability-gap-panel">
        <div><strong>Core Traceability Gaps</strong><span>{trace.criticalGapKeys.length} Stories missing a parent/requirement link or identifiable Acceptance Criteria</span></div>
        {trace.criticalGapKeys.length ? <button type="button" className="secondary-button no-export" onClick={() => openJiraIssues(trace.criticalGapKeys)}>Open Core Gaps in Jira</button> : <span className="traceability-complete">✓ No core parent / Acceptance Criteria gaps detected</span>}
      </div>
      <p className="traceability-methodology">{trace.methodology}</p>
    </section>
  );
}


function PriorityDonut({ issues }) {
  const priorityOrder = [
    'Highest',
    'High',
    'Medium',
    'Low',
    'Lowest',
    'None',
  ];

  const palette = {
    Highest: '#ae2e24',
    High: '#e34935',
    Medium: '#f5a524',
    Low: '#579dff',
    Lowest: '#22a06b',
    None: '#b7b9be',
  };

  const counts = (issues ?? []).reduce((result, issue) => {
    const priority = issue.priority || 'None';
    result[priority] = (result[priority] ?? 0) + 1;
    return result;
  }, {});

  const entries = Object.entries(counts)
    .sort(
      ([left], [right]) =>
        priorityOrder.indexOf(left) - priorityOrder.indexOf(right)
    );

  const total = entries.reduce(
    (sum, [, count]) => sum + Number(count || 0),
    0
  );

  let cursor = 0;

  const segments = entries.map(([label, count]) => {
    const percentage = total > 0 ? (count / total) * 100 : 0;
    const start = cursor;
    cursor += percentage;

    return {
      label,
      count,
      percentage,
      start,
      end: cursor,
      color: palette[label] ?? '#6554c0',
    };
  });

  const gradient = segments.length
    ? `conic-gradient(${segments
        .map(
          (segment) =>
            `${segment.color} ${segment.start}% ${segment.end}%`
        )
        .join(', ')})`
    : '#dcdfe4';

  return (
    <div className="priority-donut-layout">
      <div
        className="priority-donut"
        style={{ background: gradient }}
        role="img"
        aria-label="Priority distribution"
      >
        <div className="priority-donut-centre">
          <strong>{total}</strong>
          <span>items</span>
        </div>
      </div>

      <div className="priority-donut-legend">
        {segments.map((segment) => (
          <div className="donut-legend-row" key={segment.label}>
            <span
              className="donut-dot"
              style={{ background: segment.color }}
            />
            <span>{segment.label}</span>
            <strong>{segment.count}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function ScopeMovementVisual({ history, estimationDisplay = { noun: 'story points', short: 'points' } }) {
  if (!history?.available) {
    return (
      <div className="empty-inline">
        Scope history is not available for this sprint.
      </div>
    );
  }

  const original = Number(
    history.originalCommitment?.storyPoints ?? 0
  );

  const added = Number(
    history.scopeChange?.addedStoryPoints ?? 0
  );

  const removed = Number(
    history.scopeChange?.removedStoryPoints ?? 0
  );

  const estimateChange = Number(
    history.scopeChange?.estimateChangeStoryPoints ?? 0
  );

  const current = Number(
    history.currentScope?.storyPoints ?? 0
  );

  const maxValue = Math.max(
    1,
    original,
    current,
    added,
    removed,
    Math.abs(estimateChange)
  );

  const rows = [
    {
      label: 'Original Commitment',
      value: original,
      className: 'scope-bar-original',
    },
    {
      label: 'Scope Added',
      value: added,
      prefix: '+',
      className: 'scope-bar-added',
    },
    {
      label: 'Scope Removed',
      value: removed,
      prefix: '−',
      className: 'scope-bar-removed',
    },
    {
      label: 'Estimate Revisions',
      value: estimateChange,
      prefix: estimateChange > 0 ? '+' : '',
      className: 'scope-bar-estimate',
    },
    {
      label: 'Current Scope',
      value: current,
      className: 'scope-bar-current',
    },
  ];

  return (
    <div className="scope-movement">
      {rows.map((row) => (
        <div className="scope-movement-row" key={row.label}>
          <span>{row.label}</span>

          <div className="scope-movement-track">
            <div
              className={`scope-movement-bar ${row.className}`}
              style={{
                width: `${Math.max(
                  3,
                  (Math.abs(row.value) / maxValue) * 100
                )}%`,
              }}
            />
          </div>

          <strong>
            {row.prefix}
            {formatNumber(row.value)}
          </strong>
        </div>
      ))}

      <p className="scope-equation">
        {formatNumber(original)} committed
        {' + '}
        {formatNumber(added)} added
        {' − '}
        {formatNumber(removed)} removed
        {' '}
        {estimateChange >= 0 ? '+' : '−'}
        {' '}
        {formatNumber(Math.abs(estimateChange))} estimate revision
        {' = '}
        <strong>{formatNumber(current)} current {estimationDisplay.short}</strong>
      </p>
    </div>
  );
}

function TeamWorkloadBars({ workload }) {
  const people = (workload ?? []).slice(0, 8);
  const maxPoints = Math.max(
    1,
    ...people.map((person) => Number(person.storyPoints ?? 0))
  );

  if (people.length === 0) {
    return (
      <div className="empty-inline">
        No assignee workload is available.
      </div>
    );
  }

  return (
    <div className="workload-bars">
      {people.map((person) => {
        const totalPoints = Number(person.storyPoints ?? 0);
        const remainingPoints = Number(
          person.remainingStoryPoints ?? 0
        );

        const completedPoints = Math.max(
          0,
          totalPoints - remainingPoints
        );

        return (
          <button
            type="button"
            className="workload-bar-row"
            key={person.name}
            onClick={() =>
              openJiraIssues(
                person.issueKeys ?? []
              )
            }
          >
            <span className="workload-name">
              {person.name}
            </span>

            <span className="workload-track">
              <span
                className="workload-completed"
                style={{
                  width: `${
                    (completedPoints / maxPoints) * 100
                  }%`,
                }}
              />
              <span
                className="workload-remaining"
                style={{
                  width: `${
                    (remainingPoints / maxPoints) * 100
                  }%`,
                }}
              />
            </span>

            <strong>{formatNumber(totalPoints)}</strong>
            <small>{formatNumber(remainingPoints)} remaining</small>
          </button>
        );
      })}
    </div>
  );
}

function ProjectWorkloadBars({ workload }) {
  const people = (workload ?? []).slice(0, 8);
  const maxOpen = Math.max(1, ...people.map((person) => Number(person.open ?? 0)));

  if (!people.length) {
    return <div className="empty-inline">No assignee workload data is available.</div>;
  }

  return (
    <div className="project-workload-bars">
      {people.map((person) => {
        const open = Number(person.open ?? 0);
        const overdue = Number(person.overdue ?? 0);
        const safeOverdue = Math.min(open, overdue);
        const nonOverdue = Math.max(0, open - safeOverdue);
        return (
          <div className="project-workload-row" key={person.name}>
            <span className="project-workload-name" title={person.name}>{person.name}</span>
            <span className="project-workload-track">
              <span className="project-workload-open" style={{ width: `${(nonOverdue / maxOpen) * 100}%` }} />
              <span className="project-workload-overdue" style={{ width: `${(safeOverdue / maxOpen) * 100}%` }} />
            </span>
            <strong>{open}</strong>
            <small>{overdue ? `${overdue} overdue` : 'open'}</small>
          </div>
        );
      })}
      <div className="project-workload-legend"><span><i className="project-workload-legend-open" />Open</span><span><i className="project-workload-legend-overdue" />Overdue</span></div>
    </div>
  );
}

function ProjectRagDonut({ ragCounts }) {
  const entries = [
    { label: 'Green', count: Number(ragCounts?.GREEN ?? 0), color: '#22a06b' },
    { label: 'Amber', count: Number(ragCounts?.AMBER ?? 0), color: '#e2b203' },
    { label: 'Red', count: Number(ragCounts?.RED ?? 0), color: '#c9372c' },
  ];
  const total = entries.reduce((sum, item) => sum + item.count, 0);
  let cursor = 0;
  const segments = entries.map((entry) => {
    const percentage = total > 0 ? (entry.count / total) * 100 : 0;
    const start = cursor;
    cursor += percentage;
    return { ...entry, start, end: cursor };
  });
  const gradient = total > 0
    ? `conic-gradient(${segments.filter((segment) => segment.count > 0).map((segment) => `${segment.color} ${segment.start}% ${segment.end}%`).join(', ')})`
    : '#dcdfe4';

  return (
    <div className="status-donut-layout project-rag-donut-layout">
      <div className="status-donut project-rag-donut" style={{ background: gradient }} role="img" aria-label="Team RAG distribution">
        <div className="status-donut-centre"><strong>{formatNumber(total)}</strong><span>teams</span></div>
      </div>
      <div className="status-donut-legend">
        {segments.map((segment) => (
          <div className="donut-legend-row" key={segment.label}>
            <span className="donut-dot" style={{ background: segment.color }} />
            <span>{segment.label}</span>
            <strong>{formatNumber(segment.count)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProjectTeamCompletionBars({ teams }) {
  const rows = (teams ?? []).slice(0, 10);
  if (!rows.length) return <div className="empty-inline">No team completion data is available.</div>;
  return (
    <div className="project-chart-bars">
      {rows.map((team) => {
        const completion = Math.max(0, Math.min(100, Number(team.completion ?? 0)));
        return (
          <div className="project-chart-row" key={team.board?.id ?? team.board?.name}>
            <span className="project-chart-label" title={team.board?.name}>{team.board?.name || 'Team'}</span>
            <span className="project-chart-track">
              <span className={`project-chart-fill project-chart-fill-${String(team.rag?.label ?? 'GREEN').toLowerCase()}`} style={{ width: `${completion}%` }} />
            </span>
            <strong>{formatNumber(completion)}%</strong>
          </div>
        );
      })}
    </div>
  );
}

function ProjectTeamExceptionBars({ teams }) {
  const rows = (teams ?? []).slice(0, 10).map((team) => ({
    team,
    exceptions: Number(team.overdue ?? 0) + Number(team.unresolvedDefects ?? 0) + Number(team.blocked ?? 0),
  }));
  const maxExceptions = Math.max(1, ...rows.map((row) => row.exceptions));
  if (!rows.length) return <div className="empty-inline">No team exception data is available.</div>;

  return (
    <div className="project-exception-bars">
      {rows.map(({ team, exceptions }) => (
        <div className="project-exception-bar-row" key={team.board?.id ?? team.board?.name}>
          <div className="project-exception-bar-heading">
            <strong>{team.board?.name || 'Team'}</strong>
            <span>{formatNumber(team.report?.metrics?.open ?? 0)} open</span>
          </div>
          <div className="project-exception-bar-body">
            <span className="project-exception-track">
              <span
                className={`project-exception-fill ${Number(team.unresolvedDefects ?? 0) || Number(team.blocked ?? 0) ? 'project-exception-fill-danger' : exceptions ? 'project-exception-fill-warning' : 'project-exception-fill-good'}`}
                style={{ width: `${exceptions ? Math.max(4, (exceptions / maxExceptions) * 100) : 0}%` }}
              />
            </span>
            <strong>{formatNumber(exceptions)}</strong>
          </div>
          <div className="project-exception-meta">
            <span>{formatNumber(team.overdue)} overdue</span>
            <span>{formatNumber(team.unresolvedDefects)} defects</span>
            <span>{formatNumber(team.blocked)} blocked</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProjectScopeChangeBars({ teams }) {
  const measured = (teams ?? []).filter((team) => team.hasScopeBaseline).slice(0, 10);
  const unavailable = (teams ?? []).filter((team) => !team.hasScopeBaseline).length;
  const maxAbs = Math.max(1, ...measured.map((team) => Math.abs(Number(team.scopeDeltaPercentage ?? 0))));

  return (
    <div className="project-scope-chart">
      {measured.length ? measured.map((team) => {
        const delta = Number(team.scopeDeltaPercentage ?? 0);
        const width = Math.min(50, (Math.abs(delta) / maxAbs) * 50);
        return (
          <div className="project-scope-row" key={team.board?.id ?? team.board?.name}>
            <span className="project-chart-label" title={team.board?.name}>{team.board?.name || 'Team'}</span>
            <span className="project-scope-track">
              <span className="project-scope-midline" />
              {delta < 0 ? <span className="project-scope-fill project-scope-fill-negative" style={{ width: `${width}%` }} /> : null}
              {delta > 0 ? <span className="project-scope-fill project-scope-fill-positive" style={{ width: `${width}%` }} /> : null}
              {delta === 0 ? <span className="project-scope-zero" /> : null}
            </span>
            <strong className={delta > 0 ? 'project-scope-value-positive' : delta < 0 ? 'project-scope-value-negative' : ''}>{delta > 0 ? '+' : ''}{formatNumber(delta)}%</strong>
          </div>
        );
      }) : <div className="empty-inline">No reliable sprint-start scope baseline is available.</div>}
      {unavailable ? <small className="project-chart-footnote">{formatNumber(unavailable)} team{unavailable === 1 ? '' : 's'} omitted because a reliable sprint-start item baseline is unavailable.</small> : null}
    </div>
  );
}

function ProjectDistributionBars({ counts, emptyLabel = 'No distribution data is available.' }) {
  const rows = Object.entries(counts ?? {})
    .map(([label, count]) => ({ label, count: Number(count ?? 0) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const max = Math.max(1, ...rows.map((row) => row.count));
  if (!rows.length) return <div className="empty-inline">{emptyLabel}</div>;

  return (
    <div className="project-distribution-bars">
      {rows.map((row) => (
        <div className="project-chart-row" key={row.label}>
          <span className="project-chart-label" title={row.label}>{row.label}</span>
          <span className="project-chart-track"><span className="project-chart-fill project-chart-fill-blue" style={{ width: `${(row.count / max) * 100}%` }} /></span>
          <strong>{formatNumber(row.count)}</strong>
        </div>
      ))}
    </div>
  );
}


function SprintProgressStrip({
  report,
  timing,
  deliveryStatus,
  completionTone,
  planningAssessment,
  overallRag,
  nextSprintOutlook,
  velocityReport,
  showDaysRemaining = true,
}) {
  const isFuture = report.sprint.state === 'future';

  const completedPercentage = Math.max(
    0,
    Math.min(
      100,
      Number(report.metrics.storyPointCompletionPercentage) || 0
    )
  );

  const displayedPercentage = isFuture
    ? planningAssessment.score
    : completedPercentage;

  const estimationDisplay = getEstimationDisplay(report);

  return (
    <section
      className={[
        'sprint-progress-strip',
        isFuture ? 'sprint-progress-strip-planning' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className={`overall-rag-pill overall-rag-${overallRag?.tone || 'neutral'}`} title={overallRag?.detail || 'Overall delivery status'}>
        <span>Overall RAG</span>
        <strong>{overallRag?.label || 'NOT SET'}</strong>
      </div>

      <div className="sprint-progress-title">
        <p className="eyebrow">
          {isFuture ? 'Planning Pulse' : 'Executive Pulse'}
        </p>
        <strong>
          {isFuture ? 'Sprint Readiness' : 'Sprint Progress'}
        </strong>
      </div>

      <div className="sprint-progress-bar">
        <span
          className={[
            'sprint-progress-fill',
            isFuture ? 'sprint-planning-fill' : `sprint-progress-fill-${completionTone || deliveryStatus.tone}`,
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ width: `${displayedPercentage}%` }}
        />
      </div>

      <div className="sprint-progress-stat">
        <strong>{displayedPercentage}%</strong>
        <span>{isFuture ? 'Planning Ready' : 'Complete'}</span>
      </div>

      <div className="sprint-progress-stat">
        <strong>
          {formatNumber(report.metrics.committedStoryPoints)}
        </strong>
        <span>{isFuture ? `planned ${estimationDisplay.short}` : `scope ${estimationDisplay.short}`}</span>
      </div>

      <div className="sprint-progress-stat">
        <strong>
          {isFuture
            ? planningAssessment.velocityLoadLabel
            : formatNumber(report.metrics.remainingStoryPoints)}
        </strong>
        <span>
          {isFuture ? 'of average velocity' : `${estimationDisplay.short} remaining`}
        </span>
      </div>

      {(isFuture || showDaysRemaining) ? <div className="sprint-progress-stat">
        <strong>
          {isFuture
            ? planningAssessment.unassignedItems
            : timing.daysRemaining}
        </strong>
        <span>
          {isFuture
            ? 'unassigned items'
            : timing.isClosed
              ? 'closed sprint'
              : 'days left'}
        </span>
      </div> : null}

      <span
        className={`delivery-status-pill delivery-status-${deliveryStatus.tone}`}
      >
        {titleCaseUiLabel(deliveryStatus.label)}
      </span>
    </section>
  );
}


function getExecutiveTimingSnapshot(report) {
  if (!report?.sprint) {
    return { daysRemaining: 0, timeUsedPercentage: 0, isClosed: false };
  }

  const start = new Date(report.sprint.startDate).getTime();
  const plannedEnd = new Date(report.sprint.endDate).getTime();
  const completion = new Date(report.sprint.completeDate ?? report.sprint.endDate).getTime();
  const isClosed = report.sprint.state === 'closed';
  const now = isClosed ? completion : Date.now();

  if (!Number.isFinite(start) || !Number.isFinite(plannedEnd) || plannedEnd <= start) {
    return { daysRemaining: 0, timeUsedPercentage: 0, isClosed };
  }

  const totalDuration = plannedEnd - start;
  const elapsedDuration = Math.max(0, Math.min(totalDuration, now - start));
  return {
    daysRemaining: isClosed
      ? 0
      : Math.max(0, Math.ceil((plannedEnd - Date.now()) / (24 * 60 * 60 * 1000))),
    timeUsedPercentage: Math.round((elapsedDuration / totalDuration) * 100),
    isClosed,
  };
}

function getExecutiveCommentarySnapshot({
  report,
  effort,
  timing,
  deliveryStatus,
  planningAssessment,
  settings = DEFAULT_REPORTING_SETTINGS,
}) {
  const estimationDisplay = getEstimationDisplay(report);
  const effectiveTiming = timing ?? getExecutiveTimingSnapshot(report);
  const isFuture = report?.sprint?.state === 'future';
  const isClosed = report?.sprint?.state === 'closed';
  const acceptanceCriteria = report?.metrics?.acceptanceCriteria ?? planningAssessment?.acceptanceCriteria ?? {};
  const acCoverage = Number(acceptanceCriteria?.coveragePercentage ?? 0);
  const acEligible = Number(acceptanceCriteria?.eligibleStories ?? 0);
  const minimumAcCoverage = Number(settings?.readiness?.minimumAcceptanceCriteriaCoverage ?? 80);
  const minimumEstimateCoverage = Number(settings?.readiness?.minimumRemainingEstimateCoverage ?? 80);
  const estimateCoverage = Number(effort?.coverage?.remainingEstimateCoveragePercentage ?? 0);
  const overdue = Number(report?.metrics?.overdue ?? 0);
  const redOverdue = Number(settings?.rag?.redOverdue ?? 4);
  const amberOverdue = Number(settings?.rag?.amberOverdue ?? 1);

  if (isFuture) {
    const velocityMeta = Number(planningAssessment?.averageVelocity ?? 0) > 0
      ? `${formatNumber(planningAssessment.velocityLoadPercentage)}% of recent average velocity`
      : 'No completed-sprint velocity baseline';
    const planningGaps = [
      Number(planningAssessment?.unassignedItems ?? 0) > 0
        ? `${planningAssessment.unassignedItems} unassigned`
        : null,
      Number(planningAssessment?.unestimatedItems ?? 0) > 0
        ? `${planningAssessment.unestimatedItems} unestimated`
        : null,
    ].filter(Boolean).join(' · ') || 'Ownership and estimation checks passed';

    return {
      statusPrefix: 'Planning status',
      statusLabel: deliveryStatus?.label ?? planningAssessment?.label ?? 'Planning',
      tone: deliveryStatus?.tone ?? planningAssessment?.tone ?? 'neutral',
      progress: {
        label: 'Planned Scope',
        value: `${formatNumber(report?.metrics?.committedStoryPoints ?? 0)} ${estimationDisplay.short}`,
        detail: `${formatNumber(report?.metrics?.total ?? 0)} planned items`,
        meta: velocityMeta,
      },
      forecast: {
        label: 'Planning Readiness',
        value: `${formatNumber(planningAssessment?.score ?? 0)}%`,
        detail: planningAssessment?.label ?? 'Planning assessment',
        meta: planningGaps,
        provisional: false,
      },
      glance: [
        {
          label: 'Planned Items',
          value: formatNumber(report?.metrics?.total ?? 0),
          meta: `${formatNumber(report?.metrics?.committedStoryPoints ?? 0)} ${estimationDisplay.short}`,
          tone: 'neutral',
        },
        {
          label: 'Velocity Load',
          value: Number(planningAssessment?.averageVelocity ?? 0) > 0 ? `${formatNumber(planningAssessment?.velocityLoadPercentage ?? 0)}%` : '—',
          meta: Number(planningAssessment?.averageVelocity ?? 0) > 0 ? 'vs recent average' : 'No baseline yet',
          tone: Number(planningAssessment?.velocityLoadPercentage ?? 0) > Number(settings?.readiness?.maximumNextSprintVelocityLoad ?? 115) ? 'warning' : 'positive',
        },
        {
          label: 'Unassigned',
          value: formatNumber(planningAssessment?.unassignedItems ?? 0),
          meta: Number(planningAssessment?.unassignedItems ?? 0) > 0 ? 'Needs ownership' : 'Ownership covered',
          tone: Number(planningAssessment?.unassignedItems ?? 0) > 0 ? 'warning' : 'positive',
        },
        {
          label: 'AC Coverage',
          value: acEligible > 0 ? `${formatNumber(acCoverage)}%` : 'N/A',
          meta: acEligible > 0 ? `${formatNumber(acceptanceCriteria?.detectedStories ?? 0)}/${formatNumber(acEligible)} stories` : 'No eligible stories',
          tone: acEligible === 0 ? 'neutral' : acCoverage < minimumAcCoverage ? 'negative' : 'positive',
        },
      ],
    };
  }

  const progressMeta = isClosed || effectiveTiming.isClosed
    ? 'Sprint closed'
    : `${formatNumber(effectiveTiming.timeUsedPercentage)}% of timebox elapsed · ${formatNumber(effectiveTiming.daysRemaining)} ${effectiveTiming.daysRemaining === 1 ? 'day' : 'days'} remaining`;

  let forecast = {
    label: 'Forecast',
    value: 'No effort forecast',
    detail: 'Original/remaining estimate data is unavailable',
    meta: '',
    provisional: false,
  };

  if (effort) {
    const varianceHours = Number(effort.varianceHours ?? 0);
    const variancePercentage = Number(effort.variancePercentage ?? 0);
    forecast = {
      label: 'Forecast',
      value: formatHours(effort.forecastHours),
      detail: `vs. ${formatHours(effort.originalEstimateHours)} original estimate`,
      meta: `${effort.forecastProvisional ? 'Provisional variance' : 'Variance'}: ${formatHours(varianceHours)} / ${formatNumber(variancePercentage)}%`,
      provisional: Boolean(effort.forecastProvisional),
    };
  }

  return {
    statusPrefix: isClosed ? 'Sprint Outcome' : 'Sprint Status',
    statusLabel: deliveryStatus?.label ?? 'Not Calculated',
    tone: deliveryStatus?.tone ?? 'neutral',
    progress: {
      label: 'Progress',
      value: `${formatNumber(report?.metrics?.storyPointCompletionPercentage ?? 0)}% Complete`,
      detail: `${formatNumber(report?.metrics?.completedStoryPoints ?? 0)} / ${formatNumber(report?.metrics?.committedStoryPoints ?? 0)} ${estimationDisplay.short}`,
      meta: progressMeta,
    },
    forecast,
    glance: [
      {
        label: 'Timebox',
        value: isClosed || effectiveTiming.isClosed ? 'Closed' : `${formatNumber(effectiveTiming.timeUsedPercentage)}%`,
        meta: isClosed || effectiveTiming.isClosed
          ? 'Sprint completed'
          : `${formatNumber(effectiveTiming.daysRemaining)} ${effectiveTiming.daysRemaining === 1 ? 'day' : 'days'} left`,
        tone: !isClosed && !effectiveTiming.isClosed && Number(effectiveTiming.timeUsedPercentage) >= 90 && Number(report?.metrics?.storyPointCompletionPercentage ?? 0) < 90 ? 'warning' : 'neutral',
      },
      {
        label: 'Overdue',
        value: formatNumber(overdue),
        meta: overdue === 0 ? 'No overdue open work' : `${overdue} open ${overdue === 1 ? 'item' : 'items'}`,
        tone: overdue >= redOverdue ? 'negative' : overdue >= amberOverdue ? 'warning' : 'positive',
      },
      {
        label: 'Estimate Coverage',
        value: effort ? `${formatNumber(estimateCoverage)}%` : 'N/A',
        meta: effort ? 'Remaining Estimate' : 'No effort data',
        tone: !effort ? 'neutral' : estimateCoverage < minimumEstimateCoverage ? 'warning' : 'positive',
      },
      {
        label: 'AC Coverage',
        value: acEligible > 0 ? `${formatNumber(acCoverage)}%` : 'N/A',
        meta: acEligible > 0 ? `${formatNumber(acceptanceCriteria?.detectedStories ?? 0)}/${formatNumber(acEligible)} stories` : 'No eligible stories',
        tone: acEligible === 0 ? 'neutral' : acCoverage < minimumAcCoverage ? 'negative' : 'positive',
      },
    ],
  };
}

function ExecutiveCommentaryBullet({ text }) {
  const value = String(text ?? '').trim();
  const match = value.match(/^([^:]{2,42}):\s*(.+)$/);
  return (
    <li>
      {match ? <><strong>{match[1]}:</strong> {match[2]}</> : value}
    </li>
  );
}

function ExecutiveCommentaryPreview({
  snapshot,
  sections,
  outlookSummary,
  showSummary = false,
  summaryTitle = 'Executive Note',
  outlookTitle = 'Next Sprint Outlook',
}) {
  const risks = sections?.risks ?? [];
  const actions = sections?.actions ?? [];
  const outlook = sections?.outlook?.length
    ? sections.outlook
    : outlookSummary
      ? [
          `Load: ${outlookSummary.sprintName} · ${formatNumber(outlookSummary.plannedPoints)} planned points / ${formatNumber(outlookSummary.plannedItems)} items / ${formatNumber(outlookSummary.carryOverItems)} carry-over`,
          `Goal: ${outlookSummary.goal}`,
        ]
      : [];
  const planning = sections?.planning?.length
    ? sections.planning
    : (outlookSummary?.risks ?? []).map((item) => `Quality / planning check: ${item}`);

  return (
    <div className="executive-commentary-view" aria-label="Executive Commentary at a Glance">
      <div className="executive-commentary-status-row">
        <span className={`executive-status-badge executive-status-${snapshot.tone ?? 'neutral'}`}>
          <span className="executive-status-dot" aria-hidden="true" />
          <span>{titleCaseUiLabel(snapshot.statusPrefix)}:</span>
          <strong>{titleCaseUiLabel(snapshot.statusLabel)}</strong>
        </span>
      </div>

      {snapshot.glance?.length ? (
        <section className="executive-at-a-glance" aria-label="At a Glance">
          <div className="executive-at-a-glance-title">At a Glance</div>
          <div className="executive-at-a-glance-grid">
            {snapshot.glance.map((item) => (
              <div className={`executive-glance-item executive-glance-${item.tone ?? 'neutral'}`} key={item.label}>
                <span className="executive-glance-label">{titleCaseUiLabel(item.label)}</span>
                <strong className="executive-glance-value">{item.value}</strong>
                <span className="executive-glance-meta">{item.meta}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="executive-commentary-callouts">
        {[snapshot.progress, snapshot.forecast].map((callout) => (
          <div className="executive-commentary-callout" key={callout.label}>
            <div className="executive-commentary-callout-label">
              {titleCaseUiLabel(callout.label)}
              {callout.provisional ? <span className="executive-mini-badge">Provisional</span> : null}
            </div>
            <div className="executive-commentary-callout-value">{callout.value}</div>
            <div className="executive-commentary-callout-detail">{callout.detail}</div>
            {callout.meta ? <div className="executive-commentary-callout-meta">{callout.meta}</div> : null}
          </div>
        ))}
      </div>

      {showSummary && sections?.summary?.length ? (
        <section className="executive-commentary-note">
          <div className="executive-commentary-note-heading">{summaryTitle}</div>
          <ul>{sections.summary.slice(0, 3).map((item, index) => <ExecutiveCommentaryBullet key={`summary-${index}`} text={item} />)}</ul>
        </section>
      ) : null}

      <div className="executive-commentary-sections">
        <section className={`executive-commentary-section executive-commentary-risks ${risks.length === 1 && /^No material/i.test(risks[0]) ? 'executive-commentary-clear' : ''}`}>
          <div className="executive-commentary-section-heading">
            <span className="executive-section-icon" aria-hidden="true">!</span>
            <h4>Key Risks</h4>
          </div>
          <ul>{risks.map((item, index) => <ExecutiveCommentaryBullet key={`risk-${index}`} text={item} />)}</ul>
        </section>

        <section className="executive-commentary-section executive-commentary-actions">
          <div className="executive-commentary-section-heading">
            <span className="executive-section-icon" aria-hidden="true">→</span>
            <h4>Recommended Actions</h4>
          </div>
          <ul>{actions.map((item, index) => <ExecutiveCommentaryBullet key={`action-${index}`} text={item} />)}</ul>
        </section>

        {outlook.length ? (
          <section className="executive-commentary-section executive-commentary-outlook">
            <div className="executive-commentary-section-heading">
              <span className="executive-section-icon" aria-hidden="true">↗</span>
              <h4>{outlookTitle}</h4>
            </div>
            <ul>{outlook.map((item, index) => <ExecutiveCommentaryBullet key={`outlook-${index}`} text={item} />)}</ul>
            {planning.length ? (
              <div className="executive-planning-checks">
                {planning.map((item, index) => <span key={`planning-${index}`}>{item}</span>)}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

function ManagementSummary({
  report,
  history,
  effort,
  timing,
  readiness,
  deliveryStatus,
  planningAssessment,
  nextSprintOutlook,
  velocityReport,
  commentaryOverlay,
  commentaryText,
  commentarySaving,
  commentaryNotice,
  onCommentaryTextChange,
  onSaveCommentary,
  onResetCommentary,
  settings = DEFAULT_REPORTING_SETTINGS,
  readOnly = false,
  commentaryStale = false,
}) {
  const isFuture = report.sprint.state === 'future';
  const isClosed = report.sprint.state === 'closed';
  const estimationDisplay = getEstimationDisplay(report);
  const [showCommentaryEditor, setShowCommentaryEditor] = useState(false);

  const summaryItems = [];
  const riskItems = [];
  const mitigationItems = [];
  const outlookSummary = buildNextSprintOutlookSummary(
    nextSprintOutlook,
    velocityReport
  );

  if (isFuture) {
    summaryItems.push(
      `${report.sprint.name} has not started. It currently contains ${report.metrics.total} work items totalling ${formatNumber(
        report.metrics.committedStoryPoints
      )} ${estimationDisplay.noun}.`
    );

    if (planningAssessment.averageVelocity > 0) {
      summaryItems.push(
        `Planned scope is ${planningAssessment.velocityLoadPercentage}% of the recent average completed velocity of ${formatNumber(
          planningAssessment.averageVelocity
        )} ${estimationDisplay.short}.`
      );
    } else {
      summaryItems.push(
        'No completed-sprint velocity baseline is available yet, so capacity fit cannot be benchmarked.'
      );
    }

    if (planningAssessment.unassignedItems > 0) {
      riskItems.push(
        `${planningAssessment.unassignedItems} ${
          planningAssessment.unassignedItems === 1 ? 'item is' : 'items are'
        } unassigned.`
      );
      mitigationItems.push(
        'Assign ownership: Confirm an owner for every planned work item before starting the sprint.'
      );
    }

    if (planningAssessment.unestimatedItems > 0) {
      riskItems.push(
        `${planningAssessment.unestimatedItems} ${
          planningAssessment.unestimatedItems === 1 ? 'item has' : 'items have'
        } no ${estimationDisplay.noun} estimate.`
      );
      mitigationItems.push(
        'Validate estimates: Estimate all material work items and confirm the sprint total against recent velocity.'
      );
    }

    if (planningAssessment.acceptanceCriteria?.eligibleStories > 0) {
      summaryItems.push(
        `Acceptance Criteria are identifiable in ${planningAssessment.acceptanceCriteria.detectedStories} of ${planningAssessment.acceptanceCriteria.eligibleStories} Stories (${formatNumber(planningAssessment.acceptanceCriteria.coveragePercentage)}%), with ${planningAssessment.acceptanceCriteria.totalCriteria ?? 0} individual criteria identified.`
      );
      if ((planningAssessment.acceptanceCriteria.trackableCriteria ?? 0) > 0) {
        summaryItems.push(`${planningAssessment.acceptanceCriteria.metCriteria ?? 0} criteria are explicitly Met, ${planningAssessment.acceptanceCriteria.notMetCriteria ?? 0} are explicitly Not met, and ${planningAssessment.acceptanceCriteria.unrecordedCriteria ?? 0} have no recorded completion state.`);
      } else if ((planningAssessment.acceptanceCriteria.totalCriteria ?? 0) > 0) {
        summaryItems.push(`${planningAssessment.acceptanceCriteria.unrecordedCriteria ?? 0} criteria have no explicit Jira completion state; StatusDeck does not infer completion from plain text.`);
      }
      if (planningAssessment.acceptanceCriteria.missingStories > 0) {
        riskItems.push(
          `${planningAssessment.acceptanceCriteria.missingStories} ${planningAssessment.acceptanceCriteria.missingStories === 1 ? 'Story is' : 'Stories are'} missing identifiable Acceptance Criteria.`
        );
        mitigationItems.push(
          'Complete Acceptance Criteria: Refine the flagged Stories before sprint activation using the configured Acceptance Criteria source.'
        );
      }
    } else {
      summaryItems.push(
        'No Story issues are available in the selected future sprint for Acceptance Criteria coverage assessment.'
      );
    }

    if (!planningAssessment.hasSprintGoal) {
      riskItems.push('No sprint goal has been entered.');
      mitigationItems.push(
        'Confirm sprint goal: Add a measurable sprint goal so the team and stakeholders share the same outcome.'
      );
    }

    const currentAcceptanceCriteria = report.metrics?.acceptanceCriteria ?? null;
    const minimumAcceptanceCriteriaCoverage = Number(settings?.readiness?.minimumAcceptanceCriteriaCoverage ?? 80);
    if (currentAcceptanceCriteria?.eligibleStories > 0) {
      summaryItems.push(`Acceptance Criteria coverage is ${formatNumber(currentAcceptanceCriteria.coveragePercentage)}% (${currentAcceptanceCriteria.detectedStories}/${currentAcceptanceCriteria.eligibleStories} Stories) using ${report.acceptanceCriteriaSource?.name || 'Jira Description'}.`);
      if (Number(currentAcceptanceCriteria.coveragePercentage ?? 0) < minimumAcceptanceCriteriaCoverage) {
        riskItems.push(`Quality readiness risk: Acceptance Criteria coverage is ${formatNumber(currentAcceptanceCriteria.coveragePercentage)}%, below the configured ${minimumAcceptanceCriteriaCoverage}% minimum.`);
        mitigationItems.push('Complete Acceptance Criteria: Review the flagged Stories and complete Acceptance Criteria before sprint or release sign-off.');
      }
    }

    if (report.metrics.overdue > 0) {
      riskItems.push(
        `${report.metrics.overdue} planned ${
          report.metrics.overdue === 1 ? 'item is' : 'items are'
        } already overdue before sprint start.`
      );
      mitigationItems.push(
        'Review overdue scope: Re-baseline, remove, or prioritise overdue items before activation.'
      );
    }

    if (report.metrics.defects > 0) {
      riskItems.push(
        `${report.metrics.defects} defects are included in the proposed sprint scope.`
      );
    }

    if (planningAssessment.velocityLoadPercentage > 115) {
      riskItems.push(
        `Planned scope is ${planningAssessment.velocityLoadPercentage}% of recent average velocity, indicating a capacity concern.`
      );
      mitigationItems.push(
        'Rebalance capacity: Reduce scope, split larger items, or confirm additional capacity before starting the sprint.'
      );
    } else if (
      planningAssessment.velocityLoadPercentage > 0 &&
      planningAssessment.velocityLoadPercentage < 60
    ) {
      riskItems.push(
        `Planned scope is only ${planningAssessment.velocityLoadPercentage}% of recent average velocity and may be under-planned.`
      );
      mitigationItems.push(
        'Confirm capacity: Decide whether additional ready work should be included or whether reduced capacity is intentional.'
      );
    }

    if (
      Number(
        effort?.coverage?.originalEstimateCoveragePercentage ?? 0
      ) < 80
    ) {
      riskItems.push(
        `Original Estimate coverage is ${formatNumber(
          effort?.coverage?.originalEstimateCoveragePercentage ?? 0
        )}%.`
      );
      mitigationItems.push(
        'Validate estimates: Complete effort estimates for planned items so capacity and forecast reporting are reliable.'
      );
    }
  } else {
    summaryItems.push(
      `${report.metrics.storyPointCompletionPercentage}% of current sprint ${estimationDisplay.noun} are complete (${formatNumber(
        report.metrics.completedStoryPoints
      )} of ${formatNumber(report.metrics.committedStoryPoints)}).`
    );

    if (history?.available) {
      const original = Number(
        history.originalCommitment?.storyPoints ?? 0
      );

      const current = Number(
        history.currentScope?.storyPoints ?? 0
      );

      const difference = current - original;

      if (difference === 0) {
        summaryItems.push(
          `Current scope remains aligned to the ${formatNumber(
            original
          )} ${estimationDisplay.short} sprint-start commitment.`
        );
      } else {
        summaryItems.push(
          `Current scope is ${formatNumber(
            Math.abs(difference)
          )} ${estimationDisplay.short} ${difference > 0 ? 'above' : 'below'} the sprint-start commitment.`
        );
      }
    }

    if (effort) {
      const varianceHours = Number(effort.varianceHours ?? 0);
      const variancePercentage = Number(
        effort.variancePercentage ?? 0
      );

      if (effort.forecastProvisional) {
        summaryItems.push(
          `The current forecast is ${formatHours(
            effort.forecastHours
          )} against an original estimate of ${formatHours(
            effort.originalEstimateHours
          )}, showing a provisional variance of ${formatHours(
            varianceHours
          )} (${formatNumber(variancePercentage)}%).`
        );

        riskItems.push(
          `Estimate-quality risk: Remaining Estimate coverage is ${formatNumber(
            effort.coverage?.remainingEstimateCoveragePercentage ?? 0
          )}%, so forecast effort may be understated.`
        );

        const missingRemainingItems = Math.max(
          0,
          Number(effort.coverage?.remainingEstimateEligibleItems ?? 0) -
            Number(effort.coverage?.remainingEstimateCoveredItems ?? 0)
        );
        mitigationItems.push(
          missingRemainingItems > 0
            ? `Validate estimates: Require immediate Remaining Estimate updates for ${missingRemainingItems} incomplete ${missingRemainingItems === 1 ? 'item' : 'items'} with missing or zero values, then revalidate the forecast.`
            : 'Validate estimates: Require Remaining Estimate updates for all open items and revalidate whether the apparent variance reflects real efficiency or missing data.'
        );
      } else if (varianceHours > 0) {
        summaryItems.push(
          `Forecast effort is ${formatHours(
            varianceHours
          )} (${formatNumber(
            variancePercentage
          )}%) above the original estimate.`
        );

        riskItems.push(
          'Potential schedule and cost exposure exists because forecast effort exceeds the original estimate.'
        );

        mitigationItems.push(
          'Review effort variance: Confirm the main effort drivers, ownership, and corrective actions or revised delivery expectations.'
        );
      } else if (varianceHours < 0) {
        summaryItems.push(
          `Forecast effort is ${formatHours(
            Math.abs(varianceHours)
          )} (${formatNumber(
            Math.abs(variancePercentage)
          )}%) below the original estimate.`
        );

        mitigationItems.push(
          'Validate favourable variance: Confirm complete time and Remaining Estimate data before treating the variance as realised efficiency.'
        );
      } else {
        summaryItems.push(
          'Forecast effort currently aligns with the original estimate.'
        );
      }
    }

    if (report.metrics.overdue > 0) {
      riskItems.push(
        `Schedule risk: ${report.metrics.overdue} overdue open ${
          report.metrics.overdue === 1 ? 'item requires' : 'items require'
        } management attention.`
      );

      mitigationItems.push(
        isClosed
          ? 'Review overdue scope: Replan unfinished overdue work into the next sprint with a confirmed owner and revised due date.'
          : 'Review overdue scope: Reassess overdue items with owners at the next delivery checkpoint and confirm recovery dates or scope removal.'
      );
    }

    if (report.metrics.defects > 0) {
      riskItems.push(
        `Quality risk: ${report.metrics.defects} defects were included in the sprint scope; ${readiness.openDefects ?? 0} remain unresolved.`
      );

      mitigationItems.push(
        'Resolve quality blockers: Prioritise unresolved high-severity defects and confirm release acceptance criteria before deployment.'
      );
    }

    if (!timing.isClosed) {
      summaryItems.push(
        `${timing.daysRemaining} calendar days remain and ${timing.timeUsedPercentage}% of the sprint timebox has elapsed.`
      );
    }
  }

  const publishedText = commentaryOverlay?.state === 'published' && commentaryOverlay?.published
    ? commentaryOverlay.published
    : '';
  const draftText = commentaryOverlay?.state === 'draft' && commentaryOverlay?.draft
    ? commentaryOverlay.draft
    : '';

  const generatedCommentaryText = [
    'Summary',
    ...summaryItems.map((item) => `• ${item}`),
    riskItems.length ? '\nKey Risks' : '',
    ...riskItems.map((item) => `• ${item}`),
    mitigationItems.length ? '\nRecommended Actions' : '',
    ...[...new Set(mitigationItems)].map((item) => `• ${item}`),
    outlookSummary ? '\nNext Sprint Outlook' : '',
    outlookSummary ? `• Load: ${outlookSummary.sprintName} · ${outlookSummary.plannedPoints} planned ${estimationDisplay.short} / ${outlookSummary.plannedItems} items / ${outlookSummary.carryOverItems} carry-over.` : '',
    outlookSummary?.goal ? `• Goal: ${outlookSummary.goal}` : '',
    outlookSummary?.risks?.length ? '\nPlanning checks' : '',
    ...(outlookSummary?.risks ?? []).map((item) => `• ${/defect|acceptance criteria/i.test(item) ? 'Quality check' : 'Planning check'}: ${item}`),
  ].filter(Boolean).join('\n');

  const editableCommentaryText = commentaryText || publishedText || draftText || generatedCommentaryText;
  const hasSavedOrEditedCommentary = Boolean(commentaryText || publishedText || draftText);
  const commentarySections = parseManagementCommentaryForExport(editableCommentaryText, {
    summary: summaryItems,
    risks: riskItems,
    actions: [...new Set(mitigationItems)],
  });
  const executiveSnapshot = getExecutiveCommentarySnapshot({
    report,
    effort,
    timing,
    deliveryStatus,
    planningAssessment,
    settings,
  });

  return (
    <article className="dashboard-card management-summary-card commentary-editor-card">
      <div className="dashboard-card-heading">
        <div>
          <p className="eyebrow">Management Commentary</p>
          <h3>Executive Commentary</h3>
        </div>
        <div className="commentary-state-actions no-export">
          <span className={`commentary-state-pill commentary-state-${commentaryOverlay?.state ?? 'generated'}`}>
            {commentaryOverlay?.state ?? 'generated'}
          </span>
        </div>
      </div>

      <div className="commentary-inline-editor">
        {commentaryStale && !readOnly ? (
          <div className="commentary-stale-warning no-export" role="status">Saved commentary was created from an earlier report snapshot. Review and republish it before it is included in export.</div>
        ) : null}

        <ExecutiveCommentaryPreview
          snapshot={executiveSnapshot}
          sections={commentarySections}
          outlookSummary={outlookSummary}
          showSummary={hasSavedOrEditedCommentary}
        />

        {!readOnly ? (
          <div className="commentary-editor-actions no-export executive-commentary-editor-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setShowCommentaryEditor((current) => !current)}
              aria-expanded={showCommentaryEditor}
            >
              {showCommentaryEditor ? 'Close editor' : 'Edit commentary'}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onSaveCommentary('draft', editableCommentaryText)}
              disabled={commentarySaving || !editableCommentaryText.trim()}
            >
              {commentarySaving ? 'Saving…' : 'Save draft'}
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() => onSaveCommentary('published', editableCommentaryText)}
              disabled={commentarySaving || !editableCommentaryText.trim()}
            >
              Publish
            </button>
            <button type="button" className="text-link" onClick={onResetCommentary}>
              Restore Generated
            </button>
            {commentaryNotice ? (
              <span
                className={`commentary-save-feedback commentary-save-feedback-${commentaryNotice.tone ?? 'success'}`}
                role="status"
                aria-live="polite"
              >
                {commentaryNotice.message}
              </span>
            ) : null}
          </div>
        ) : null}

        {!readOnly && showCommentaryEditor ? (
          <div className="executive-commentary-edit-panel no-export">
            <div className="executive-commentary-edit-heading">
              <strong>Edit Published Narrative</strong>
              <span>The executive view above updates immediately from these sections while live Jira metrics stay current.</span>
            </div>
            <textarea
              rows="11"
              value={editableCommentaryText}
              onChange={(event) => onCommentaryTextChange(event.target.value)}
              aria-label="Management Commentary"
              title="Edit the generated management commentary directly. Save as Draft while working, then Publish when approved."
            />
          </div>
        ) : null}
      </div>
    </article>
  );

}

function BurndownChart({
  points,
  basis,
  view,
  sprintEndDate,
  provisional = false,
  coveragePercentage = 100,
}) {
  const chartPoints = Array.isArray(points)
    ? points.filter((point) => {
        const timestamp = new Date(point?.timestamp).getTime();
        return Number.isFinite(timestamp);
      })
    : [];

  if (chartPoints.length < 2) {
    return (
      <div className="empty-inline">
        Burndown needs at least two data points.
      </div>
    );
  }

  const width = 1100;
  const height = 320;

  const padding = {
    top: 24,
    right: 34,
    bottom: 72,
    left: 68,
  };

  const chartWidth =
    width -
    padding.left -
    padding.right;

  const chartHeight =
    height -
    padding.top -
    padding.bottom;

  const usesEffort =
    basis === 'effort';

  const valueKey =
    usesEffort
      ? 'remainingEffortHours'
      : 'remainingPoints';

  const idealKey =
    usesEffort
      ? 'idealRemainingEffortHours'
      : 'idealRemainingPoints';

  const sortedPoints = [...chartPoints].sort(
    (a, b) =>
      new Date(a.timestamp).getTime() -
      new Date(b.timestamp).getTime()
  );

  const firstTimestamp =
    new Date(sortedPoints[0].timestamp).getTime();

  const lastActualTimestamp =
    new Date(
      sortedPoints[sortedPoints.length - 1].timestamp
    ).getTime();

  const configuredEndTimestamp =
    new Date(sprintEndDate).getTime();

  const chartEndTimestamp =
    Number.isFinite(configuredEndTimestamp) &&
    configuredEndTimestamp > firstTimestamp
      ? Math.max(
          configuredEndTimestamp,
          lastActualTimestamp
        )
      : Math.max(
          lastActualTimestamp,
          firstTimestamp + 1
        );

  const timeRange = Math.max(
    1,
    chartEndTimestamp - firstTimestamp
  );

  const initialIdealValue = Math.max(
    0,
    Number(
      sortedPoints[0]?.[idealKey] ??
      sortedPoints[0]?.[valueKey] ??
      0
    ) || 0
  );

  const maxValue = Math.max(
    1,
    initialIdealValue,
    ...sortedPoints.map((point) =>
      Number(point[valueKey] ?? 0)
    )
  );

  function xPosition(timestamp) {
    const time = new Date(timestamp).getTime();

    return (
      padding.left +
      ((time - firstTimestamp) / timeRange) *
        chartWidth
    );
  }

  function yPosition(value) {
    return (
      padding.top +
      chartHeight -
      (Number(value ?? 0) / maxValue) *
        chartHeight
    );
  }

  const actualPath = sortedPoints.reduce(
    (path, point, index) => {
      const x = xPosition(point.timestamp);
      const y = yPosition(point[valueKey]);

      if (index === 0) {
        return `M ${x} ${y}`;
      }

      return `${path} H ${x} V ${y}`;
    },
    ''
  );

  const idealPath = [
    `M ${xPosition(sortedPoints[0].timestamp)} ${yPosition(initialIdealValue)}`,
    `L ${xPosition(chartEndTimestamp)} ${yPosition(0)}`,
  ].join(' ');

  const yTicks = Array.from(
    { length: 6 },
    (_, index) => {
      const value =
        maxValue -
        (index / 5) * maxValue;

      return {
        value,
        y:
          padding.top +
          (index / 5) * chartHeight,
      };
    }
  );

  const shouldShowSprintEndLabel =
    chartEndTimestamp >
    lastActualTimestamp + 60 * 1000;

  /*
   * Event timestamps can be only seconds or minutes apart while the
   * chart spans an entire sprint. Rendering every timestamp on the
   * time-scaled axis makes the labels unreadable. Select only labels
   * that have enough visual separation, always retaining the first
   * and latest actual timestamps. When those two timestamps are still
   * too close, move the latest label to a second row and connect it to
   * its true X position with a small guide line. Exact times remain
   * available from each point's native SVG tooltip.
   */
  const minimumLabelGap = view === 'live' ? 125 : 95;

  const actualLabelCandidates = sortedPoints.map(
    (point, index) => ({
      point,
      index,
      actualX: xPosition(point.timestamp),
    })
  );

  const selectedXAxisLabels = [];

  if (actualLabelCandidates.length > 0) {
    const first = actualLabelCandidates[0];

    selectedXAxisLabels.push({
      ...first,
      displayX: first.actualX,
      row: 0,
      textAnchor: 'middle',
    });

    for (
      let index = 1;
      index < actualLabelCandidates.length - 1;
      index += 1
    ) {
      const candidate = actualLabelCandidates[index];
      const previous =
        selectedXAxisLabels[selectedXAxisLabels.length - 1];

      if (
        candidate.actualX - previous.displayX >= minimumLabelGap &&
        width - padding.right - candidate.actualX >= minimumLabelGap / 2
      ) {
        selectedXAxisLabels.push({
          ...candidate,
          displayX: candidate.actualX,
          row: 0,
          textAnchor: 'middle',
        });
      }
    }

    if (actualLabelCandidates.length > 1) {
      const last =
        actualLabelCandidates[actualLabelCandidates.length - 1];
      const previous =
        selectedXAxisLabels[selectedXAxisLabels.length - 1];

      if (last.index !== previous.index) {
        const overlaps =
          last.actualX - previous.displayX < minimumLabelGap;

        selectedXAxisLabels.push({
          ...last,
          displayX: overlaps
            ? Math.min(
                width - padding.right - 8,
                Math.max(
                  last.actualX + minimumLabelGap,
                  previous.displayX + minimumLabelGap
                )
              )
            : last.actualX,
          row: overlaps ? 1 : 0,
          textAnchor: overlaps ? 'start' : 'middle',
          guided: overlaps,
        });
      }
    }
  }

  return (
    <div className="burndown-container">
      {usesEffort && provisional ? (
        <div className="burndown-warning">
          Remaining Estimate coverage is{' '}
          <strong>
            {formatNumber(coveragePercentage)}%
          </strong>
          . This effort burndown is provisional and may not
          represent the true remaining work.
        </div>
      ) : null}

      <div className="chart-legend">
        <span className="legend-item">
          <span className="legend-line actual-line" />
          Actual Remaining
        </span>

        <span className="legend-item">
          <span className="legend-line ideal-line" />
          Ideal Remaining
        </span>
      </div>

      <div className="burndown-scroll">
        <svg
          className="burndown-chart"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Sprint burndown chart"
        >
          {yTicks.map((tick) => (
            <g key={tick.y}>
              <line
                x1={padding.left}
                y1={tick.y}
                x2={width - padding.right}
                y2={tick.y}
                className="chart-grid-line"
              />

              <text
                x={padding.left - 10}
                y={tick.y + 4}
                textAnchor="end"
                className="chart-axis-label"
              >
                {formatNumber(tick.value)}
              </text>
            </g>
          ))}

          <line
            x1={padding.left}
            y1={padding.top}
            x2={padding.left}
            y2={height - padding.bottom}
            className="chart-axis-line"
          />

          <line
            x1={padding.left}
            y1={height - padding.bottom}
            x2={width - padding.right}
            y2={height - padding.bottom}
            className="chart-axis-line"
          />

          <path
            d={idealPath}
            className="burndown-ideal"
          />

          <path
            d={actualPath}
            className="burndown-actual"
          />

          {sortedPoints.map((point, index) => (
            <circle
              key={`${point.timestamp}-${index}`}
              cx={xPosition(point.timestamp)}
              cy={yPosition(point[valueKey])}
              r="3"
              className="burndown-point"
            >
              <title>
                {`${point.label ??
                  formatDate(point.timestamp)}: ${
                  usesEffort
                    ? formatHours(point[valueKey])
                    : `${formatNumber(
                        point[valueKey]
                      )} story points`
                } remaining`}
              </title>
            </circle>
          ))}

          {selectedXAxisLabels.map((label) => (
            <g
              key={`label-${label.point.timestamp}-${label.index}`}
            >
              {label.guided ? (
                <path
                  d={[
                    `M ${label.actualX} ${
                      height - padding.bottom + 5
                    }`,
                    `V ${
                      height - padding.bottom + 18
                    }`,
                    `H ${label.displayX - 5}`,
                  ].join(' ')}
                  className="chart-label-guide"
                />
              ) : null}

              <text
                x={label.displayX}
                y={
                  height -
                  padding.bottom +
                  30 +
                  label.row * 20
                }
                textAnchor={label.textAnchor}
                className="chart-date-label"
              >
                {formatShortDate(
                  label.point.timestamp,
                  view === 'live'
                )}
              </text>
            </g>
          ))}

          {shouldShowSprintEndLabel ? (
            <text
              x={xPosition(chartEndTimestamp)}
              y={height - padding.bottom + 30}
              textAnchor="end"
              className="chart-date-label chart-sprint-end-label"
            >
              {formatShortDate(chartEndTimestamp, false)}
            </text>
          ) : null}

          <text
            x={20}
            y={padding.top + chartHeight / 2}
            transform={`rotate(-90 20 ${
              padding.top + chartHeight / 2
            })`}
            textAnchor="middle"
            className="chart-title-label"
          >
            {usesEffort
              ? 'Remaining Effort (Hours)'
              : 'Remaining Story Points'}
          </text>
        </svg>
      </div>
    </div>
  );
}

function HistoryEventsTable({ events }) {
  const historyEvents = Array.isArray(events) ? events : [];

  if (historyEvents.length === 0) {
    return (
      <div className="empty-inline">
        No sprint scope or estimate changes have been
        detected after sprint start.
      </div>
    );
  }

  const latestEvents = [...historyEvents]
    .sort(
      (a, b) =>
        new Date(b.time).getTime() -
        new Date(a.time).getTime()
    )
    .slice(0, 20);

  function describeEvent(event) {
    if (event.type === 'scope-added') {
      return `Added to sprint with ${formatNumber(
        event.storyPoints
      )} points and ${formatHours(
        event.originalEstimateHours
      )} original estimate`;
    }

    if (event.type === 'scope-removed') {
      return `Removed from sprint with ${formatNumber(
        event.storyPoints
      )} points and ${formatHours(
        event.originalEstimateHours
      )} original estimate`;
    }

    if (event.type === 'estimate-changed') {
      const sign =
        Number(event.delta) > 0
          ? '+'
          : '';

      return `Story points changed from ${formatNumber(
        event.beforeEstimate
      )} to ${formatNumber(
        event.afterEstimate
      )} (${sign}${formatNumber(
        event.delta
      )})`;
    }

    if (
      event.type ===
      'original-estimate-changed'
    ) {
      return `Original estimate changed from ${formatHours(
        event.beforeHours
      )} to ${formatHours(
        event.afterHours
      )}`;
    }

    if (
      event.type ===
      'remaining-estimate-changed'
    ) {
      return `Remaining estimate changed from ${formatHours(
        event.beforeHours
      )} to ${formatHours(
        event.afterHours
      )}`;
    }

    if (
      event.type ===
      'time-spent-changed'
    ) {
      return `Time spent changed from ${formatHours(
        event.beforeHours
      )} to ${formatHours(
        event.afterHours
      )}`;
    }

    if (event.type === 'status-changed') {
      return `Status changed from ${
        event.beforeStatus ||
        'Unknown'
      } to ${
        event.afterStatus ||
        'Unknown'
      }`;
    }

    return event.type;
  }

  return (
    <div className="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Key</th>
            <th>Change</th>
          </tr>
        </thead>

        <tbody>
          {latestEvents.map((event, index) => (
            <tr
              key={`${event.issueId}-${event.time}-${index}`}
            >
              <td>{formatDate(event.time)}</td>

              <td>
                <button
                  type="button"
                  className="issue-key-link"
                  onClick={() => openJiraIssue(event.key)}
                >
                  {event.key} ↗
                </button>
              </td>

              <td>{describeEvent(event)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}


function ProjectManagementSummary({
  projectReport,
  settings,
  commentaryOverlay,
  commentaryText,
  commentarySaving,
  commentaryNotice,
  onCommentaryTextChange,
  onSaveCommentary,
  onResetCommentary,
  handleProps,
  readOnly = false,
}) {
  const { narrative, snapshot } = buildProjectExecutiveCommentarySnapshot(projectReport, settings);
  const generatedText = projectNarrativeText(projectReport, settings);
  const publishedText = commentaryOverlay?.state === 'published' && commentaryOverlay?.published ? commentaryOverlay.published : '';
  const draftText = commentaryOverlay?.state === 'draft' && commentaryOverlay?.draft ? commentaryOverlay.draft : '';
  const editableText = commentaryText || publishedText || draftText || generatedText;
  const hasSavedOrEditedCommentary = Boolean(commentaryText || publishedText || draftText);
  const commentarySections = parseManagementCommentaryForExport(editableText, narrative);
  const [showCommentaryEditor, setShowCommentaryEditor] = useState(false);

  return (
    <section className="dashboard-card content-card project-management-summary project-report-section commentary-editor-card">
      {!readOnly ? <button type="button" className="section-drag-handle no-export" {...handleProps} aria-label="Move Management Commentary">⠿</button> : null}
      <div className="dashboard-card-heading">
        <div>
          <p className="eyebrow">Management Commentary</p>
          <h3>Project Executive Commentary</h3>
          <p>Executive interpretation generated from Jira data across the included boards.</p>
        </div>
        <span className={`commentary-state-pill commentary-state-${commentaryOverlay?.state ?? 'generated'}`}>
          {commentaryOverlay?.state ?? 'generated'}
        </span>
      </div>

      <div className="commentary-inline-editor project-executive-commentary">
        <ExecutiveCommentaryPreview
          snapshot={snapshot}
          sections={commentarySections}
          showSummary={hasSavedOrEditedCommentary}
          summaryTitle="Executive Note"
          outlookTitle="Release / Milestone Outlook"
        />

        {!readOnly ? (
          <div className="commentary-editor-actions no-export executive-commentary-editor-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setShowCommentaryEditor((current) => !current)}
              aria-expanded={showCommentaryEditor}
            >
              {showCommentaryEditor ? 'Close editor' : 'Edit commentary'}
            </button>
            <button type="button" className="secondary-button" disabled={commentarySaving || !editableText.trim()} onClick={() => onSaveCommentary('draft', editableText)}>
              {commentarySaving ? 'Saving…' : 'Save draft'}
            </button>
            <button type="button" className="primary-button" disabled={commentarySaving || !editableText.trim()} onClick={() => onSaveCommentary('published', editableText)}>
              Publish
            </button>
            <button type="button" className="text-link" disabled={commentarySaving} onClick={onResetCommentary}>Restore Generated</button>
            {commentaryNotice ? <span className={`commentary-inline-notice commentary-inline-notice-${commentaryNotice.tone}`}>{commentaryNotice.message}</span> : null}
          </div>
        ) : null}

        {!readOnly && showCommentaryEditor ? (
          <div className="executive-commentary-edit-panel no-export">
            <div className="executive-commentary-edit-heading">
              <strong>Edit Project Narrative</strong>
              <span>The executive view above remains scannable while your saved wording is preserved.</span>
            </div>
            <textarea
              rows="11"
              className="management-commentary-editor project-commentary-editor"
              value={editableText}
              onChange={(event) => onCommentaryTextChange(event.currentTarget.value)}
              aria-label="Project Management Commentary"
              title="Edit the generated project management commentary. Save as Draft while working, then Publish when approved."
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function MoveMenu({ position, availability, onMove, onClose, label }) {
  useEffect(() => {
    if (!position) return undefined;
    const closeOnPointer = (event) => {
      if (!event.target.closest?.('.statusdeck-move-menu')) onClose();
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', closeOnPointer, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointer, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [position, onClose]);

  if (!position) return null;

  const actions = [
    ['up', '↑', 'Move Up'],
    ['down', '↓', 'Move Down'],
    ['left', '←', 'Move Left'],
    ['right', '→', 'Move Right'],
  ];

  const safeLeft = Math.max(8, Math.min(position.left, window.innerWidth - 180));
  const safeTop = Math.max(8, Math.min(position.top, window.innerHeight - 190));

  return createPortal(
    <div
      className="statusdeck-move-menu no-export"
      role="menu"
      aria-label={`Move ${label}`}
      style={{ top: safeTop, left: safeLeft }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {actions.map(([direction, icon, text]) => (
        <button
          key={direction}
          type="button"
          className="statusdeck-move-menu-item"
          role="menuitem"
          disabled={!availability?.[direction]}
          onClick={() => onMove(direction)}
        >
          <span aria-hidden="true">{icon}</span>
          <span>{text}</span>
        </button>
      ))}
    </div>,
    document.body
  );
}


function buildCustomKpiErrorRows(definitions, error) {
  const message = String(error?.message ?? error ?? 'Unable to evaluate this Jira KPI.');
  return (definitions ?? []).map((definition) => ({
    id: String(definition?.id ?? ''),
    name: String(definition?.name ?? 'Custom KPI'),
    value: null,
    matchedIssues: null,
    error: message,
  }));
}


function normaliseCustomInsightStatistic(value) {
  const raw = String(value ?? '').trim();
  const text = raw.toLowerCase().replace(/[ _-]+/g, '');
  const aliases = {
    assignee: 'assignee', assignees: 'assignee', assignedto: 'assignee',
    status: 'status', statuses: 'status',
    priority: 'priority', priorities: 'priority',
    issuetype: 'issuetype', issuetypes: 'issuetype', type: 'issuetype',
    project: 'project', projects: 'project',
    reporter: 'reporter', reporters: 'reporter',
    resolution: 'resolution', resolutions: 'resolution',
  };
  if (aliases[text]) return aliases[text];
  if (/^customfield_\d+$/i.test(raw)) return raw;
  return '';
}

function buildDirectCustomInsightJql(definition) {
  const sourceType = String(definition?.sourceType ?? 'savedFilter');
  if (['savedFilter', 'dashboard'].includes(sourceType) && definition?.filterId) {
    const filterId = String(definition.filterId).replace(/[^0-9]/g, '');
    if (!filterId) return { error: 'The selected Jira filter ID is invalid.' };
    return { jql: `filter = ${filterId}` };
  }
  const rawJql = String(definition?.jql ?? '').trim();
  if (!rawJql) return { error: 'No JQL is available for this Jira insight.' };
  return { jql: rawJql };
}

function getDirectInsightFieldValue(issue, fieldKey) {
  const value = issue?.fields?.[fieldKey];
  if (value == null) return { key: '__none__', label: 'None' };
  if (Array.isArray(value)) {
    if (!value.length) return { key: '__none__', label: 'None' };
    const first = value[0];
    return {
      key: String(first?.id ?? first?.accountId ?? first?.value ?? first?.name ?? first),
      label: String(first?.displayName ?? first?.name ?? first?.value ?? first),
    };
  }
  if (typeof value === 'object') {
    return {
      key: String(value.id ?? value.accountId ?? value.value ?? value.name ?? value.displayName ?? '__value__'),
      label: String(value.displayName ?? value.name ?? value.value ?? value.id ?? 'Value'),
    };
  }
  return { key: String(value), label: String(value) };
}

function parseJiraBridgeError(body, status) {
  try {
    const parsed = JSON.parse(String(body ?? ''));
    const messages = [
      ...(Array.isArray(parsed?.errorMessages) ? parsed.errorMessages : []),
      ...Object.values(parsed?.errors ?? {}),
    ].filter(Boolean).map((value) => String(value).trim()).filter(Boolean);
    if (messages.length) return messages.slice(0, 2).join(' ');
  } catch (_ignored) {}
  const compact = String(body ?? '').replace(/\s+/g, ' ').trim();
  if (compact && compact.length <= 240) return compact;
  return `Jira rejected this insight query (HTTP ${status}).`;
}

async function getDirectJqlCount(jql) {
  const response = await requestJira('/rest/api/3/search/approximate-count', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql }),
  });
  if (!response.ok) return { error: parseJiraBridgeError(await response.text(), response.status) };
  const data = await response.json();
  return { count: Number(data?.count ?? 0), approximate: true };
}

const DIRECT_INSIGHT_MAX_ISSUES = 12500;
const DIRECT_INSIGHT_REPORT_MAX_ISSUES = 12500;

function normaliseDirectDashboardGadgetType(definition) {
  const explicit = String(definition?.gadgetType || '').trim();
  if (explicit && explicit !== 'count') return explicit;
  // Older StatusDeck builds saved some dashboard selections with only the editable KPI
  // name populated. Include that name when recovering the Jira gadget type so users
  // do not have to remove/re-add an existing Created vs. Resolved / Days Remaining card.
  const sourceText = `${definition?.gadgetTitle || ''} ${definition?.moduleKey || ''} ${definition?.name || ''}`.toLowerCase();
  if (sourceText.includes('created vs resolved') || sourceText.includes('created vs. resolved') || sourceText.includes('created-vs-resolved') || sourceText.includes('createdvsresolved')) return 'createdResolved';
  if (sourceText.includes('days remaining') || sourceText.includes('sprint-days-remaining') || sourceText.includes('daysremaining')) return 'daysRemaining';
  return explicit || 'count';
}

function splitDirectInsightOrderBy(jql) {
  const value = String(jql || '').trim();
  const match = value.match(/\s+ORDER\s+BY\s+/i);
  if (!match || match.index == null) return { query: value, orderBy: '' };
  return { query: value.slice(0, match.index).trim(), orderBy: value.slice(match.index).trim() };
}

function buildCreatedResolvedWindowJql(jql, daysPreviously) {
  const days = Math.max(1, Math.min(3650, Number(daysPreviously || 30)));
  const { query, orderBy } = splitDirectInsightOrderBy(jql);
  return `${query ? `(${query}) AND ` : ''}(created >= -${days}d OR resolved >= -${days}d)${orderBy ? ` ${orderBy}` : ''}`;
}


function buildCreatedResolvedRangeJql(jql, field, startDate, endDate) {
  const { query } = splitDirectInsightOrderBy(jql);
  const start = startDate.toISOString().slice(0, 10);
  const end = endDate.toISOString().slice(0, 10);
  return `${query ? `(${query}) AND ` : ''}${field} >= "${start}" AND ${field} < "${end}"`;
}

function getCreatedResolvedBuckets(definition) {
  const period = normaliseCreatedResolvedPeriod(definition?.period);
  const configuredDays = Number(definition?.daysPreviously || 0);
  const daysPreviously = configuredDays > 0 ? Math.min(3650, configuredDays) : 30;
  const today = new Date();
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
  const rawStart = new Date(end);
  rawStart.setUTCDate(rawStart.getUTCDate() - daysPreviously);
  let cursor = startOfBucket(rawStart, period);
  const buckets = [];
  while (cursor < end && buckets.length < 400) {
    const bucketEnd = advanceBucket(cursor, period);
    const effectiveStart = cursor < rawStart ? rawStart : cursor;
    const effectiveEnd = bucketEnd > end ? end : bucketEnd;
    buckets.push({
      date: cursor.toISOString().slice(0, 10),
      label: bucketLabel(cursor, period),
      start: effectiveStart,
      end: effectiveEnd,
    });
    cursor = bucketEnd;
  }
  return { period, daysPreviously, rawStart, end, buckets };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function getCachedDirectJqlCount(jql, countCache) {
  if (!countCache.has(jql)) {
    countCache.set(jql, getDirectJqlCount(jql).catch((error) => ({ error: String(error?.message ?? error) })));
  }
  return await countCache.get(jql);
}

async function evaluateCreatedResolvedByCounts(definition, jql, sourceFilterCount, countCache, onProgress, progressIds = []) {
  const config = getCreatedResolvedBuckets(definition);
  const windowJql = buildCreatedResolvedWindowJql(jql, config.daysPreviously);
  const windowCount = await getCachedDirectJqlCount(windowJql, countCache);
  if (windowCount?.error) return { error: windowCount.error };

  const tasks = config.buckets.flatMap((bucket, bucketIndex) => ([
    { bucketIndex, kind: 'created', jql: buildCreatedResolvedRangeJql(jql, 'created', bucket.start, bucket.end) },
    { bucketIndex, kind: 'resolved', jql: buildCreatedResolvedRangeJql(jql, 'resolved', bucket.start, bucket.end) },
  ]));
  let completed = 0;
  const counts = await mapWithConcurrency(tasks, 6, async (task) => {
    const result = await getCachedDirectJqlCount(task.jql, countCache);
    completed += 1;
    if (typeof onProgress === 'function') {
      onProgress(progressIds, { loaded: completed, total: tasks.length, percent: tasks.length ? Math.round((completed / tasks.length) * 100) : 100, unit: 'date-counts' });
    }
    return { ...task, result };
  });
  const firstError = counts.find((item) => item.result?.error)?.result?.error;
  if (firstError) return { error: firstError };

  const points = config.buckets.map((bucket) => ({ date: bucket.date, label: bucket.label, created: 0, resolved: 0 }));
  counts.forEach((item) => {
    points[item.bucketIndex][item.kind] = Number(item.result?.count ?? 0);
  });
  return {
    period: config.period,
    daysPreviously: config.daysPreviously,
    timeSeries: points,
    matchedIssues: Number(windowCount?.count ?? 0),
    sourceFilterCount: Number(sourceFilterCount ?? 0),
    approximate: true,
  };
}

function normaliseCreatedResolvedPeriod(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text.includes('quarter')) return 'quarter';
  if (text.includes('month')) return 'month';
  if (text.includes('week')) return 'week';
  return 'day';
}

function isoDay(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function addDateCount(map, value) {
  const key = isoDay(value);
  if (key) map.set(key, (map.get(key) ?? 0) + 1);
}

function startOfBucket(date, period) {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (period === 'week') {
    const day = next.getUTCDay() || 7;
    next.setUTCDate(next.getUTCDate() - day + 1);
  } else if (period === 'month') {
    next.setUTCDate(1);
  } else if (period === 'quarter') {
    next.setUTCMonth(Math.floor(next.getUTCMonth() / 3) * 3, 1);
  }
  return next;
}

function advanceBucket(date, period) {
  const next = new Date(date);
  if (period === 'quarter') next.setUTCMonth(next.getUTCMonth() + 3);
  else if (period === 'month') next.setUTCMonth(next.getUTCMonth() + 1);
  else if (period === 'week') next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function bucketLabel(date, period) {
  if (period === 'quarter') return `Q${Math.floor(date.getUTCMonth() / 3) + 1} ${date.getUTCFullYear()}`;
  if (period === 'month') return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
}

function buildCreatedResolvedSeries(accumulator) {
  const period = normaliseCreatedResolvedPeriod(accumulator.definition?.period);
  const configuredDays = Number(accumulator.definition?.daysPreviously || 0);
  const daysPreviously = configuredDays > 0 ? Math.min(3650, configuredDays) : 30;
  const today = new Date();
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
  const rawStart = new Date(end);
  rawStart.setUTCDate(rawStart.getUTCDate() - daysPreviously);
  let cursor = startOfBucket(rawStart, period);
  const points = [];
  while (cursor < end && points.length < 400) {
    const bucketEnd = advanceBucket(cursor, period);
    let created = 0;
    let resolved = 0;
    for (const [day, count] of accumulator.createdDates.entries()) {
      const d = new Date(`${day}T00:00:00Z`);
      if (d >= cursor && d < bucketEnd) created += count;
    }
    for (const [day, count] of accumulator.resolvedDates.entries()) {
      const d = new Date(`${day}T00:00:00Z`);
      if (d >= cursor && d < bucketEnd) resolved += count;
    }
    points.push({ date: cursor.toISOString().slice(0, 10), label: bucketLabel(cursor, period), created, resolved });
    cursor = bucketEnd;
  }
  return { period, daysPreviously, points };
}

function initialiseDirectInsightAccumulator(definition, countResult) {
  const gadgetType = normaliseDirectDashboardGadgetType(definition);
  const statisticType = normaliseCustomInsightStatistic(definition?.statisticType);
  const xStatistic = normaliseCustomInsightStatistic(definition?.xStatistic);
  const yStatistic = normaliseCustomInsightStatistic(definition?.yStatistic);
  return {
    definition,
    gadgetType,
    statisticType,
    xStatistic,
    yStatistic,
    pie: new Map(),
    rows: new Map(),
    columns: new Map(),
    cells: new Map(),
    createdDates: new Map(),
    resolvedDates: new Map(),
    countResult,
  };
}

function accumulateDirectInsightPage(accumulator, issues) {
  if (accumulator.gadgetType === 'pie' && accumulator.statisticType) {
    issues.forEach((issue) => {
      const item = getDirectInsightFieldValue(issue, accumulator.statisticType);
      const current = accumulator.pie.get(item.key) ?? { key: item.key, label: item.label, value: 0 };
      current.value += 1;
      accumulator.pie.set(item.key, current);
    });
    return;
  }
  if (accumulator.gadgetType === 'twoDimensional' && accumulator.xStatistic && accumulator.yStatistic) {
    issues.forEach((issue) => {
      const row = getDirectInsightFieldValue(issue, accumulator.xStatistic);
      const col = getDirectInsightFieldValue(issue, accumulator.yStatistic);
      accumulator.rows.set(row.key, row.label);
      accumulator.columns.set(col.key, col.label);
      const key = `${row.key}|||${col.key}`;
      accumulator.cells.set(key, (accumulator.cells.get(key) ?? 0) + 1);
    });
    return;
  }
  if (accumulator.gadgetType === 'createdResolved') {
    issues.forEach((issue) => {
      addDateCount(accumulator.createdDates, issue?.fields?.created);
      addDateCount(accumulator.resolvedDates, issue?.fields?.resolutiondate);
    });
  }
}

function finaliseDirectInsight(accumulator) {
  const definition = accumulator.definition;
  const id = String(definition?.id ?? '');
  const name = String(definition?.name ?? definition?.gadgetTitle ?? 'Custom Jira insight');
  const count = Number(accumulator.countResult?.count ?? 0);
  const base = { id, name, sourceType: String(definition?.sourceType ?? 'savedFilter'), value: count, matchedIssues: count, approximate: true };
  if (accumulator.gadgetType === 'pie' && accumulator.statisticType) {
    return { ...base, sourceType: 'dashboard', viewType: 'pie', statisticType: accumulator.statisticType, series: [...accumulator.pie.values()].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label)) };
  }
  if (accumulator.gadgetType === 'twoDimensional' && accumulator.xStatistic && accumulator.yStatistic) {
    const columns = [...accumulator.columns.entries()].map(([key, label]) => ({ key, label }));
    const rows = [...accumulator.rows.entries()].map(([key, label]) => ({ rowKey: key, rowLabel: label, values: columns.map((column) => accumulator.cells.get(`${key}|||${column.key}`) ?? 0) }));
    return { ...base, sourceType: 'dashboard', viewType: 'twoDimensional', xStatistic: accumulator.xStatistic, yStatistic: accumulator.yStatistic, table: { rows, columns } };
  }
  if (accumulator.gadgetType === 'createdResolved') {
    const series = buildCreatedResolvedSeries(accumulator);
    return { ...base, sourceType: 'dashboard', viewType: 'createdResolved', period: series.period, daysPreviously: series.daysPreviously, timeSeries: series.points, approximate: false };
  }
  return { ...base, viewType: 'count' };
}

async function evaluateDaysRemainingInsight(definition, context = {}) {
  const id = String(definition?.id ?? '');
  const name = String(definition?.name ?? definition?.gadgetTitle ?? 'Days Remaining in Sprint');
  const explicitSprintId = String(definition?.insightSprintId || context?.sprintId || '').trim();
  const boardId = String(definition?.insightBoardId || context?.boardId || '').trim();
  const localSprints = Array.isArray(context?.sprints) ? context.sprints : [];
  let sprint = context?.sprint && (!explicitSprintId || String(context.sprint.id) === explicitSprintId)
    ? context.sprint
    : (explicitSprintId ? localSprints.find((item) => String(item?.id) === explicitSprintId) : localSprints.find((item) => item?.state === 'active'));
  try {
    // Do not call the Jira Agile REST API through Forge Bridge requestJira here.
    // Some Jira/Bridge combinations can fail while decoding that Agile response in
    // the browser (`atob` / invalid encoded string). StatusDeck already has sprint
    // metadata from its licensed backend resolver, so reuse it first and only ask
    // that same resolver for board sprints when the selected context is insufficient.
    if (!sprint?.endDate && boardId) {
      const boardSprints = await invoke('getSprints', { boardId: Number(boardId) });
      sprint = explicitSprintId
        ? (boardSprints ?? []).find((item) => String(item?.id) === explicitSprintId) ?? null
        : (boardSprints ?? []).find((item) => item?.state === 'active') ?? (boardSprints ?? [])[0] ?? null;
    }
    if (!sprint?.endDate) return { id, name, error: 'Jira did not expose the configured sprint/end date for this Days Remaining gadget.' };
    const end = new Date(sprint.endDate);
    const now = new Date();
    let days = 0;
    if (sprint.state !== 'closed' && end > now) {
      const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
      const finish = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
      while (cursor <= finish && days < 1000) {
        const weekday = cursor.getUTCDay();
        if (weekday !== 0 && weekday !== 6) days += 1;
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    }
    return { id, name, sourceType: 'dashboard', viewType: 'daysRemaining', value: days, sprintName: sprint.name || '', endDate: sprint.endDate, approximate: false };
  } catch (error) {
    return { id, name, error: String(error?.message ?? error) };
  }
}

async function evaluateCustomJiraInsightsDirect(definitions, onProgress, cache, context = {}) {
  const active = (definitions ?? []).filter((item) => item?.enabled !== false).slice(0, 12);
  if (!active.length) return [];
  // Created-vs-Resolved charts are reconstructed from Jira count queries per date bucket.
  // They never need to download the entire saved-filter population, so a very broad
  // dashboard filter does not consume the issue-level reconstruction budget.
  const directCountCache = new Map();
  const createdResolvedSeriesCache = new Map();
  const effectiveActive = active.map((definition) => ({
    ...definition,
    gadgetType: normaliseDirectDashboardGadgetType(definition),
  }));
  const results = [];
  const regular = [];
  let reportIssueBudgetUsed = 0;

  for (const definition of effectiveActive) {
    if (String(definition?.sourceType) === 'dashboard' && definition.gadgetType === 'daysRemaining') {
      const fallbackBoardId = definition?.insightBoardId || context?.boardId || '';
      const fallbackSprintId = definition?.insightSprintId || context?.sprintId || '';
      const cacheKey = JSON.stringify({ gadgetType: 'daysRemaining', boardId: fallbackBoardId, sprintId: fallbackSprintId });
      if (cache?.has(cacheKey)) {
        results.push({ ...cache.get(cacheKey), id: String(definition?.id ?? ''), name: String(definition?.name ?? definition?.gadgetTitle ?? 'Days Remaining in Sprint') });
      } else {
        const row = await evaluateDaysRemainingInsight(definition, context);
        results.push(row);
        cache?.set(cacheKey, row);
      }
    } else {
      regular.push(definition);
    }
  }

  const prepared = regular.map((definition) => {
    const built = buildDirectCustomInsightJql(definition);
    return built.error ? { definition, error: built.error, jql: '' } : { definition, jql: built.jql };
  });
  const groups = new Map();
  for (const item of prepared) {
    const id = String(item.definition?.id ?? '');
    const name = String(item.definition?.name ?? item.definition?.gadgetTitle ?? 'Custom Jira insight');
    if (item.error) { results.push({ id, name, error: item.error }); continue; }
    const cacheKey = JSON.stringify({ jql: item.jql, gadgetType: item.definition?.gadgetType || 'count', statisticType: item.definition?.statisticType || '', xStatistic: item.definition?.xStatistic || '', yStatistic: item.definition?.yStatistic || '', period: item.definition?.period || '', daysPreviously: item.definition?.daysPreviously || 0 });
    if (cache?.has(cacheKey)) { results.push({ ...cache.get(cacheKey), id, name }); continue; }
    if (!groups.has(item.jql)) groups.set(item.jql, []);
    groups.get(item.jql).push({ ...item, cacheKey });
  }

  for (const [jql, group] of groups.entries()) {
    let countResult;
    try { countResult = await getDirectJqlCount(jql); } catch (error) { countResult = { error: String(error?.message ?? error) }; }
    if (countResult?.error) {
      group.forEach((item) => results.push({ id: String(item.definition?.id ?? ''), name: String(item.definition?.name ?? 'Custom Jira insight'), error: countResult.error }));
      continue;
    }

    const total = Math.max(0, Number(countResult.count ?? 0));
    const accumulators = group.map((item) => ({ ...initialiseDirectInsightAccumulator(item.definition, countResult), cacheKey: item.cacheKey }));
    const fields = [...new Set(accumulators.flatMap((acc) => {
      if (acc.gadgetType === 'pie' && acc.statisticType) return [acc.statisticType];
      if (acc.gadgetType === 'twoDimensional' && acc.xStatistic && acc.yStatistic) return [acc.xStatistic, acc.yStatistic];
      return [];
    }))];
    const createdResolved = accumulators.filter((acc) => acc.gadgetType === 'createdResolved');
    const issueLevelRich = accumulators.filter((acc) => (acc.gadgetType === 'pie' && acc.statisticType) || (acc.gadgetType === 'twoDimensional' && acc.xStatistic && acc.yStatistic));
    const rich = [...createdResolved, ...issueLevelRich];
    accumulators.filter((acc) => !rich.includes(acc)).forEach((acc) => { const row = finaliseDirectInsight(acc); results.push(row); cache?.set(acc.cacheKey, row); });

    // Created vs. Resolved is a time-series count problem, not an issue-download problem.
    // Query each configured date bucket directly so broad dashboard filters (12.5k, 50k, etc.)
    // can render without loading the matching issues into the browser or Forge runtime.
    for (const acc of createdResolved) {
      const configKey = JSON.stringify({ jql, period: normaliseCreatedResolvedPeriod(acc.definition?.period), daysPreviously: Number(acc.definition?.daysPreviously || 30) });
      if (!createdResolvedSeriesCache.has(configKey)) {
        createdResolvedSeriesCache.set(configKey, evaluateCreatedResolvedByCounts(
          acc.definition, jql, total, directCountCache, onProgress, createdResolved.map((item) => String(item.definition?.id ?? ''))
        ));
      }
      const series = await createdResolvedSeriesCache.get(configKey);
      if (series?.error) {
        results.push({ id: String(acc.definition?.id ?? ''), name: String(acc.definition?.name ?? 'Custom Jira insight'), error: series.error });
      } else {
        const row = {
          id: String(acc.definition?.id ?? ''),
          name: String(acc.definition?.name ?? acc.definition?.gadgetTitle ?? 'Created vs. Resolved Chart'),
          sourceType: 'dashboard',
          viewType: 'createdResolved',
          value: series.matchedIssues,
          matchedIssues: series.matchedIssues,
          sourceFilterCount: series.sourceFilterCount,
          approximate: series.approximate,
          period: series.period,
          daysPreviously: series.daysPreviously,
          timeSeries: series.timeSeries,
        };
        results.push(row);
        cache?.set(acc.cacheKey, row);
      }
    }

    if (!issueLevelRich.length) continue;
    const fetchTotal = total;
    const fetchJql = jql;

    if (fetchTotal > DIRECT_INSIGHT_MAX_ISSUES) {
      issueLevelRich.forEach((acc) => results.push({
        id: String(acc.definition?.id ?? ''),
        name: String(acc.definition?.name ?? 'Custom Jira insight'),
        error: `This Jira insight matches approximately ${formatNumber(fetchTotal)} issues. StatusDeck limits issue-level dashboard reconstruction to ${formatNumber(DIRECT_INSIGHT_MAX_ISSUES)} Jira issues per report. Created vs. Resolved charts use date-bucket counts and are not subject to this issue-download limit.`,
      }));
      continue;
    }

    if (reportIssueBudgetUsed + fetchTotal > DIRECT_INSIGHT_REPORT_MAX_ISSUES) {
      issueLevelRich.forEach((acc) => results.push({
        id: String(acc.definition?.id ?? ''),
        name: String(acc.definition?.name ?? 'Custom Jira insight'),
        error: `This visual was not expanded because the report has reached StatusDeck's ${formatNumber(DIRECT_INSIGHT_REPORT_MAX_ISSUES)}-issue Jira dashboard reconstruction budget. Count-only KPIs and Created vs. Resolved charts do not consume this issue-download budget.`,
      }));
      continue;
    }

    reportIssueBudgetUsed += fetchTotal;
    let loaded = 0;
    let nextPageToken;
    try {
      do {
        const body = { jql: fetchJql, maxResults: 100, fields };
        if (nextPageToken) body.nextPageToken = nextPageToken;
        const response = await requestJira('/rest/api/3/search/jql', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!response.ok) throw new Error(parseJiraBridgeError(await response.text(), response.status));
        const page = await response.json();
        const issues = Array.isArray(page?.issues) ? page.issues : [];
        issueLevelRich.forEach((acc) => accumulateDirectInsightPage(acc, issues));
        loaded += issues.length;
        nextPageToken = page?.nextPageToken || null;
        if (typeof onProgress === 'function') {
          const percent = fetchTotal > 0 ? Math.min(99, Math.round((loaded / fetchTotal) * 100)) : 100;
          onProgress(group.map((item) => String(item.definition?.id ?? '')), { loaded, total: fetchTotal, percent });
        }
        if (loaded >= DIRECT_INSIGHT_MAX_ISSUES && nextPageToken) {
          throw new Error(`StatusDeck stopped this dashboard reconstruction at ${formatNumber(DIRECT_INSIGHT_MAX_ISSUES)} Jira issues to protect report performance.`);
        }
      } while (nextPageToken);
      issueLevelRich.forEach((acc) => { const row = finaliseDirectInsight(acc); results.push(row); cache?.set(acc.cacheKey, row); });
    } catch (error) {
      issueLevelRich.forEach((acc) => results.push({ id: String(acc.definition?.id ?? ''), name: String(acc.definition?.name ?? 'Custom Jira insight'), error: String(error?.message ?? error) }));
    }
  }
  const order = new Map(effectiveActive.map((item, index) => [String(item?.id ?? ''), index]));
  return results.sort((a, b) => (order.get(String(a.id)) ?? 999) - (order.get(String(b.id)) ?? 999));
}

function formatJiraStatisticLabel(value) {
  const labels = { assignee: 'Assignee', status: 'Status', priority: 'Priority', issuetype: 'Issue type', project: 'Project', reporter: 'Reporter', resolution: 'Resolution' };
  return labels[value] || String(value || '').replace(/^customfield_/, 'Custom field ');
}

function CustomJiraInsight({ insight }) {
  if (insight.loading) return <div className="custom-kpi-card custom-kpi-card-loading"><span>{insight.name}</span><strong>{Number.isFinite(insight.progress) ? `${insight.progress}%` : '…'}</strong><small>{insight.total ? `${formatNumber(insight.loaded || 0)} of ≈${formatNumber(insight.total)} Jira items aggregated` : 'Loading Jira insight…'}</small></div>;
  if (insight.error) return <div className="custom-kpi-card custom-kpi-card-error"><span>{insight.name}</span><strong>—</strong><small>{insight.error}</small></div>;
  if (insight.viewType === 'daysRemaining') {
    return <article className="custom-jira-insight custom-jira-days-remaining"><div><span>{insight.name}</span><strong>{formatNumber(insight.value)}</strong><small>Days Remaining{insight.sprintName ? ` · ${insight.sprintName}` : ''}</small></div></article>;
  }
  if (insight.viewType === 'createdResolved' && Array.isArray(insight.timeSeries)) {
    const points = insight.timeSeries;
    const max = Math.max(1, ...points.flatMap((point) => [Number(point.created || 0), Number(point.resolved || 0)]));
    const width = 760, height = 220, padX = 42, padY = 24;
    const x = (index) => points.length <= 1 ? padX : padX + (index / (points.length - 1)) * (width - padX * 2);
    const y = (value) => height - padY - (Number(value || 0) / max) * (height - padY * 2);
    const createdPath = points.map((point,index)=>`${index ? 'L' : 'M'} ${x(index).toFixed(1)} ${y(point.created).toFixed(1)}`).join(' ');
    const resolvedPath = points.map((point,index)=>`${index ? 'L' : 'M'} ${x(index).toFixed(1)} ${y(point.resolved).toFixed(1)}`).join(' ');
    const tickIndices = getCreatedResolvedTickIndices(points, 7);
    return <article className="custom-jira-insight custom-jira-created-resolved">
      <div className="custom-jira-insight-heading"><div><span>{insight.name}</span><strong>{formatNumber(insight.matchedIssues ?? insight.value)} in chart window</strong></div><small>{insight.period || 'day'} buckets · last {formatNumber(insight.daysPreviously || 30)} days{Number.isFinite(Number(insight.sourceFilterCount)) ? ` · source filter ≈${formatNumber(insight.sourceFilterCount)}` : ''}</small></div>
      <div className="custom-jira-line-legend"><span><i className="created-line-key"/>Created</span><span><i className="resolved-line-key"/>Resolved</span></div>
      <svg className="custom-jira-line-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${insight.name}: created versus resolved issues over time`}>
        {[0,0.25,0.5,0.75,1].map((ratio)=><line key={ratio} x1={padX} x2={width-padX} y1={height-padY-ratio*(height-padY*2)} y2={height-padY-ratio*(height-padY*2)} className="custom-jira-grid-line"/>)}
        <path d={createdPath} className="custom-jira-created-line" fill="none"/>
        <path d={resolvedPath} className="custom-jira-resolved-line" fill="none"/>
        {tickIndices.map((index)=><text key={points[index].date} x={x(index)} y={height-4} textAnchor="middle" className="custom-jira-axis-label">{points[index].label}</text>)}
      </svg>
      <div className="custom-jira-line-summary"><span>Created <strong>{formatNumber(points.reduce((sum,p)=>sum+Number(p.created||0),0))}</strong></span><span>Resolved <strong>{formatNumber(points.reduce((sum,p)=>sum+Number(p.resolved||0),0))}</strong></span></div>
    </article>;
  }
  if (insight.viewType === 'pie' && Array.isArray(insight.series)) {
    const total = Math.max(1, insight.series.reduce((sum,item)=>sum+Number(item.value||0),0));
    let cursor = 0;
    const palette = ['#1f5a94','#2878b5','#2f8f74','#c58a21','#9b4d55','#60788f','#7d67a8','#3f7f8a'];
    const stops = insight.series.map((item,index)=>{ const start=cursor; cursor += Number(item.value||0)/total*360; return `${palette[index%palette.length]} ${start}deg ${cursor}deg`; }).join(', ');
    return <article className="custom-jira-insight custom-jira-insight-pie">
      <div className="custom-jira-insight-heading"><div><span>{insight.name}</span><strong>{formatNumber(insight.matchedIssues ?? total)} total</strong></div><small>Grouped by {formatJiraStatisticLabel(insight.statisticType)}</small></div>
      <div className="custom-jira-pie-body"><div className="custom-jira-pie" style={{background:`conic-gradient(${stops || '#d9e2ec 0deg 360deg'})`}}><div><strong>{formatNumber(insight.matchedIssues ?? total)}</strong><span>issues</span></div></div><div className="custom-jira-pie-legend">{insight.series.slice(0,12).map((item,index)=><div key={`${item.key}-${index}`}><i style={{backgroundColor:palette[index%palette.length]}}/><span>{item.label}</span><strong>{formatNumber(item.value)}</strong></div>)}</div></div>
    </article>;
  }
  if (insight.viewType === 'twoDimensional' && insight.table?.rows?.length) {
    return <article className="custom-jira-insight custom-jira-insight-table">
      <div className="custom-jira-insight-heading"><div><span>{insight.name}</span><strong>{formatNumber(insight.matchedIssues ?? insight.value)} total</strong></div><small>{formatJiraStatisticLabel(insight.xStatistic)} × {formatJiraStatisticLabel(insight.yStatistic)}</small></div>
      <div className="table-wrapper"><table><thead><tr><th>{formatJiraStatisticLabel(insight.xStatistic)}</th>{insight.table.columns.map((col)=><th key={col.key}>{col.label}</th>)}<th>Total</th></tr></thead><tbody>{insight.table.rows.map((row)=><tr key={row.rowKey}><th>{row.rowLabel}</th>{row.values.map((value,index)=><td key={`${row.rowKey}-${index}`}>{formatNumber(value)}</td>)}<td><strong>{formatNumber(row.values.reduce((sum,value)=>sum+Number(value||0),0))}</strong></td></tr>)}</tbody></table></div>
    </article>;
  }
  return <div className="custom-kpi-card"><span>{insight.name}</span><strong>{formatNumber(insight.value)}</strong><small>{insight.warning || `${insight.approximate ? '≈ ' : ''}${formatNumber(insight.matchedIssues ?? insight.value)} matching Jira items`}</small></div>;
}

function CustomJiraInsightsSection({ results, project = false, layoutProps = null, handleProps = null }) {
  if (!results?.length) return null;
  const baseClass = `dashboard-card content-card report-section custom-kpi-strip custom-kpi-strip-prominent ${project ? 'project-report-section' : ''}`;
  const sectionAttributes = layoutProps
    ? { ...layoutProps, className: [baseClass, layoutProps.className || ''].filter(Boolean).join(' ') }
    : { className: baseClass };
  return <section {...sectionAttributes}>
    {handleProps ? <button type="button" className={project ? 'section-drag-handle no-export' : 'report-section-drag-handle no-export'} title="Move section" {...handleProps}>⠿</button> : null}
    <div className="section-heading"><div><p className="eyebrow">Custom Jira Insights</p><h3>Your Jira Filters and Dashboard Visuals</h3><p>Rendered from the Jira sources exactly as configured; StatusDeck does not add Sprint or Project constraints.</p></div></div>
    <div className="custom-jira-insights-grid">{results.map((insight)=><CustomJiraInsight key={insight.id} insight={insight}/>)}</div>
  </section>;
}

function CustomKpiStudio({ draft, setDraft, sources, sourcesLoading }) {
  const nativeLabels = {
    completion: 'Completion %', completed: 'Completed', remaining: 'Remaining', overdue: 'Overdue',
    defects: 'Unresolved Defects', velocity: 'Velocity', workload: 'Team Workload', acceptanceCriteria: 'Acceptance Criteria', daysRemaining: 'Days Remaining',
  };
  const custom = draft.kpiProfile?.custom ?? [];
  const updateCustom = (index, patch) => setDraft((current) => {
    const list = [...(current.kpiProfile?.custom ?? [])];
    list[index] = { ...list[index], ...patch };
    return { ...current, kpiProfile: { ...current.kpiProfile, custom: list } };
  });
  const removeCustom = (index) => setDraft((current) => ({ ...current, kpiProfile: { ...current.kpiProfile, custom: (current.kpiProfile?.custom ?? []).filter((_, i) => i !== index) } }));
  const addCustom = () => setDraft((current) => ({ ...current, kpiProfile: { ...current.kpiProfile, custom: [...(current.kpiProfile?.custom ?? []), { id: `custom-${Date.now()}`, name: 'Custom KPI', sourceType: 'savedFilter', filterId: '', jql: '', aggregation: 'count', target: 'both', enabled: true }] } }));
  return <div className="kpi-studio">
    <div className="kpi-studio-header"><div><p className="eyebrow">Custom Jira Insights</p><h3>Bring Your Jira Reporting into StatusDeck</h3><p>Keep or hide StatusDeck KPIs, then reuse saved Jira filters, dashboard gadgets, or custom JQL exactly as they are defined in Jira.</p></div></div>
    <div className="native-kpi-grid">{Object.entries(nativeLabels).map(([key,label]) => <label className="native-kpi-toggle" key={key}><input type="checkbox" checked={draft.kpiProfile?.native?.[key] !== false} onChange={(e)=>{const checked=e.currentTarget.checked; setDraft((current)=>({...current,kpiProfile:{...current.kpiProfile,native:{...current.kpiProfile.native,[key]:checked}}}))}}/><span>{label}</span></label>)}</div>
    <div className="jira-source-summary"><strong>Reusable Jira Sources</strong><span>{sourcesLoading ? 'Loading saved filters and dashboards…' : `${sources?.filters?.length ?? 0} saved filters · ${sources?.dashboards?.length ?? 0} dashboards · ${sources?.dashboardSources?.length ?? 0} reusable dashboard gadgets`}</span>{sources?.dashboardNote ? <small>{sources.dashboardNote}</small> : null}</div>
    <div className="custom-kpi-list">{custom.map((item,index)=><div className="custom-kpi-editor" key={item.id || index}>
      <div className="custom-kpi-editor-head"><strong>{item.name || 'Custom KPI'}</strong><button type="button" onClick={()=>removeCustom(index)}>Remove</button></div>
      <div className="custom-kpi-fields">
        <label><span>KPI Name</span><input value={item.name || ''} onChange={(e)=>updateCustom(index,{name:e.currentTarget.value})}/></label>
        <label><span>Source</span><select value={item.sourceType || 'savedFilter'} onChange={(e)=>updateCustom(index,{sourceType:e.currentTarget.value})}><option value="savedFilter">Saved Jira Filter</option><option value="dashboard">Jira Dashboard</option><option value="customJql">Custom JQL</option></select></label>
        {item.sourceType === 'savedFilter' ? <label><span>Saved Filter</span><select value={item.filterId || ''} onChange={(e)=>{ const filter=(sources?.filters ?? []).find((entry)=>String(entry.id)===String(e.currentTarget.value)); updateCustom(index,{filterId:e.currentTarget.value,name:filter?.name || item.name || 'Custom Jira Insight'}); }}><option value="">Select Filter…</option>{(sources?.filters ?? []).map((filter)=><option key={filter.id} value={filter.id}>{filter.name}</option>)}</select></label> : item.sourceType === 'dashboard' ? <label><span>Dashboard Gadget</span><select value={item.dashboardId && item.gadgetId ? `${item.dashboardId}:${item.gadgetId}` : ''} onChange={(e)=>{ const source=(sources?.dashboardSources ?? []).find((entry)=>`${entry.dashboardId}:${entry.gadgetId}`===e.currentTarget.value); if (source) updateCustom(index,{dashboardId:source.dashboardId,gadgetId:source.gadgetId,gadgetTitle:source.gadgetTitle,gadgetType:source.gadgetType,moduleKey:source.moduleKey||'',filterId:source.filterId||'',statisticType:source.statisticType||'',xStatistic:source.xStatistic||'',yStatistic:source.yStatistic||'',period:source.period||'',daysPreviously:Number(source.daysPreviously||0),insightBoardId:source.boardId||'',insightSprintId:source.sprintId||'',name:source.gadgetTitle || item.name || 'Custom Jira Insight'}); }}><option value="">Select Dashboard Gadget…</option>{(sources?.dashboardSources ?? []).map((source)=><option key={`${source.dashboardId}-${source.gadgetId}`} value={`${source.dashboardId}:${source.gadgetId}`}>{source.dashboardName} · {source.gadgetTitle}</option>)}</select></label> : <label className="kpi-jql-field"><span>JQL</span><input value={item.jql || ''} placeholder='e.g. priority = Highest AND resolution is EMPTY' onChange={(e)=>updateCustom(index,{jql:e.currentTarget.value})}/></label>}
        
        <label><span>Show In</span><select value={item.target || 'both'} onChange={(e)=>updateCustom(index,{target:e.currentTarget.value})}><option value="both">Sprint + Project</option><option value="sprint">Sprint Only</option><option value="project">Project Only</option></select></label>
      </div>
    </div>)}</div>
    <button type="button" className="secondary-button kpi-add-button" onClick={addCustom} disabled={custom.length >= 12}>+ Add Filter / KPI From Jira</button>
  </div>;
}

function CustomKpiFiltersModal({ initialSettings, onClose, onSave }) {
  const [draft, setDraft] = useState(() => mergeReportingSettings(initialSettings));
  const [sources, setSources] = useState({ filters: [], dashboards: [], dashboardSources: [], dashboardNote: '' });
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let cancelled = false;
    invoke('getJiraKpiSources')
      .then((result) => {
        if (cancelled) return;
        const nextSources = result || { filters: [], dashboards: [], dashboardSources: [] };
        setSources(nextSources);
        // Self-heal dashboard definitions saved by older builds. Merely opening the
        // editor now enriches the draft from the current Jira gadget catalogue, and
        // the next save persists the portable gadget metadata.
        setDraft((current) => {
          const list = (current.kpiProfile?.custom ?? []).map((item) => {
            if (String(item?.sourceType) !== 'dashboard') return item;
            const source = (nextSources.dashboardSources ?? []).find((entry) =>
              String(entry.dashboardId) === String(item.dashboardId) &&
              String(entry.gadgetId) === String(item.gadgetId)
            );
            if (!source) return item;
            return {
              ...item,
              gadgetTitle: source.gadgetTitle || item.gadgetTitle || item.name || '',
              gadgetType: source.gadgetType || normaliseDirectDashboardGadgetType(item),
              moduleKey: source.moduleKey || item.moduleKey || '',
              filterId: source.filterId || item.filterId || '',
              statisticType: source.statisticType || item.statisticType || '',
              xStatistic: source.xStatistic || item.xStatistic || '',
              yStatistic: source.yStatistic || item.yStatistic || '',
              period: source.period || item.period || '',
              daysPreviously: Number(source.daysPreviously || item.daysPreviously || 0),
              insightBoardId: source.boardId || item.insightBoardId || '',
              insightSprintId: source.sprintId || item.insightSprintId || '',
            };
          });
          return { ...current, kpiProfile: { ...current.kpiProfile, custom: list } };
        });
      })
      .catch((error) => { if (!cancelled) setNotice({ tone: 'error', message: String(error?.message ?? error ?? 'Unable to load Jira filters and dashboards.') }); })
      .finally(() => { if (!cancelled) setSourcesLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function handleSave() {
    try {
      setSaving(true);
      setNotice(null);
      const cleaned = mergeReportingSettings(draft);
      cleaned.kpiProfile = {
        ...cleaned.kpiProfile,
        custom: (cleaned.kpiProfile?.custom ?? []).map((item) => ({ ...item, aggregation: 'count' })),
      };
      const outcome = await onSave(cleaned);
      if (outcome?.ok === false) {
        setNotice({ tone: 'error', message: outcome.message || 'Unable to save custom KPI filters.' });
        return;
      }
      onClose();
    } catch (error) {
      setNotice({ tone: 'error', message: String(error?.message ?? error ?? 'Unable to save custom KPI filters.') });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="statusdeck-modal-backdrop no-export" role="presentation">
      <section className="statusdeck-modal custom-kpi-modal" role="dialog" aria-modal="true" aria-labelledby="custom-kpi-title">
        <div className="statusdeck-modal-header">
          <div>
            <p className="eyebrow">Custom Jira Insights</p>
            <h2 id="custom-kpi-title">Build the Report Around Your Jira</h2>
            <p>Reuse Jira filters, dashboard gadgets, or custom JQL exactly as configured. Dashboard visuals are reproduced when Jira exposes their portable gadget configuration.</p>
          </div>
          <button type="button" className="modal-close-button" onClick={onClose} aria-label="Close custom KPIs and filters">×</button>
        </div>
        <CustomKpiStudio draft={draft} setDraft={setDraft} sources={sources} sourcesLoading={sourcesLoading} />
        {notice ? <div className={`settings-validation-message settings-validation-message-${notice.tone}`} role="alert">{notice.message}</div> : null}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          <button type="button" className="primary-button" disabled={saving} onClick={handleSave}>{saving ? 'Saving…' : 'Save Jira Insights'}</button>
        </div>
      </section>
    </div>
  );
}

function ReportingSettingsModal({
  initialSettings,
  boardConfiguration,
  detectedEstimationLabel,
  onClose,
  onSave,
}) {
  const [draft, setDraft] = useState(() => mergeReportingSettings(initialSettings));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const numericFields = useMemo(() => {
    const seen = new Set(['issueCount', 'timeoriginalestimate']);
    return (boardConfiguration?.numericFields ?? []).filter((field) => {
      const id = String(field?.id ?? '').trim();
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [boardConfiguration]);
  const acceptanceCriteriaFields = useMemo(() => {
    const seen = new Set();
    return (boardConfiguration?.acceptanceCriteriaFields ?? []).filter((field) => {
      const id = String(field?.id ?? '').trim();
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [boardConfiguration]);

  async function handleSave() {
    const candidate = mergeReportingSettings(draft);
    const validationErrors = validateReportingSettings(candidate);
    if (validationErrors.length) {
      setNotice({ tone: 'error', message: validationErrors.join(' ') });
      return;
    }

    try {
      setSaving(true);
      setNotice(null);
      const outcome = await onSave(candidate);
      if (outcome?.ok === false) {
        setNotice({ tone: 'error', message: outcome.message || 'Unable to save reporting settings.' });
        return;
      }
      onClose();
    } catch (caughtError) {
      setNotice({
        tone: 'error',
        message: String(caughtError?.message ?? caughtError ?? 'Unable to save reporting settings.'),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="statusdeck-modal-backdrop no-export" role="presentation">
      <section className="statusdeck-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="statusdeck-modal-header">
          <div>
            <p className="eyebrow">Configuration Settings</p>
            <h2 id="settings-title">Reporting Profile</h2>
            <p>Jira is detected first. Configure only the organizational reporting rules that need an override.</p>
          </div>
          <button type="button" className="modal-close-button" onClick={onClose} aria-label="Close configuration">×</button>
        </div>

        <div className="settings-detection-card">
          <div>
            <strong>Estimation Source Detected From Jira Board</strong>
            <span className="detected-setting"><span aria-hidden="true">✓</span> {detectedEstimationLabel}</span>
          </div>
          <small>Board configuration remains the default. An override applies only to StatusDeck reporting.</small>
        </div>

        <div className="settings-grid">
          <label>
            <span>Estimation Override</span>
            <select value={draft.estimationOverride || ''} onChange={(event) => { const value = event.currentTarget.value; setDraft((current) => ({ ...current, estimationOverride: value })); }}>
              <option value="">Use Jira Board Setting ✓</option>
              <option value="issueCount">Issue Count</option>
              <option value="timeoriginalestimate">Original Estimate</option>
              {numericFields.map((field) => <option key={field.id} value={field.id}>{field.name}</option>)}
            </select>
          </label>
          <label><span>Green Completion ≥ %</span><input type="number" min="0" max="100" value={draft.rag.greenCompletion} onChange={(event) => { const value = event.currentTarget.value; setDraft((current) => ({ ...current, rag: { ...current.rag, greenCompletion: Number(value) } })); }} /></label>
          <label><span>Amber Completion ≥ %</span><input type="number" min="0" max="100" value={draft.rag.amberCompletion} onChange={(event) => { const value = event.currentTarget.value; setDraft((current) => ({ ...current, rag: { ...current.rag, amberCompletion: Number(value) } })); }} /></label>
          <label><span>Amber Unresolved Defects</span><input type="number" min="0" value={draft.rag.amberOpenDefects} onChange={(event) => { const value = event.currentTarget.value; setDraft((current) => ({ ...current, rag: { ...current.rag, amberOpenDefects: Number(value) } })); }} /></label>
          <label><span>Red Unresolved Defects</span><input type="number" min="0" value={draft.rag.redOpenDefects} onChange={(event) => { const value = event.currentTarget.value; setDraft((current) => ({ ...current, rag: { ...current.rag, redOpenDefects: Number(value) } })); }} /></label>
          <label><span>Amber Overdue Items</span><input type="number" min="0" value={draft.rag.amberOverdue} onChange={(event) => { const value = event.currentTarget.value; setDraft((current) => ({ ...current, rag: { ...current.rag, amberOverdue: Number(value) } })); }} /></label>
          <label><span>Red Overdue Items</span><input type="number" min="0" value={draft.rag.redOverdue} onChange={(event) => { const value = event.currentTarget.value; setDraft((current) => ({ ...current, rag: { ...current.rag, redOverdue: Number(value) } })); }} /></label>
          <label><span>Minimum Remaining Estimate Coverage %</span><input type="number" min="0" max="100" value={draft.rag.minimumRemainingEstimateCoverage} onChange={(event) => { const value = event.currentTarget.value; setDraft((current) => ({ ...current, rag: { ...current.rag, minimumRemainingEstimateCoverage: Number(value) } })); }} /></label>
          <label><span>Maximum Next-Sprint Velocity Load %</span><input type="number" min="25" max="300" value={draft.readiness.maximumVelocityLoad} onChange={(event) => { const value = event.currentTarget.value; setDraft((current) => ({ ...current, readiness: { ...current.readiness, maximumVelocityLoad: Number(value) } })); }} /></label>
          <label><span>Minimum Story Acceptance Criteria Coverage %</span><input type="number" min="0" max="100" value={draft.readiness.minimumAcceptanceCriteriaCoverage} onChange={(event) => { const value = event.currentTarget.value; setDraft((current) => ({ ...current, readiness: { ...current.readiness, minimumAcceptanceCriteriaCoverage: Number(value) } })); }} /></label>
          <label>
            <span>Acceptance Criteria Source</span>
            <select value={draft.readiness.acceptanceCriteriaFieldId || ''} onChange={(event) => { const value = event.currentTarget.value; setDraft((current) => ({ ...current, readiness: { ...current.readiness, acceptanceCriteriaFieldId: value } })); }}>
              <option value="">Auto Detect (Recommended)</option>
              {acceptanceCriteriaFields.map((field) => <option key={field.id} value={field.id}>{field.likely ? '★ ' : ''}{field.name}</option>)}
            </select>
          </label>
        </div>


        {notice ? <div className={`settings-validation-message settings-validation-message-${notice.tone}`} role="alert">{notice.message}</div> : null}

        <div className="methodology-note">
          <strong>Methodology Guardrail</strong>
          <p>These thresholds are organizational reporting policy, not Scrum rules. StatusDeck keeps incomplete work incomplete, preserves the Sprint Goal and Definition of Done, and treats estimates/velocity as team planning signals rather than individual productivity measures. Acceptance Criteria can be auto-detected from Jira Description / likely custom fields or explicitly mapped above.</p>
        </div>

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={() => { setDraft(mergeReportingSettings(DEFAULT_REPORTING_SETTINGS)); setNotice(null); }}>Restore Defaults</button>
          <button type="button" className="primary-button" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save Configuration'}</button>
        </div>
      </section>
    </div>
  );
}

function StatusDeckReportApp({ moduleContext }) {
  const [licenseStatus, setLicenseStatus] = useState({
    loading: true,
    active: false,
    state: 'unknown',
  });
  const [projects, setProjects] = useState([]);
  const [boards, setBoards] = useState([]);
  const [sprints, setSprints] = useState([]);

  const [projectKey, setProjectKey] = useState('');
  const [boardId, setBoardId] = useState('');
  const [sprintId, setSprintId] = useState('');

  const [report, setReport] = useState(null);
  const [projectReport, setProjectReport] = useState(null);
  const [velocityReport, setVelocityReport] = useState(null);

  const [projectCommentaryOverlay, setProjectCommentaryOverlay] = useState({ draft: '', published: '', state: 'generated' });
  const [projectCommentaryText, setProjectCommentaryText] = useState('');
  const [projectCommentarySaving, setProjectCommentarySaving] = useState(false);
  const [projectCommentaryNotice, setProjectCommentaryNotice] = useState(null);
  const [projectSectionMoveMenu, setProjectSectionMoveMenu] = useState(null);
  const [projectVisibleSections, setProjectVisibleSections] = useState(() => PROJECT_REPORT_SECTION_IDS.reduce((acc, id) => ({ ...acc, [id]: true }), {}));
  const [projectSectionOrder, setProjectSectionOrder] = useState(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem('statusdeck-project-section-order-v2') || '[]');
      const valid = Array.isArray(saved) ? saved.filter((id) => PROJECT_REPORT_SECTION_IDS.includes(id)) : [];
      const missing = PROJECT_REPORT_SECTION_IDS.filter((id) => !valid.includes(id));
      const next = [...valid];
      if (missing.includes('projectCustomJiraInsights')) {
        const healthIndex = next.indexOf('projectHealth');
        next.splice(healthIndex >= 0 ? healthIndex + 1 : 0, 0, 'projectCustomJiraInsights');
      }
      missing.filter((id) => id !== 'projectCustomJiraInsights').forEach((id) => next.push(id));
      return next;
    } catch {
      return [...PROJECT_REPORT_SECTION_IDS];
    }
  });

  const [loading, setLoading] = useState(true);
  const [loadingReport, setLoadingReport] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState({ percent: 0, label: '' });
  const [customKpiResults, setCustomKpiResults] = useState([]);
  const [reportingSettings, setReportingSettings] = useState(DEFAULT_REPORTING_SETTINGS);
  const [includeSubtasks, setIncludeSubtasks] =
    useState(false);

  const [burndownView, setBurndownView] =
    useState('daily');

  const [burndownBasis, setBurndownBasis] =
    useState('points');

  const [error, setError] = useState('');
  const [supplementaryWarning, setSupplementaryWarning] = useState('');

  const [visibleSections, setVisibleSections] = useState(
    DEFAULT_VISIBLE_SECTIONS
  );

  const [sectionOrder, setSectionOrder] = useState(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem('statusdeck-section-order-v3') || '[]');
      const valid = saved.filter((id) => REPORT_SECTIONS.some((section) => section.id === id));
      const missing = REPORT_SECTIONS.map((section) => section.id).filter((id) => !valid.includes(id));
      const next = [...valid];

      if (missing.includes('customJiraInsights')) {
        const overviewIndex = next.indexOf('overview');
        next.splice(overviewIndex >= 0 ? overviewIndex + 1 : 0, 0, 'customJiraInsights');
      }

      if (missing.includes('traceability')) {
        const insightsIndex = next.indexOf('customJiraInsights');
        const overviewIndex = next.indexOf('overview');
        const insertAt = insightsIndex >= 0 ? insightsIndex + 1 : (overviewIndex >= 0 ? overviewIndex + 1 : 0);
        next.splice(insertAt, 0, 'traceability');
      }

      if (missing.includes('burndown')) {
        const effortIndex = next.indexOf('effort');
        next.splice(effortIndex >= 0 ? effortIndex + 1 : Math.min(1, next.length), 0, 'burndown');
      }

      missing.filter((id) => !['burndown', 'customJiraInsights', 'traceability'].includes(id)).forEach((id) => next.push(id));
      return next;
    } catch {
      return REPORT_SECTIONS.map((section) => section.id);
    }
  });

  const [sectionSelectorCollapsed, setSectionSelectorCollapsed] =
    useState(false);
  const [sectionMoveMenu, setSectionMoveMenu] = useState(null);
  const [overviewMoveMenu, setOverviewMoveMenu] = useState(null);
  const [overviewOrder, setOverviewOrder] = useState(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem('statusdeck-overview-layout-order-v1') || '[]');
      const valid = Array.isArray(saved)
        ? saved.filter((id) => OVERVIEW_CARD_ORDER_DEFAULT.includes(id))
        : [];
      return [
        ...valid,
        ...OVERVIEW_CARD_ORDER_DEFAULT.filter((id) => !valid.includes(id)),
      ];
    } catch {
      return [...OVERVIEW_CARD_ORDER_DEFAULT];
    }
  });


  const [activeReportPreset, setActiveReportPreset] =
    useState('executive');

  // Custom Jira Insights are evaluated inside the report-generation pipeline so the
  // user sees one coherent progress bar and never a half-finished report. Aggregated
  // snapshots are cached only in this browser tab and reused by export/presentation.
  const customInsightCacheRef = useRef(new Map());



  // The report now uses normal document flow for top-level sections. The old
  // two-column pseudo-masonry layout calculated tiny grid-row spans at runtime;
  // when neighbouring sections had very different heights it could leave large
  // blank areas. Clear any legacy inline spans so every section follows its
  // content height naturally.
  useEffect(() => {
    const grid = document.querySelector('.report-layout-grid .report-main');
    if (!grid) return undefined;

    grid.querySelectorAll(
      ':scope > .report-header-card, :scope > .sprint-progress-strip, :scope > .report-section'
    ).forEach((item) => {
      item.style.gridRowEnd = '';
      delete item.dataset.statusdeckGridSpan;
    });

    return undefined;
  }, [report, sectionOrder, visibleSections, activeReportPreset]);

  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [presentationFilters, setPresentationFilters] =
    useState(FILTER_DEFAULTS);
  const [usageStatus, setUsageStatus] = useState(null);
  const [presentationMode, setPresentationMode] = useState(false);
  const [exporting, setExporting] = useState('');
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState('pptx');
  const [exportDestination, setExportDestination] = useState('download');
  const [confluenceSpaces, setConfluenceSpaces] = useState([]);
  const [confluenceSpacesLoading, setConfluenceSpacesLoading] = useState(false);
  const [confluenceSpaceId, setConfluenceSpaceId] = useState('');
  const [confluencePages, setConfluencePages] = useState([]);
  const [confluencePagesLoading, setConfluencePagesLoading] = useState(false);
  const [confluenceParentPageId, setConfluenceParentPageId] = useState('');
  const [confluenceChildPageTitle, setConfluenceChildPageTitle] = useState('');
  const confluencePagesCache = useRef(new Map());
  const [exportNotice, setExportNotice] = useState(null);
  const [publishSuccess, setPublishSuccess] = useState(null);
  const [lastPublication, setLastPublication] = useState(null);
  const [reportMeta, setReportMeta] = useState(null);
  const [nextSprintOutlook, setNextSprintOutlook] = useState(null);
  const [reportType, setReportType] = useState('sprint');
  const [boardConfiguration, setBoardConfiguration] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [customKpiOpen, setCustomKpiOpen] = useState(false);
  const [commentaryOverlay, setCommentaryOverlay] = useState({ draft: '', published: '', state: 'generated' });
  const [commentaryText, setCommentaryText] = useState('');
  const [commentarySaving, setCommentarySaving] = useState(false);
  const [commentaryNotice, setCommentaryNotice] = useState(null);
  const currentReportFingerprint = useMemo(() => getReportFingerprint(report), [report]);
  const commentaryStale = useMemo(() => {
    const hasSaved = Boolean(commentaryOverlay?.published || commentaryOverlay?.draft);
    if (!hasSaved || commentaryOverlay?.state === 'generated') return false;
    return !commentaryOverlay?.reportFingerprint || commentaryOverlay.reportFingerprint !== currentReportFingerprint;
  }, [commentaryOverlay, currentReportFingerprint]);
  const commentaryForExport = commentaryStale
    ? ''
    : (commentaryText || commentaryOverlay?.published || commentaryOverlay?.draft || '');
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantQuestion, setAssistantQuestion] = useState('');
  const [assistantMessages, setAssistantMessages] = useState([]);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantMode, setAssistantMode] = useState('instant');
  const [assistantContext, setAssistantContext] = useState({
    projectKey: '', projectName: '', boardId: '', boardName: '', sprintId: '', sprintName: '',
    lastIntent: '', lastIssueKeys: [], lastAssignee: '', lastComparedEntity: null, lastSprintChoices: [],
  });
  const assistantSprintCache = useRef(new Map());
  const assistantBoardsCache = useRef(new Map());
  const assistantSprintsCache = useRef(new Map());
  const assistantSettingsCache = useRef(new Map());
  const assistantPendingReportRef = useRef(null);
  const assistantProjectCatalogue = useMemo(() => buildAssistantProjectCatalogue(projects), [projects]);

  useEffect(() => {
    const target = assistantPendingReportRef.current;
    if (!target) return;
    if (projectKey !== target.projectKey) {
      setProjectKey(target.projectKey);
      return;
    }
    const targetBoardExists = boards.some((candidate) => String(candidate.id) === String(target.boardId));
    if (!targetBoardExists) return;
    if (String(boardId) !== String(target.boardId)) {
      setBoardId(String(target.boardId));
      return;
    }
    const targetSprintExists = sprints.some((candidate) => String(candidate.id) === String(target.sprintId));
    if (!targetSprintExists) return;
    if (String(sprintId) !== String(target.sprintId)) {
      setSprintId(String(target.sprintId));
      return;
    }
    assistantPendingReportRef.current = null;
    setReportType('sprint');
    const targetProjectObject = projects.find((candidate) => candidate.key === target.projectKey);
    const targetBoardObject = boards.find((candidate) => String(candidate.id) === String(target.boardId));
    (async () => {
      try {
        const targetSettings = targetProjectObject && targetBoardObject
          ? await getAssistantSettings(targetProjectObject, targetBoardObject)
          : reportingSettings;
        await loadReport(targetSettings);
      } catch (loadError) {
        console.error('Unable to load Assistant-selected report', loadError);
        appendAssistantMessage({ role: 'assistant', text: `I selected ${target.sprintName || 'the sprint'}, but StatusDeck could not load the report. ${String(loadError?.message ?? loadError ?? '')}` });
      }
    })();
  }, [projectKey, boards, boardId, sprints, sprintId]);
  const [schedulerOpen, setSchedulerOpen] = useState(false);
  const [schedulerNotice, setSchedulerNotice] = useState(null);
  const [reportSchedule, setReportSchedule] = useState({
    enabled: false, cadence: 'weekly', dayOfWeek: 5, time: '15:00',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', recipients: '', reminderMinutes: 15,
    message: 'StatusDeck reporting is due. Please review the current sprint report.',
  });


  useEffect(() => {
    try {
      window.localStorage.setItem('statusdeck-section-order-v3', JSON.stringify(sectionOrder));
    } catch {
      // Browser storage is a convenience only; report functionality must not depend on it.
    }
  }, [sectionOrder]);


  useEffect(() => {
    try {
      window.localStorage.setItem('statusdeck-project-section-order-v2', JSON.stringify(projectSectionOrder));
    } catch {
      // Project report layout preference is browser-local only.
    }
  }, [projectSectionOrder]);

  // Executive Overview movement is React-state-driven. Do not insert/reorder
  // React-owned DOM nodes imperatively: Configuration edits rerender the app and
  // manual DOM children can make React reconciliation fail with a blank page.
  useEffect(() => {
    try {
      window.localStorage.setItem('statusdeck-overview-layout-order-v1', JSON.stringify(overviewOrder));
    } catch {
      // Browser storage is an optional UI preference only.
    }
  }, [overviewOrder]);

  useEffect(() => {
    let cancelled = false;
    if (!projectKey || !boardId || !sprintId) {
      setLastPublication(null);
      return undefined;
    }

    invoke('getLastPublication', { projectKey, boardId, sprintId })
      .then((publication) => {
        if (!cancelled) setLastPublication(publication?.publishedAt ? publication : null);
      })
      .catch(() => {
        if (!cancelled) setLastPublication(null);
      });

    return () => {
      cancelled = true;
    };
  }, [projectKey, boardId, sprintId]);


  useEffect(() => {
    let mounted = true;

    async function loadLicenseStatus() {
      try {
        const result = await invoke('getLicenseStatus');

        if (mounted) {
          setLicenseStatus({
            loading: false,
            active: result?.active === true,
            state: result?.state ?? 'unknown',
          });
        }
      } catch (caughtError) {
        console.error('Unable to verify StatusDeck licence', caughtError);

        if (mounted) {
          setLicenseStatus({
            loading: false,
            active: false,
            state: 'error',
          });
        }
      }
    }

    loadLicenseStatus();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!licenseStatus.active) {
      return;
    }

    async function loadUsageStatus() {
      try {
        const result = await invoke('getUsageStatus');
        setUsageStatus(result);
      } catch (caughtError) {
        console.warn('Unable to load usage status', caughtError);
      }
    }

    loadUsageStatus();
  }, [licenseStatus.active]);

  // StatusDeck Context Catalogue: Jira projects are already loaded for the main
  // project selector, so the Assistant reuses that in-memory list instead of
  // making a second Forge call. Confluence spaces are fetched directly through
  // the bridge (no Forge resolver/runtime invocation) and kept only in browser
  // memory for publishing and context resolution.
  useEffect(() => {
    if (!licenseStatus.active) return undefined;
    let cancelled = false;
    setConfluenceSpacesLoading(true);
    fetchConfluenceCollection('/wiki/api/v2/spaces?limit=250&status=current', 4)
      .then((spaces) => {
        if (cancelled) return;
        const visibleSpaces = spaces
          .filter((space) => space?.status !== 'archived')
          .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
        setConfluenceSpaces(visibleSpaces);
      })
      .catch((caughtError) => {
        // Confluence is optional. Jira-only customers should not see an app
        // error just because the optional product is not connected.
        console.warn('StatusDeck Context Catalogue could not preload Confluence spaces', caughtError);
        if (!cancelled) setConfluenceSpaces([]);
      })
      .finally(() => { if (!cancelled) setConfluenceSpacesLoading(false); });
    return () => { cancelled = true; };
  }, [licenseStatus.active]);

  useEffect(() => {
    if (licenseStatus.loading) {
      return;
    }

    if (!licenseStatus.active) {
      setLoading(false);
      return;
    }

    async function initialise() {
      try {
        setLoading(true);
        setError('');

        const result = await invoke('getProjects');

        const softwareProjects = result.filter(
          (project) =>
            project.projectTypeKey === 'software'
        );

        setProjects(softwareProjects);

        const contextProjectKey =
          moduleContext?.extension?.project?.key ??
          moduleContext?.platformContext?.projectKey ??
          '';

        let savedProjectKey = '';

        try {
          savedProjectKey = window.localStorage.getItem(
            'statusdeck:lastProjectKey'
          ) ?? '';
        } catch (storageError) {
          console.warn('Unable to read last StatusDeck project', storageError);
        }

        const preferredProject =
          softwareProjects.find(
            (project) => project.key === contextProjectKey
          ) ??
          softwareProjects.find(
            (project) => project.key === savedProjectKey
          ) ??
          softwareProjects[0];

        if (preferredProject) {
          setProjectKey(preferredProject.key);
        }
      } catch (caughtError) {
        console.error(caughtError);

        if (markLicenseInactive(caughtError)) {
          return;
        }

        setError(
          caughtError.message ||
            'Unable to load Jira projects.'
        );
      } finally {
        setLoading(false);
      }
    }

    initialise();
  }, [licenseStatus.loading, licenseStatus.active]);

  useEffect(() => {
    if (!projectKey) return;
    try {
      window.localStorage.setItem('statusdeck:lastProjectKey', projectKey);
    } catch (storageError) {
      console.warn('Unable to remember StatusDeck project', storageError);
    }
  }, [projectKey]);

  useEffect(() => {
    if (!licenseStatus.active) {
      return;
    }

    if (!projectKey) {
      setBoards([]);
      setBoardId('');
      setSprints([]);
      setSprintId('');
      setReport(null);
      setProjectReport(null);
      setVelocityReport(null);
      setNextSprintOutlook(null);
      return;
    }

    async function loadBoards() {
      try {
        setError('');
        setReport(null);
        setVelocityReport(null);
        setNextSprintOutlook(null);
        setSprints([]);
        setSprintId('');

        const result = await invoke('getBoards', {
          projectKey,
        });

        setBoards(result);

        const preferredBoard =
          result.find(
            (board) => board.type === 'scrum'
          ) ?? result[0];

        setBoardId(
          preferredBoard
            ? String(preferredBoard.id)
            : ''
        );
      } catch (caughtError) {
        console.error(caughtError);

        if (markLicenseInactive(caughtError)) {
          return;
        }

        setError(
          caughtError.message ||
            'Unable to load project boards.'
        );
      }
    }

    loadBoards();
  }, [projectKey, licenseStatus.active]);

  useEffect(() => {
    if (!licenseStatus.active) {
      return;
    }

    if (!boardId || boardId === 'all') {
      setSprints([]);
      setSprintId('');
      setReport(null);
      setVelocityReport(null);
      setNextSprintOutlook(null);
      return;
    }

    async function loadSprints() {
      try {
        setError('');
        setReport(null);
        setVelocityReport(null);
        setNextSprintOutlook(null);

        const result = await invoke('getSprints', {
          boardId: Number(boardId),
        });

        setSprints(result);

        const preferredSprint =
          result.find(
            (sprint) => sprint.state === 'active'
          ) ??
          result.find(
            (sprint) => sprint.state === 'future'
          ) ??
          result.find(
            (sprint) => sprint.isLastSprint
          ) ??
          result[0];

        setSprintId(
          preferredSprint
            ? String(preferredSprint.id)
            : ''
        );
      } catch (caughtError) {
        console.error(caughtError);

        if (markLicenseInactive(caughtError)) {
          return;
        }

        setError(
          caughtError.message ||
            'Unable to load board sprints.'
        );
      }
    }

    loadSprints();
  }, [boardId, licenseStatus.active]);


  useEffect(() => {
    if (!licenseStatus.active || !projectKey) return;
    let cancelled = false;

    async function loadConfigurationLayer() {
      try {
        const settings = await invoke('getReportingSettings', {
          projectKey,
          boardId: boardId || 'all',
        });
        if (!cancelled) {
          const mergedSettings = mergeReportingSettings(settings);
          setReportingSettings(mergedSettings);
        }
      } catch (caughtError) {
        console.warn('Unable to load StatusDeck reporting settings', caughtError);
        if (!cancelled) {
          setReportingSettings(DEFAULT_REPORTING_SETTINGS);
        }
      }

      if (boardId) {
        try {
          const boardConfig = await invoke('getBoardReportingConfiguration', {
            boardId: Number(boardId),
          });
          if (!cancelled) setBoardConfiguration(boardConfig);
        } catch (caughtError) {
          console.warn('Unable to detect Jira board configuration', caughtError);
          if (!cancelled) setBoardConfiguration(null);
        }
      } else if (!cancelled) {
        setBoardConfiguration(null);
      }

      try {
        const schedule = await invoke('getReportSchedule', {
          projectKey,
          boardId: boardId || 'all',
        });
        if (!cancelled && schedule) {
          const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
          const effectiveTimeZone = schedule.updatedAt ? schedule.timeZone : (browserTimeZone || schedule.timeZone || 'UTC');
          setReportSchedule((current) => ({ ...current, ...schedule, timeZone: effectiveTimeZone, reminderMinutes: Number(schedule.reminderMinutes ?? current.reminderMinutes ?? 15) }));
        }
      } catch (caughtError) {
        console.warn('Unable to load StatusDeck reporting schedule', caughtError);
      }
    }

    loadConfigurationLayer();
    return () => { cancelled = true; };
  }, [licenseStatus.active, projectKey, boardId]);

  useEffect(() => {
    if (!confluenceSpaces.length) return;
    const currentProject = projects.find((project) => project.key === projectKey) ?? null;
    const selectedExists = confluenceSpaces.some((space) => String(space.id) === String(confluenceSpaceId));
    if (!selectedExists) {
      const preferred = chooseConfluenceSpaceForProject(confluenceSpaces, currentProject);
      setConfluenceSpaceId(preferred ? String(preferred.id) : '');
    }
  }, [confluenceSpaces, projects, projectKey, confluenceSpaceId]);

  useEffect(() => {
    if (!confluenceSpaceId) {
      setConfluencePages([]);
      setConfluenceParentPageId('');
      return undefined;
    }
    let cancelled = false;
    const selectedSpace = confluenceSpaces.find((space) => String(space.id) === String(confluenceSpaceId));
    const cached = confluencePagesCache.current.get(String(confluenceSpaceId));
    if (cached) {
      setConfluencePages(cached);
      const preferredParent = cached.find((page) => String(page.id) === String(selectedSpace?.homepageId)) || cached[0];
      if (!confluenceParentPageId || !cached.some((page) => String(page.id) === String(confluenceParentPageId))) {
        setConfluenceParentPageId(preferredParent ? String(preferredParent.id) : '');
      }
      return undefined;
    }

    setConfluencePagesLoading(true);
    fetchConfluenceCollection(`/wiki/api/v2/spaces/${encodeURIComponent(confluenceSpaceId)}/pages?limit=250`, 6)
      .then((pages) => {
        if (cancelled) return;
        const currentPages = pages
          .filter((page) => page?.status === 'current')
          .sort((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? '')));
        confluencePagesCache.current.set(String(confluenceSpaceId), currentPages);
        setConfluencePages(currentPages);
        const preferredParent = currentPages.find((page) => String(page.id) === String(selectedSpace?.homepageId)) || currentPages[0];
        setConfluenceParentPageId(preferredParent ? String(preferredParent.id) : '');
      })
      .catch((caughtError) => {
        console.warn('Unable to load Confluence pages for selected space', caughtError);
        if (!cancelled) {
          setConfluencePages([]);
          setConfluenceParentPageId('');
        }
      })
      .finally(() => { if (!cancelled) setConfluencePagesLoading(false); });
    return () => { cancelled = true; };
  }, [confluenceSpaceId, confluenceSpaces]);

  useEffect(() => {
    if (report?.sprint?.name) setConfluenceChildPageTitle(getConfluenceSprintPageTitle(report.sprint.name));
  }, [report?.sprint?.name]);

  useEffect(() => {
    if (!licenseStatus.active || !report?.sprint?.id || !projectKey || !boardId) {
      setCommentaryOverlay({ draft: '', published: '', state: 'generated', reportFingerprint: '' });
      setCommentaryText('');
      setCommentaryNotice(null);
      return;
    }

    let cancelled = false;
    invoke('getCommentaryOverlay', {
      projectKey,
      boardId,
      sprintId: report.sprint.id,
    })
      .then((overlay) => {
        if (cancelled) return;
        const value = overlay ?? { draft: '', published: '', state: 'generated' };
        setCommentaryOverlay(value);
        setCommentaryText(value.state === 'draft' ? value.draft ?? '' : value.published ?? value.draft ?? '');
      })
      .catch((caughtError) => {
        console.warn('Unable to load saved commentary', caughtError);
      });

    return () => { cancelled = true; };
  }, [licenseStatus.active, report?.sprint?.id, projectKey, boardId]);

  useEffect(() => {
    if (!licenseStatus.active || !projectReport || !projectKey) {
      setProjectCommentaryOverlay({ draft: '', published: '', state: 'generated' });
      setProjectCommentaryText('');
      setProjectCommentaryNotice(null);
      return;
    }

    let cancelled = false;
    invoke('getCommentaryOverlay', {
      projectKey,
      boardId: 'project-program',
      sprintId: 'project-program',
    })
      .then((overlay) => {
        if (cancelled) return;
        const value = overlay ?? { draft: '', published: '', state: 'generated' };
        setProjectCommentaryOverlay(value);
        setProjectCommentaryText(value.state === 'draft' ? value.draft ?? '' : value.published ?? value.draft ?? '');
      })
      .catch((caughtError) => console.warn('Unable to load saved project commentary', caughtError));

    return () => { cancelled = true; };
  }, [licenseStatus.active, projectReport?.generatedAt, projectKey]);

  async function saveReportingSettings(candidateSettings) {
    const draft = mergeReportingSettings(candidateSettings);
    const validationErrors = validateReportingSettings(draft);
    if (validationErrors.length) return { ok: false, message: validationErrors.join(' ') };

    const previousSettings = mergeReportingSettings(reportingSettings);
    const estimationChanged = String(draft.estimationOverride || '') !== String(previousSettings.estimationOverride || '');
    const acceptanceCriteriaSourceChanged = String(draft.readiness?.acceptanceCriteriaFieldId || '') !== String(previousSettings.readiness?.acceptanceCriteriaFieldId || '');
    const nativeKpiChanged = JSON.stringify(draft.kpiProfile?.native ?? {}) !== JSON.stringify(previousSettings.kpiProfile?.native ?? {});
    const customKpiChanged = JSON.stringify(draft.kpiProfile?.custom ?? []) !== JSON.stringify(previousSettings.kpiProfile?.custom ?? []);

    try {
      const saved = await invoke('saveReportingSettings', {
        projectKey,
        boardId: boardId || 'all',
        settings: draft,
      });
      const mergedSaved = mergeReportingSettings(saved);

      // Estimation changes affect the native report calculations, so they still need
      // one transactional report refresh. Custom Jira Insight changes do not: keep the
      // visible report snapshot and evaluate only the changed/new insight definitions.
      // Unchanged insight results come from customInsightCacheRef and native KPI visibility
      // changes are presentation-only, so neither path reloads Sprint/Velocity/Outlook.
      if ((estimationChanged || acceptanceCriteriaSourceChanged) && (report || projectReport)) {
        try {
          await loadReport(mergedSaved, { throwOnError: true });
        } catch (reloadError) {
          try {
            await invoke('saveReportingSettings', {
              projectKey,
              boardId: boardId || 'all',
              settings: previousSettings,
            });
          } catch (rollbackError) {
            console.warn('Unable to roll back StatusDeck reporting settings', rollbackError);
          }
          throw reloadError;
        }
      } else if (customKpiChanged && (report || projectReport)) {
        await refreshCustomInsightsOnly(mergedSaved);
      }

      setReportingSettings(mergedSaved);
      if (nativeKpiChanged && !customKpiChanged) {
        // Native KPI visibility is intentionally applied from the existing report snapshot.
      }
      setError('');
      return { ok: true };
    } catch (caughtError) {
      const message = String(caughtError?.message ?? caughtError ?? 'Unable to save reporting settings.');
      setError(message);
      return { ok: false, message };
    }
  }

  async function saveCommentary(state, textOverride) {
    if (!report?.sprint?.id) return;
    const textToSave = String(textOverride ?? commentaryText ?? '').trim();
    if (!textToSave) return;
    try {
      setCommentarySaving(true);
      const saved = await invoke('saveCommentaryOverlay', {
        projectKey,
        boardId,
        sprintId: report.sprint.id,
        state,
        text: textToSave,
        reportFingerprint: currentReportFingerprint,
      });
      setCommentaryOverlay(saved);
      setCommentaryText(textToSave);
      setError('');
      setCommentaryNotice({
        tone: 'success',
        message: state === 'published'
          ? 'Published successfully.'
          : 'Draft saved successfully.',
      });
      window.setTimeout(() => setCommentaryNotice(null), 4000);
    } catch (caughtError) {
      const message = caughtError.message || 'Unable to save commentary.';
      setError(message);
      setCommentaryNotice({
        tone: 'error',
        message: state === 'published' ? `Publish failed: ${message}` : `Save failed: ${message}`,
      });
      window.setTimeout(() => setCommentaryNotice(null), 6000);
    } finally {
      setCommentarySaving(false);
    }
  }

  async function resetCommentary() {
    if (!report?.sprint?.id) return;
    try {
      await invoke('clearCommentaryOverlay', {
        projectKey,
        boardId,
        sprintId: report.sprint.id,
      });
      setCommentaryOverlay({ draft: '', published: '', state: 'generated' });
      setCommentaryText('');
      setCommentaryNotice({ tone: 'success', message: 'Generated commentary restored.' });
      window.setTimeout(() => setCommentaryNotice(null), 4000);
    } catch (caughtError) {
      const message = caughtError.message || 'Unable to reset commentary.';
      setError(message);
      setCommentaryNotice({ tone: 'error', message: `Restore failed: ${message}` });
      window.setTimeout(() => setCommentaryNotice(null), 6000);
    }
  }


  async function saveProjectCommentary(state, textOverride) {
    if (!projectReport || !projectKey) return;
    const textToSave = String(textOverride ?? projectCommentaryText ?? '').trim();
    if (!textToSave) return;
    try {
      setProjectCommentarySaving(true);
      const saved = await invoke('saveCommentaryOverlay', {
        projectKey,
        boardId: 'project-program',
        sprintId: 'project-program',
        state,
        text: textToSave,
      });
      setProjectCommentaryOverlay(saved);
      setProjectCommentaryText(textToSave);
      setProjectCommentaryNotice({
        tone: 'success',
        message: state === 'published' ? 'Published successfully.' : 'Draft saved successfully.',
      });
      window.setTimeout(() => setProjectCommentaryNotice(null), 4000);
    } catch (caughtError) {
      const message = caughtError?.message || 'Unable to save project commentary.';
      setError(message);
      setProjectCommentaryNotice({ tone: 'error', message: state === 'published' ? `Publish failed: ${message}` : `Save failed: ${message}` });
      window.setTimeout(() => setProjectCommentaryNotice(null), 6000);
    } finally {
      setProjectCommentarySaving(false);
    }
  }

  async function resetProjectCommentary() {
    if (!projectReport || !projectKey) return;
    try {
      await invoke('clearCommentaryOverlay', {
        projectKey,
        boardId: 'project-program',
        sprintId: 'project-program',
      });
      setProjectCommentaryOverlay({ draft: '', published: '', state: 'generated' });
      setProjectCommentaryText('');
      setProjectCommentaryNotice({ tone: 'success', message: 'Generated commentary restored.' });
      window.setTimeout(() => setProjectCommentaryNotice(null), 4000);
    } catch (caughtError) {
      const message = caughtError?.message || 'Unable to reset project commentary.';
      setError(message);
      setProjectCommentaryNotice({ tone: 'error', message: `Restore failed: ${message}` });
      window.setTimeout(() => setProjectCommentaryNotice(null), 6000);
    }
  }

  async function saveReportSchedule() {
    const validationErrors = validateCalendarSchedule(reportSchedule);
    if (validationErrors.length) {
      setSchedulerNotice({ tone: 'error', message: validationErrors.join(' ') });
      return null;
    }
    try {
      const saved = await invoke('saveReportSchedule', {
        projectKey,
        boardId: boardId || 'all',
        schedule: reportSchedule,
      });
      setReportSchedule((current) => ({ ...current, ...saved }));
      setSchedulerNotice({ tone: 'success', message: `Schedule saved for ${saved.time} ${saved.timeZone}. Add it to your calendar below.` });
      setError('');
      return saved;
    } catch (caughtError) {
      const message = caughtError.message || 'Unable to save reporting schedule.';
      setError(message);
      setSchedulerNotice({ tone: 'error', message });
      return null;
    }
  }

  function getCalendarContext() {
    const project = projects.find((item) => item.key === projectKey);
    const board = boards.find((item) => String(item.id) === String(boardId));
    return { projectName: project?.name || projectKey || 'Jira', boardName: board?.name || '' };
  }

  async function addScheduleToGoogleCalendar() {
    const validationErrors = validateCalendarSchedule(reportSchedule);
    if (validationErrors.length) { setSchedulerNotice({ tone: 'error', message: validationErrors.join(' ') }); return; }
    const calendar = buildCalendarInvite(reportSchedule, getCalendarContext());
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: calendar.title,
      dates: `${calendar.start}/${calendar.end}`,
      ctz: calendar.timeZone,
      details: calendar.description,
      recur: calendar.recurrence,
    });
    await router.open(`https://calendar.google.com/calendar/render?${params.toString()}`);
  }

  async function addScheduleToOutlookCalendar() {
    const validationErrors = validateCalendarSchedule(reportSchedule);
    if (validationErrors.length) { setSchedulerNotice({ tone: 'error', message: validationErrors.join(' ') }); return; }
    const calendar = buildCalendarInvite(reportSchedule, getCalendarContext());
    const params = new URLSearchParams({
      path: '/calendar/action/compose',
      rru: 'addevent',
      subject: calendar.title,
      startdt: calendar.isoStart,
      enddt: calendar.isoEnd,
      body: `${calendar.description}\n\nRecurring schedule: ${reportSchedule.cadence}${reportSchedule.cadence === 'weekly' ? `, weekday ${reportSchedule.dayOfWeek}` : ''}. For guaranteed recurrence import the .ics option in StatusDeck.`,
    });
    await router.open(`https://outlook.office.com/calendar/0/deeplink/compose?${params.toString()}`);
  }

  function downloadScheduleCalendarInvite() {
    const validationErrors = validateCalendarSchedule(reportSchedule);
    if (validationErrors.length) { setSchedulerNotice({ tone: 'error', message: validationErrors.join(' ') }); return; }
    downloadCalendarInvite(reportSchedule, getCalendarContext());
    setSchedulerNotice({ tone: 'success', message: 'Recurring calendar invite downloaded.' });
  }

  async function getAssistantBoards(targetProject) {
    if (targetProject.key === projectKey && boards.length) return boards;
    const cacheKey = String(targetProject.key);
    if (assistantBoardsCache.current.has(cacheKey)) return assistantBoardsCache.current.get(cacheKey);
    // Assistant metadata lookups go directly through the Forge bridge as the
    // current user. They do not wake a backend resolver/function just to list
    // boards, which keeps the Context Catalogue lightweight.
    const response = await requestJira(`/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(targetProject.key)}&maxResults=50`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Unable to load Jira boards for ${targetProject.name} (${response.status}).`);
    const payload = await response.json();
    const result = (payload?.values ?? []).map((board) => ({
      id: board.id,
      name: board.name,
      type: board.type,
      locationName: board.location?.displayName ?? '',
    }));
    assistantBoardsCache.current.set(cacheKey, result);
    return result;
  }

  async function getAssistantSprints(targetBoard, maxItems = 100) {
    if (String(targetBoard.id) === String(boardId) && sprints.length && sprints.length >= Math.min(maxItems, 50)) return sprints;
    const cacheKey = String(targetBoard.id);
    const cached = assistantSprintsCache.current.get(cacheKey);
    if (cached?.items?.length && (cached.complete || cached.loadedLimit >= maxItems)) return cached.items;

    const all = cached?.items ? [...cached.items] : [];
    let startAt = all.length;
    let isLast = Boolean(cached?.complete);
    while (!isLast && all.length < maxItems) {
      const remaining = Math.max(1, Math.min(50, maxItems - all.length));
      const response = await requestJira(`/rest/agile/1.0/board/${encodeURIComponent(targetBoard.id)}/sprint?startAt=${startAt}&maxResults=${remaining}`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`Unable to load sprints for ${targetBoard.name} (${response.status}).`);
      const payload = await response.json();
      const values = payload?.values ?? [];
      all.push(...values);
      isLast = Boolean(payload?.isLast) || values.length === 0;
      startAt += Number(payload?.maxResults ?? values.length ?? remaining);
    }
    const unique = [...new Map(all.map((sprint) => [String(sprint.id), sprint])).values()];
    const mapped = unique.map((sprint) => ({
      id: sprint.id, name: sprint.name, state: sprint.state, goal: sprint.goal ?? '',
      startDate: sprint.startDate ?? null, endDate: sprint.endDate ?? null, completeDate: sprint.completeDate ?? null,
    }));
    const newestClosed = mapped.filter((sprint) => sprint.state === 'closed')
      .sort((a, b) => new Date(b.completeDate ?? b.endDate ?? 0) - new Date(a.completeDate ?? a.endDate ?? 0))[0]?.id ?? null;
    const stateOrder = { active: 0, future: 1, closed: 2 };
    const result = mapped.map((sprint) => ({ ...sprint, isLastSprint: sprint.state === 'closed' && sprint.id === newestClosed }))
      .sort((a, b) => (stateOrder[a.state] ?? 9) - (stateOrder[b.state] ?? 9) || new Date(b.completeDate ?? b.endDate ?? b.startDate ?? 0) - new Date(a.completeDate ?? a.endDate ?? a.startDate ?? 0));
    assistantSprintsCache.current.set(cacheKey, { items: result, loadedLimit: Math.max(maxItems, result.length), complete: isLast });
    return result;
  }

  async function fetchAssistantSnapshot(targetProject, targetBoard, targetSprint, targetSettings) {
    const estimationOverride = String(targetSettings?.estimationOverride ?? '');
    const cacheKey = `${targetProject.key}:${targetBoard.id}:${targetSprint.id}:${includeSubtasks ? 1 : 0}:${estimationOverride}`;
    if (assistantSprintCache.current.has(cacheKey)) return assistantSprintCache.current.get(cacheKey);
    const snapshot = await invoke('getAssistantSprintSnapshot', {
      projectKey: targetProject.key,
      boardId: Number(targetBoard.id),
      sprintId: Number(targetSprint.id),
      includeSubtasks,
      estimationOverride,
    });
    assistantSprintCache.current.set(cacheKey, snapshot);
    return snapshot;
  }

  async function getAssistantSettings(targetProject, targetBoard) {
    if (targetProject.key === projectKey && String(targetBoard.id) === String(boardId)) return reportingSettings;
    const cacheKey = `${targetProject.key}:${targetBoard.id}`;
    if (assistantSettingsCache.current.has(cacheKey)) return assistantSettingsCache.current.get(cacheKey);
    try {
      const settings = mergeReportingSettings(await invoke('getReportingSettings', { projectKey: targetProject.key, boardId: String(targetBoard.id) }));
      assistantSettingsCache.current.set(cacheKey, settings);
      return settings;
    } catch {
      assistantSettingsCache.current.set(cacheKey, DEFAULT_REPORTING_SETTINGS);
      return DEFAULT_REPORTING_SETTINGS;
    }
  }

  function appendAssistantMessage(message) {
    setAssistantMessages((current) => [...current, message]);
  }

  function updateAssistantContext(targetProject, targetBoard, targetSprint, additions = {}) {
    setAssistantContext((current) => ({
      ...current,
      projectKey: targetProject?.key ?? current.projectKey,
      projectName: targetProject?.name ?? current.projectName,
      boardId: targetBoard?.id != null ? String(targetBoard.id) : current.boardId,
      boardName: targetBoard?.name ?? current.boardName,
      sprintId: targetSprint?.id != null ? String(targetSprint.id) : current.sprintId,
      sprintName: targetSprint?.name ?? current.sprintName,
      ...additions,
    }));
  }

  async function handleAssistantAction(action) {
    if (!action) return;
    if (typeof action === 'string') { await submitAssistantQuestion(action); return; }
    if (action.type === 'question') { await submitAssistantQuestion(action.question || action.label); return; }
    if (action.type === 'generate-report' || action.type === 'load-report') {
      const target = action.target ?? {};
      if (!target.projectKey || !target.boardId || !target.sprintId) {
        appendAssistantMessage({ role: 'assistant', text: 'I no longer have enough Jira context to load that report. Please name the sprint again.' });
        return;
      }
      assistantPendingReportRef.current = { ...target, generate: action.type === 'generate-report' };
      setReportType('sprint');
      if (projectKey !== target.projectKey) setProjectKey(target.projectKey);
      else if (String(boardId) !== String(target.boardId)) setBoardId(String(target.boardId));
      else if (String(sprintId) !== String(target.sprintId)) setSprintId(String(target.sprintId));
      else {
        assistantPendingReportRef.current = null;
        await loadReport();
      }
      appendAssistantMessage({ role: 'assistant', text: `Loading ${target.sprintName || 'the selected sprint'} in StatusDeck. The normal report pipeline will be used.` });
      return;
    }
    if (action.type === 'publish') {
      const target = action.target ?? {};
      const matchesLoaded = report && String(report?.sprint?.id) === String(target.sprintId) && projectKey === target.projectKey && String(boardId) === String(target.boardId);
      if (matchesLoaded) {
        setExportModalOpen(true);
      } else {
        appendAssistantMessage({
          role: 'assistant',
          text: 'That sprint is not the report currently loaded in StatusDeck. Load it first, then I can open Export / Publish.',
          actions: [assistantCommandAction('Load this sprint', 'load-report', target)],
        });
      }
    }
  }

  async function submitAssistantQuestion(questionOverride) {
    const question = String(questionOverride ?? assistantQuestion ?? '').trim();
    if (!question || assistantBusy) return;
    setAssistantQuestion('');
    appendAssistantMessage({ role: 'user', text: question });

    const normalizedInput = normalizeAssistantInput(question);
    const smallTalk = classifySmallTalk(normalizedInput.normalized);
    if (smallTalk) {
      const response = buildSmallTalkResponse(smallTalk);
      appendAssistantMessage({ role: 'assistant', text: response.text, actions: response.actions });
      return;
    }

    const references = resolveConversationalReferences(normalizedInput.normalized, assistantContext);
    const temporalRequest = getAssistantTemporalRequest(normalizedInput.normalized);
    let intent = resolveAssistantIntent(normalizedInput.normalized);
    if (intent.type === 'UNKNOWN' && temporalRequest.type === 'future-list') intent = { type: 'LIST_FUTURE_SPRINTS', confidence: 'medium' };
    if (intent.type === 'UNKNOWN' && references.listChoiceIndex != null && (assistantContext.lastSprintChoices ?? []).length) intent = { type: 'SELECT_SPRINT', confidence: 'medium' };
    const analysisPlan = getAssistantAnalysisPlan(assistantMode, intent.type);

    // Recognised Agile concepts that are not currently calculated are handled
    // locally. Do not wake Jira/Forge just to pretend we have a KPI we do not.
    if (intent.type === 'UNSUPPORTED_KPI') {
      const unsupported = buildUnsupportedAgileAnswer(intent.concept);
      appendAssistantMessage({
        role: 'assistant',
        text: unsupported.text,
        actions: ['Give me a sprint summary', 'Show burndown', 'Show commitment vs delivery', 'Show sprint predictability'],
      });
      return;
    }

    const projectResolution = resolveAssistantProject({
      question: normalizedInput.normalized,
      catalogue: assistantProjectCatalogue,
      fallbackKey: assistantContext.projectKey || projectKey,
      references,
    });

    // Unknown conversational text should never trigger a Jira fetch merely
    // because an old project is in context. Ask for intent instead of guessing.
    if (intent.type === 'UNKNOWN' && !projectResolution.explicit && !references.relativeSprint && !references.referencesIssueSet && references.listChoiceIndex == null) {
      appendAssistantMessage({
        role: 'assistant',
        text: 'I am not sure what you want me to do with that. Ask about sprint health, completion, commitment vs delivery, burndown, scope, risks, workload, defects, estimates, velocity, predictability, future sprints, a comparison, or a report action.',
        actions: ['Give me a sprint summary', 'Show burndown', 'Show commitment vs delivery', 'What are the current risks?'],
      });
      return;
    }

    if (!projectResolution.project) {
      if (projectResolution.explicit && projectResolution.candidates.length) {
        appendAssistantMessage({
          role: 'assistant',
          text: `I found multiple Jira projects matching “${projectResolution.phrase}”.\n${projectResolution.candidates.map((candidate) => `• ${candidate.name} (${candidate.key})`).join('\n')}\n\nPlease mention the exact project name or key.`,
        });
        return;
      }
      if (projectResolution.explicit) {
        appendAssistantMessage({
          role: 'assistant',
          text: `I could not find an accessible Jira project matching “${projectResolution.phrase}”. I did not fall back to the currently selected project.`,
        });
        return;
      }
      appendAssistantMessage({ role: 'assistant', text: 'I could not identify the Jira project. Mention a project name/key, or first ask about the currently selected sprint.' });
      return;
    }

    const targetProject = projectResolution.project;

    if (intent.type === 'UNKNOWN' && projectResolution.explicit) {
      updateAssistantContext(targetProject, null, null, { lastIntent: 'PROJECT_CONTEXT' });
      appendAssistantMessage({
        role: 'assistant',
        text: `${targetProject.name} (${targetProject.key})\n\nI found that Jira project. What would you like to know?`,
        actions: ['Give me a sprint summary', 'Show burndown', 'What are the current risks?', 'Show sprint predictability'],
      });
      return;
    }

    if (intent.type === 'HELP') {
      appendAssistantMessage({
        role: 'assistant',
        text: `StatusDeck Assistant
• Sprint health, completion and commitment vs delivery
• Burndown, scope movement, carry-over and predictability signals
• Risks, overdue work, defects, blockers and workload
• Status, work-item type and priority distributions
• Estimates, unestimated work, velocity and throughput
• Sprint Goal, aging open work and future sprints
• Sprint/project comparisons and report actions

If a metric such as cycle time or backlog health is not supported by the current Jira snapshot, I will say so instead of inventing a value.

Mode: ${ASSISTANT_MODES[assistantMode].label}. Jira data is fetched lazily and only for the requested intent.`
      });
      return;
    }

    if (intent.type === 'COMPARE' && projectResolution.explicit && assistantContext.projectKey && assistantContext.projectKey !== targetProject.key && !/\b(sprint|current|active|previous|last)\b/i.test(normalizedInput.normalized)) {
      appendAssistantMessage({
        role: 'assistant',
        text: `I found ${targetProject.name} (${targetProject.key}). What do you want to compare with the current ${assistantContext.projectKey} context?`,
        actions: [
          `Compare current sprints with ${targetProject.name}`,
          `Compare the previous sprint with ${targetProject.name}`,
        ],
      });
      return;
    }

    setAssistantBusy(true);
    try {
      const targetBoards = await getAssistantBoards(targetProject);
      if (!targetBoards.length) throw new Error(`No Jira Software board is available for ${targetProject.name}.`);

      const q = normalizedInput.normalized;
      const mentionedBoard = targetBoards.find((candidate) => q.includes(String(candidate.name ?? '').toLowerCase()));
      const contextualBoard = targetProject.key === assistantContext.projectKey
        ? targetBoards.find((candidate) => String(candidate.id) === String(assistantContext.boardId))
        : null;
      const selectedBoard = targetProject.key === projectKey
        ? targetBoards.find((candidate) => String(candidate.id) === String(boardId))
        : null;
      let targetBoard = mentionedBoard || contextualBoard || selectedBoard || targetBoards.find((candidate) => candidate.type === 'scrum') || targetBoards[0];

      const refs = getAssistantSprintReferences(q);
      if (!refs.length && references.sprintReference) refs.push(references.sprintReference);
      if (!refs.length && /previous\s+sprint|last\s+sprint/i.test(q)) refs.push('previous');
      if (!refs.length && /next\s+sprint/i.test(q)) refs.push('next');
      if (!refs.length && /active\s+sprint|current\s+sprint/i.test(q)) refs.push('active');

      const hasNamedHistoricalSprint = refs.some((ref) => !['context', 'active', 'current', 'previous', 'last', 'next'].includes(ref));
      const sprintMetadataLimit = hasNamedHistoricalSprint || intent.type === 'COMPARE' || intent.type === 'LIST_FUTURE_SPRINTS' || intent.type === 'SELECT_SPRINT'
        ? analysisPlan.maxSprintMetadata
        : 50;
      let targetSprints = await getAssistantSprints(targetBoard, sprintMetadataLimit);
      if (!targetSprints.length) throw new Error(`No sprints are available on ${targetBoard.name}.`);

      // Named sprints can live on another Scrum board in the same project. We
      // inspect boards only when the user actually asks for a named sprint.
      if (refs.length && refs.some((ref) => !['context', 'active', 'current', 'previous', 'last', 'next'].includes(ref)) && !refs.every((ref) => findAssistantSprint(targetSprints, ref, assistantContext.sprintId))) {
        for (const candidateBoard of targetBoards.filter((candidate) => String(candidate.id) !== String(targetBoard.id) && candidate.type === 'scrum')) {
          const candidateSprints = await getAssistantSprints(candidateBoard, sprintMetadataLimit);
          if (refs.every((ref) => findAssistantSprint(candidateSprints, ref, assistantContext.sprintId))) {
            targetBoard = candidateBoard;
            targetSprints = candidateSprints;
            break;
          }
        }
      }

      const currentContextSprintId = targetProject.key === assistantContext.projectKey && String(targetBoard.id) === String(assistantContext.boardId)
        ? assistantContext.sprintId
        : null;

      if (intent.type === 'LIST_FUTURE_SPRINTS') {
        const baseSprintId = currentContextSprintId
          || (targetProject.key === projectKey && String(targetBoard.id) === String(boardId) ? String(sprintId || report?.sprint?.id || '') : '');
        const futureSprints = getAssistantFutureSprints(targetSprints, baseSprintId, temporalRequest.count || 5);
        const baseSprint = baseSprintId ? targetSprints.find((item) => String(item.id) === String(baseSprintId)) : null;
        if (!futureSprints.length) {
          updateAssistantContext(targetProject, targetBoard, baseSprint, { lastIntent: 'LIST_FUTURE_SPRINTS', lastSprintChoices: [] });
          appendAssistantMessage({
            role: 'assistant',
            text: `${targetProject.name} (${targetProject.key})\n${targetBoard.name}\n\nUpcoming sprints\n• I could not find any future sprint after ${baseSprint?.name || 'the current sprint'} on this board.`,
            actions: ['Give me a sprint summary', 'Compare with the previous sprint'],
          });
          return;
        }
        const lines = futureSprints.map((item, index) => {
          const date = item.startDate ? new Date(item.startDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
          return `${index + 1}. ${item.name}${date ? ` — starts ${date}` : ''}${item.state ? ` · ${item.state}` : ''}`;
        });
        const choices = futureSprints.map((item) => ({ id: String(item.id), name: item.name, boardId: String(targetBoard.id), projectKey: targetProject.key }));
        updateAssistantContext(targetProject, targetBoard, baseSprint, { lastIntent: 'LIST_FUTURE_SPRINTS', lastSprintChoices: choices });
        appendAssistantMessage({
          role: 'assistant',
          text: `${targetProject.name} (${targetProject.key})\n${targetBoard.name}\n\nUpcoming sprints\n${lines.join('\n')}`,
          actions: assistantFollowUps('LIST_FUTURE_SPRINTS', { futureSprints, futureCount: futureSprints.length, currentSprintName: baseSprint?.name || 'current sprint' }),
        });
        return;
      }

      let targetSprint = null;
      if (intent.type === 'SELECT_SPRINT' && references.listChoiceIndex != null) {
        const choice = (assistantContext.lastSprintChoices ?? [])[references.listChoiceIndex];
        if (choice && choice.projectKey === targetProject.key && String(choice.boardId) === String(targetBoard.id)) {
          targetSprint = targetSprints.find((item) => String(item.id) === String(choice.id)) || targetSprints.find((item) => item.name === choice.name) || null;
        }
        if (!targetSprint) {
          appendAssistantMessage({ role: 'assistant', text: 'I no longer have that sprint list in context. Ask me to show the future sprints again.' });
          return;
        }
        updateAssistantContext(targetProject, targetBoard, targetSprint, { lastIntent: 'SELECT_SPRINT' });
        appendAssistantMessage({
          role: 'assistant',
          text: `${targetProject.name} (${targetProject.key})\n${targetBoard.name} · ${targetSprint.name}\n\nSelected sprint\n• I will use ${targetSprint.name} for your next question.`,
          actions: assistantFollowUps('SELECT_SPRINT'),
        });
        return;
      }

      targetSprint = refs.length ? findAssistantSprint(targetSprints, refs[0], currentContextSprintId) : null;
      if (!targetSprint && references.usesContextSprint && currentContextSprintId) targetSprint = findAssistantSprint(targetSprints, 'context', currentContextSprintId);
      if (!targetSprint && currentContextSprintId) targetSprint = findAssistantSprint(targetSprints, '', currentContextSprintId);
      if (!targetSprint && targetProject.key === projectKey && String(targetBoard.id) === String(boardId) && sprintId) {
        targetSprint = targetSprints.find((item) => String(item.id) === String(sprintId)) || null;
      }
      if (!targetSprint && targetProject.key === projectKey && String(targetBoard.id) === String(boardId) && report?.sprint?.id) {
        targetSprint = targetSprints.find((item) => String(item.id) === String(report.sprint.id)) || null;
      }
      if (!targetSprint) targetSprint = targetSprints.find((item) => item.state === 'active') || targetSprints.find((item) => item.isLastSprint) || targetSprints[0];
      if (!targetSprint) throw new Error('I could not resolve the sprint from that question.');

      const actionTarget = {
        projectKey: targetProject.key, projectName: targetProject.name,
        boardId: String(targetBoard.id), boardName: targetBoard.name,
        sprintId: String(targetSprint.id), sprintName: targetSprint.name,
      };

      if (intent.type === 'GENERATE_REPORT' || intent.type === 'LOAD_SPRINT') {
        updateAssistantContext(targetProject, targetBoard, targetSprint, { lastIntent: intent.type });
        appendAssistantMessage({
          role: 'assistant',
          text: `${targetProject.name} (${targetProject.key})\n${targetBoard.name} · ${targetSprint.name}\n\nI resolved “${references.hasPronoun ? 'this/it' : targetSprint.name}” to this Jira sprint. I can load it through the normal StatusDeck report pipeline.`,
          actions: [assistantCommandAction(intent.type === 'GENERATE_REPORT' ? 'Generate Executive Report' : 'Load this sprint', intent.type === 'GENERATE_REPORT' ? 'generate-report' : 'load-report', actionTarget)],
        });
        return;
      }

      if (intent.type === 'PUBLISH') {
        updateAssistantContext(targetProject, targetBoard, targetSprint, { lastIntent: intent.type });
        const matchesLoaded = report && projectKey === targetProject.key && String(boardId) === String(targetBoard.id) && String(report?.sprint?.id) === String(targetSprint.id);
        appendAssistantMessage({
          role: 'assistant',
          text: matchesLoaded
            ? `${targetSprint.name} is the report currently loaded in StatusDeck. I can open Export / Publish.`
            : `${targetSprint.name} is not the report currently loaded. Load it first, then publish it.`,
          actions: matchesLoaded
            ? [assistantCommandAction('Open Export / Publish', 'publish', actionTarget)]
            : [assistantCommandAction('Load this sprint', 'load-report', actionTarget)],
        });
        return;
      }

      if (intent.type === 'CARRY_OVER') {
        const targetSettings = await getAssistantSettings(targetProject, targetBoard);
        const outlook = await invoke('getNextSprintOutlook', {
          boardId: Number(targetBoard.id),
          currentSprintId: Number(targetSprint.id),
          includeSubtasks,
          estimationOverride: String(targetSettings?.estimationOverride ?? ''),
        });
        const answer = buildCarryOverAnswer(outlook);
        updateAssistantContext(targetProject, targetBoard, targetSprint, { lastIntent: 'CARRY_OVER', lastIssueKeys: answer.issueKeys ?? [] });
        appendAssistantMessage({
          role: 'assistant',
          text: `${targetProject.name} (${targetProject.key})
${targetBoard.name} · ${targetSprint.name}

${answer.text}`,
          actions: assistantFollowUps('CARRY_OVER', { futureCount: outlook?.available ? 1 : 0, currentSprintName: targetSprint.name }),
        });
        return;
      }

      if (intent.type === 'COMPARE') {
        let firstProject = targetProject;
        let firstBoard = targetBoard;
        let firstSprint = targetSprint;
        let secondProject = targetProject;
        let secondBoard = targetBoard;
        let secondSprint = null;

        // If the user explicitly names a different project while a previous
        // project is in context, compare those two project/sprint contexts.
        if (projectResolution.explicit && assistantContext.projectKey && assistantContext.projectKey !== targetProject.key) {
          const contextEntry = assistantProjectCatalogue.find((entry) => entry.project.key === assistantContext.projectKey);
          if (!contextEntry) throw new Error('I lost the previous project context. Please name both projects again.');
          firstProject = contextEntry.project;
          const contextBoards = await getAssistantBoards(firstProject);
          firstBoard = contextBoards.find((candidate) => String(candidate.id) === String(assistantContext.boardId)) || contextBoards.find((candidate) => candidate.type === 'scrum') || contextBoards[0];
          const contextSprints = await getAssistantSprints(firstBoard, analysisPlan.maxSprintMetadata);
          firstSprint = findAssistantSprint(contextSprints, 'context', assistantContext.sprintId) || contextSprints.find((item) => item.state === 'active') || contextSprints.find((item) => item.isLastSprint) || contextSprints[0];
          secondProject = targetProject;
          secondBoard = targetBoard;
          secondSprint = targetSprint;
        } else if (refs.length >= 2) {
          firstSprint = findAssistantSprint(targetSprints, refs[0], currentContextSprintId);
          secondSprint = findAssistantSprint(targetSprints, refs[1], firstSprint?.id ?? currentContextSprintId);
        } else {
          firstSprint = targetSprint;
          secondSprint = findAssistantSprint(targetSprints, 'previous', firstSprint?.id ?? currentContextSprintId);
        }

        if (!firstSprint || !secondSprint) throw new Error('I could not resolve both sides of that comparison. Please name the projects/sprints more explicitly.');
        const [firstSettings, secondSettings] = await Promise.all([
          getAssistantSettings(firstProject, firstBoard), getAssistantSettings(secondProject, secondBoard),
        ]);
        const [a, b] = await Promise.all([
          fetchAssistantSnapshot(firstProject, firstBoard, firstSprint, firstSettings),
          fetchAssistantSnapshot(secondProject, secondBoard, secondSprint, secondSettings),
        ]);
        const text = `Sprint comparison\n• ${firstProject.key} · ${a.sprint.name}: ${a.metrics.storyPointCompletionPercentage}% complete · ${formatNumber(a.metrics.completedStoryPoints)}/${formatNumber(a.metrics.committedStoryPoints)} delivered · ${a.metrics.open} open · ${a.metrics.overdue} overdue\n• ${secondProject.key} · ${b.sprint.name}: ${b.metrics.storyPointCompletionPercentage}% complete · ${formatNumber(b.metrics.completedStoryPoints)}/${formatNumber(b.metrics.committedStoryPoints)} delivered · ${b.metrics.open} open · ${b.metrics.overdue} overdue\n• Completion difference: ${formatNumber(Number(a.metrics.storyPointCompletionPercentage) - Number(b.metrics.storyPointCompletionPercentage))} percentage points`;
        updateAssistantContext(firstProject, firstBoard, firstSprint, { lastIntent: 'COMPARE', lastComparedEntity: { projectKey: secondProject.key, sprintId: String(secondSprint.id) } });
        appendAssistantMessage({ role: 'assistant', text, actions: ['What are the risks?', 'Show scope changes', 'Show remaining work'] });
        return;
      }

      const targetSettings = await getAssistantSettings(targetProject, targetBoard);
      let snapshot;
      if (targetProject.key === projectKey && String(targetBoard.id) === String(boardId) && report && String(report.sprint.id) === String(targetSprint.id)) snapshot = report;
      else snapshot = await fetchAssistantSnapshot(targetProject, targetBoard, targetSprint, targetSettings);

      const assistantReadiness = deriveAssistantReadiness(snapshot, targetSettings);
      const assistantReturnToGreen = buildReturnToGreen({ report: snapshot, displayedIssues: snapshot?.metrics?.reportingIssues ?? [], readiness: assistantReadiness, settings: targetSettings });
      let assistantVelocity = null;
      if (analysisPlan.fetchVelocity) {
        assistantVelocity = targetProject.key === projectKey && String(targetBoard.id) === String(boardId) && velocityReport
          ? velocityReport
          : await invoke('getVelocityReport', { boardId: Number(targetBoard.id), includeSubtasks, estimationOverride: String(targetSettings?.estimationOverride ?? '') });
      }
      const rag = getOverallRag({ report: snapshot, readiness: assistantReadiness, settings: targetSettings });
      const referencedIssueKeys = references.referencesIssueSet ? new Set((assistantContext.lastIssueKeys ?? []).map(String)) : null;
      const answerReport = referencedIssueKeys?.size
        ? { ...snapshot, metrics: { ...snapshot.metrics, reportingIssues: (snapshot?.metrics?.reportingIssues ?? []).filter((issue) => referencedIssueKeys.has(String(issue.key))) } }
        : snapshot;
      const answer = buildAssistantAnswer(intent.type, {
        report: answerReport, velocityReport: assistantVelocity, readiness: assistantReadiness,
        returnToGreen: assistantReturnToGreen, boardConfiguration: { estimation: snapshot.estimationSource }, rag, mode: assistantMode,
      });
      const responseText = `${targetProject.name} (${targetProject.key})\n${targetBoard.name} · ${snapshot.sprint.name}\n\nOverall RAG: ${rag.label}\n\n${answer.text}`;
      updateAssistantContext(targetProject, targetBoard, targetSprint, { lastIntent: intent.type, lastIssueKeys: answer.issueKeys ?? [] });
      const availableFutureSprints = getAssistantFutureSprints(targetSprints, String(targetSprint.id), 5);
      appendAssistantMessage({ role: 'assistant', text: responseText, visual: answer.visual ?? null, actions: assistantFollowUps(intent.type, { futureSprints: availableFutureSprints, futureCount: availableFutureSprints.length, currentSprintName: targetSprint.name }) });
    } catch (caughtError) {
      appendAssistantMessage({ role: 'assistant', text: String(caughtError?.message ?? caughtError ?? 'I could not answer that from Jira.') });
    } finally {
      setAssistantBusy(false);
    }
  }

  function handleIncludeSubtasksChange(event) {
    setIncludeSubtasks(event.target.checked);
    setReport(null);
    setVelocityReport(null);
    setNextSprintOutlook(null);
    setError('');
    setSupplementaryWarning('');
  }

  async function refreshCustomInsightsOnly(settings) {
    const target = reportType === 'project' ? 'project' : 'sprint';
    const definitions = (settings?.kpiProfile?.custom ?? []).filter(
      (item) => item.enabled !== false && ['both', target].includes(item.target ?? 'both')
    );
    if (!definitions.length) {
      setCustomKpiResults([]);
      return [];
    }
    const rows = await evaluateCustomJiraInsightsDirect(
      definitions,
      null,
      customInsightCacheRef.current,
      {
        boardId: boardId && boardId !== 'all' ? boardId : '',
        sprintId: target === 'sprint' ? sprintId : '',
        sprints,
        sprint: target === 'sprint' ? (sprints.find((item) => String(item.id) === String(sprintId)) ?? null) : (sprints.find((item) => item.state === 'active') ?? null),
      }
    );
    setCustomKpiResults(rows);
    return rows;
  }

  async function evaluateConfiguredInsightsForReport(target, settings, range = { start: 68, end: 94 }) {
    const definitions = (settings?.kpiProfile?.custom ?? []).filter(
      (item) => item.enabled !== false && ['both', target].includes(item.target ?? 'both')
    );
    if (!definitions.length) {
      return [];
    }
    setLoadingProgress({ percent: range.start, label: `Preparing ${definitions.length} Custom Jira Insight${definitions.length === 1 ? '' : 's'}…` });
    const rows = await evaluateCustomJiraInsightsDirect(
      definitions,
      (_ids, progress) => {
        const ratio = progress.total > 0 ? Math.min(1, progress.loaded / progress.total) : Math.min(1, (progress.percent || 0) / 100);
        const percent = Math.min(range.end - 1, Math.round(range.start + ratio * (range.end - range.start)));
        setLoadingProgress({ percent, label: progress.unit === 'date-counts'
          ? `Calculating Created vs. Resolved chart · ${formatNumber(progress.loaded)} of ${formatNumber(progress.total)} date counts…`
          : (progress.total ? `Analysing Custom Jira Insights · ${formatNumber(progress.loaded)} of ≈${formatNumber(progress.total)} Jira items…` : 'Analysing Custom Jira Insights…') });
      },
      customInsightCacheRef.current,
      {
        boardId: boardId && boardId !== 'all' ? boardId : '',
        sprintId: target === 'sprint' ? sprintId : '',
        sprints,
        sprint: target === 'sprint' ? (sprints.find((item) => String(item.id) === String(sprintId)) ?? null) : (sprints.find((item) => item.state === 'active') ?? null),
      }
    );
    return rows;
  }

  async function loadProjectLevelReport(settingsOverride = null, options = {}) {
    const effectiveSettings = settingsOverride?.rag ? settingsOverride : reportingSettings;
    const targetBoards = boardId && boardId !== 'all' ? boards.filter((board) => String(board.id) === String(boardId)) : boards.filter((board) => board.type === 'scrum');
    if (targetBoards.length === 0) { const message = 'No Scrum boards are available for this project.'; setError(message); if (options?.throwOnError) throw new Error(message); return false; }
    try {
      setLoadingReport(true); setLoadingProgress({ percent: 5, label: 'Preparing Project / Program analysis…' }); setError(''); setSupplementaryWarning('');
      const portfolioContextPromise = invoke('getProjectPortfolioContext', { projectKey }).catch((caughtError) => ({ versions: [], epics: [], warnings: [String(caughtError?.message ?? caughtError ?? 'Project portfolio context unavailable.')] }));
      setLoadingProgress({ percent: 12, label: `Loading ${targetBoards.length} Scrum board${targetBoards.length === 1 ? '' : 's'} in parallel…` });
      let completedBoards = 0;
      const boardOutcomes = await Promise.allSettled(targetBoards.map(async (board) => {
        const boardSprints = await invoke('getSprints', { boardId: Number(board.id) });
        const chosen = boardSprints.find((sprint) => sprint.state === 'active') ?? boardSprints.find((sprint) => sprint.isLastSprint) ?? boardSprints.find((sprint) => sprint.state === 'closed') ?? boardSprints.find((sprint) => sprint.state === 'future') ?? boardSprints[0];
        if (!chosen) return { board, available: false };
        const [sprintOutcome, velocityOutcome] = await Promise.allSettled([
          invoke('getSprintReport', { sprintId: Number(chosen.id), boardId: Number(board.id), includeSubtasks, estimationOverride: effectiveSettings.estimationOverride || '', acceptanceCriteriaFieldId: effectiveSettings.readiness?.acceptanceCriteriaFieldId || '' }),
          invoke('getVelocityReport', { boardId: Number(board.id), includeSubtasks, estimationOverride: effectiveSettings.estimationOverride || '' }),
        ]);
        completedBoards += 1;
        setLoadingProgress({ percent: Math.min(60, 15 + Math.round((completedBoards / targetBoards.length) * 45)), label: `Analysed ${completedBoards} of ${targetBoards.length} boards…` });
        if (sprintOutcome.status !== 'fulfilled') return { board, sprint: chosen, available: false, warning: String(sprintOutcome.reason?.message ?? sprintOutcome.reason ?? 'Board report unavailable.') };
        return { board, sprint: chosen, report: sprintOutcome.value?.report ?? sprintOutcome.value, velocity: velocityOutcome.status === 'fulfilled' ? velocityOutcome.value : null, velocityWarning: velocityOutcome.status === 'rejected' ? 'Historical velocity could not be refreshed for this board.' : '', available: true };
      }));
      const boardSummaries = boardOutcomes.map((outcome, index) => outcome.status === 'fulfilled' ? outcome.value : ({ board: targetBoards[index], available: false, warning: String(outcome.reason?.message ?? outcome.reason ?? 'Board report unavailable.') }));
      const available = boardSummaries.filter((item) => item.available && item.report);
      setLoadingProgress({ percent: 62, label: 'Reconciling project totals and management signals…' });
      const totals = available.reduce((acc, item) => { const metrics = item.report.metrics ?? {}; acc.total += Number(metrics.total ?? 0); acc.completed += Number(metrics.completed ?? 0); acc.open += Number(metrics.open ?? 0); acc.defects += Number(metrics.defects ?? 0); acc.overdue += Number(metrics.overdue ?? 0); acc.storyPoints += Number(metrics.committedStoryPoints ?? 0); acc.completedStoryPoints += Number(metrics.completedStoryPoints ?? 0); return acc; }, { total: 0, completed: 0, open: 0, defects: 0, overdue: 0, storyPoints: 0, completedStoryPoints: 0 });
      totals.completionPercentage = totals.storyPoints > 0 ? Math.round((totals.completedStoryPoints / totals.storyPoints) * 100) : totals.total > 0 ? Math.round((totals.completed / totals.total) * 100) : 0;
      const portfolioContext = await portfolioContextPromise;
      const nextProjectReport = { projectKey, projectName: projects.find((project) => project.key === projectKey)?.name ?? projectKey, generatedAt: new Date().toISOString(), boards: boardSummaries, totals, portfolioContext };

      // Custom Jira Insights can be configured while viewing an individual sprint/board.
      // Definitions marked "Sprint + Project" or "Project Only" must therefore flow into
      // the Project / Program report instead of disappearing when Board switches to "All Scrum boards".
      // Native/RAG settings remain project-view scoped; only the shareable custom-insight catalogue is inherited.
      const boardSettingsOutcomes = await Promise.allSettled(targetBoards.map((board) => invoke('getReportingSettings', {
        projectKey,
        boardId: String(board.id),
      })));
      const projectInsightMap = new Map();
      const collectProjectInsights = (candidateSettings) => {
        (candidateSettings?.kpiProfile?.custom ?? [])
          .filter((item) => item.enabled !== false && ['both', 'project'].includes(item.target ?? 'both'))
          .forEach((item) => projectInsightMap.set(String(item.id || `${item.sourceType || 'insight'}:${item.filterId || item.jql || item.name}`), item));
      };
      collectProjectInsights(effectiveSettings);
      boardSettingsOutcomes.forEach((outcome) => {
        if (outcome.status === 'fulfilled') collectProjectInsights(mergeReportingSettings(outcome.value));
      });
      const effectiveProjectSettings = mergeReportingSettings({
        ...effectiveSettings,
        kpiProfile: {
          ...(effectiveSettings.kpiProfile ?? {}),
          custom: [...projectInsightMap.values()].slice(0, 12),
        },
      });
      const nextCustomKpiResults = await evaluateConfiguredInsightsForReport('project', effectiveProjectSettings, { start: 68, end: 94 });
      setLoadingProgress({ percent: 96, label: 'Finalising Project / Program report…' });
      setCustomKpiResults(nextCustomKpiResults);
      setReportingSettings(effectiveProjectSettings);
      setProjectReport(nextProjectReport);
      setLoadingProgress({ percent: 100, label: 'Project / Program report ready' });
    } catch (caughtError) {
      console.error(caughtError); if (markLicenseInactive(caughtError)) { if (options?.throwOnError) throw caughtError; return false; }
      const message = String(caughtError?.message ?? caughtError ?? 'Unable to build the project-level report.'); setError(message); if (options?.throwOnError) throw caughtError instanceof Error ? caughtError : new Error(message); return false;
    } finally { setTimeout(() => setLoadingProgress({ percent: 0, label: '' }), 400); setLoadingReport(false); }
    return true;
  }


  async function loadReport(settingsOverride = null, options = {}) {
    const effectiveSettings = settingsOverride?.rag ? settingsOverride : reportingSettings;

    if (reportType === 'project') {
      return loadProjectLevelReport(effectiveSettings, options);
    }

    if (!sprintId) {
      setError(
        'Select a sprint before loading the report.'
      );
      return;
    }

    if (!boardId) {
      setError(
        'Select a board before loading the report.'
      );
      return;
    }

    try {
      setLoadingReport(true);
      setLoadingProgress({ percent: 8, label: 'Loading sprint delivery data…' });
      setError('');
      setSupplementaryWarning('');

      const [sprintOutcome, velocityOutcome, outlookOutcome] =
        await Promise.allSettled([
          invoke('getSprintReport', {
            sprintId: Number(sprintId),
            boardId: Number(boardId),
            includeSubtasks,
            estimationOverride: effectiveSettings.estimationOverride || '',
            acceptanceCriteriaFieldId: effectiveSettings.readiness?.acceptanceCriteriaFieldId || '',
          }),

          invoke('getVelocityReport', {
            boardId: Number(boardId),
            includeSubtasks,
            estimationOverride: effectiveSettings.estimationOverride || '',
            acceptanceCriteriaFieldId: effectiveSettings.readiness?.acceptanceCriteriaFieldId || '',
          }),

          invoke('getNextSprintOutlook', {
            boardId: Number(boardId),
            currentSprintId: Number(sprintId),
            includeSubtasks,
            estimationOverride: effectiveSettings.estimationOverride || '',
            acceptanceCriteriaFieldId: effectiveSettings.readiness?.acceptanceCriteriaFieldId || '',
          }),
        ]);

      if (sprintOutcome.status !== 'fulfilled') {
        throw sprintOutcome.reason;
      }

      setLoadingProgress({ percent: 58, label: 'Calculating delivery, estimates and Acceptance Criteria…' });
      const sprintResponse = sprintOutcome.value;
      const sprintResult =
        sprintResponse?.report ?? sprintResponse;

      const nextReportMeta = sprintResponse?.meta ?? null;
      const nextVelocityReport = velocityOutcome.status === 'fulfilled' ? velocityOutcome.value : null;
      const nextSprintOutlook = outlookOutcome.status === 'fulfilled' ? outlookOutcome.value : null;

      const supplementaryWarnings = [];
      if (velocityOutcome.status === 'rejected') {
        console.warn('Historical velocity unavailable', velocityOutcome.reason);
        supplementaryWarnings.push(
          'Historical velocity could not be refreshed. Current sprint reporting is unaffected.'
        );
      }
      if (outlookOutcome.status === 'rejected') {
        console.warn('Next sprint outlook unavailable', outlookOutcome.reason);
        supplementaryWarnings.push(
          'Next Sprint Outlook could not be refreshed. Current sprint reporting is unaffected.'
        );
      }
      setSupplementaryWarning(supplementaryWarnings.join(' '));
      setPresentationFilters(FILTER_DEFAULTS);
      const nextCustomKpiResults = await evaluateConfiguredInsightsForReport('sprint', effectiveSettings, { start: 66, end: 92 });
      setLoadingProgress({ percent: 94, label: 'Finalising report and Jira context…' });

      try {
        const currentUsage = await invoke('getUsageStatus');
        setUsageStatus(currentUsage);
      } catch (usageError) {
        console.warn('Unable to refresh usage status', usageError);
      }

      /*
       * Refresh the sprint list after loading the report. This keeps
       * labels accurate when a sprint has just been started or closed
       * in Jira while StatusDeck is already open.
       */
      const refreshedSprints = await invoke('getSprints', {
        boardId: Number(boardId),
      });

      setSprints(refreshedSprints);
      setCustomKpiResults(nextCustomKpiResults);
      setReportMeta(nextReportMeta);
      setVelocityReport(nextVelocityReport);
      setNextSprintOutlook(nextSprintOutlook);
      // Commit the report last so Custom Jira Insights never appear to calculate after the report is already visible.
      setReport(sprintResult);

      const selectedSprintStillExists =
        refreshedSprints.some(
          (sprint) =>
            String(sprint.id) === String(sprintId)
        );

      if (!selectedSprintStillExists) {
        const fallbackSprint =
          refreshedSprints.find(
            (sprint) => sprint.state === 'active'
          ) ??
          refreshedSprints.find(
            (sprint) => sprint.state === 'future'
          ) ??
          refreshedSprints.find(
            (sprint) => sprint.isLastSprint
          ) ??
          refreshedSprints[0];

        setSprintId(
          fallbackSprint
            ? String(fallbackSprint.id)
            : ''
        );
      }
    } catch (caughtError) {
      console.error(caughtError);
      const message = String(caughtError?.message ?? caughtError ?? 'Unable to load the sprint report.');
      setError(message);
      if (options?.throwOnError) {
        throw caughtError instanceof Error ? caughtError : new Error(message);
      }
      return false;
    } finally {
      setLoadingProgress({ percent: 100, label: 'Report ready' });
      setTimeout(() => setLoadingProgress({ percent: 0, label: '' }), 400);
      setLoadingReport(false);
    }

    return true;
  }

  const selectedProject = useMemo(
    () =>
      projects.find(
        (project) => project.key === projectKey
      ),
    [projects, projectKey]
  );

  const baseDisplayedIssues = useMemo(() => {
    if (!report) {
      return [];
    }

    return report.metrics.includedSubtasks
      ? report.metrics.issues
      : report.metrics.issues.filter(
          (issue) => !issue.isSubtask
        );
  }, [report]);

  const displayedIssues = useMemo(
    () =>
      baseDisplayedIssues.filter((issue) => {
        if (
          presentationFilters.assignee !== 'all' &&
          issue.assignee !== presentationFilters.assignee
        ) {
          return false;
        }

        if (
          presentationFilters.status !== 'all' &&
          issue.status !== presentationFilters.status
        ) {
          return false;
        }

        if (
          presentationFilters.priority !== 'all' &&
          issue.priority !== presentationFilters.priority
        ) {
          return false;
        }

        if (
          presentationFilters.issueType !== 'all' &&
          issue.issueType !== presentationFilters.issueType
        ) {
          return false;
        }

        if (
          presentationFilters.onlyOverdue &&
          Number(issue.daysOverdue ?? 0) <= 0
        ) {
          return false;
        }

        if (
          presentationFilters.onlyDefects &&
          !isDefectIssue(issue)
        ) {
          return false;
        }

        if (
          presentationFilters.onlyUnassigned &&
          issue.assignee !== 'Unassigned'
        ) {
          return false;
        }

        return true;
      }),
    [baseDisplayedIssues, presentationFilters]
  );

  const filterOptions = useMemo(
    () => ({
      assignees: [...new Set(baseDisplayedIssues.map((issue) => issue.assignee))]
        .filter(Boolean)
        .sort(),
      statuses: [...new Set(baseDisplayedIssues.map((issue) => issue.status))]
        .filter(Boolean)
        .sort(),
      priorities: [...new Set(baseDisplayedIssues.map((issue) => issue.priority))]
        .filter(Boolean)
        .sort(),
      issueTypes: [...new Set(baseDisplayedIssues.map((issue) => issue.issueType))]
        .filter(Boolean)
        .sort(),
    }),
    [baseDisplayedIssues]
  );

  const activeFilterCount = useMemo(
    () =>
      Object.entries(presentationFilters).filter(([key, value]) =>
        typeof value === 'boolean'
          ? value
          : value !== FILTER_DEFAULTS[key]
      ).length,
    [presentationFilters]
  );

  const issueGroups = useMemo(() => {
    if (!report) {
      return {
        all: [],
        completed: [],
        open: [],
        defects: [],
        openDefects: [],
        overdue: [],
        acceptanceCriteriaMissing: [],
      };
    }

    return {
      all: displayedIssues.map((issue) => issue.key),

      completed: displayedIssues
        .filter(
          (issue) =>
            issue.statusCategoryKey === 'done'
        )
        .map((issue) => issue.key),

      open: displayedIssues
        .filter(
          (issue) =>
            issue.statusCategoryKey !== 'done'
        )
        .map((issue) => issue.key),

      defects: displayedIssues
        .filter((issue) => {
          const type = String(
            issue.issueType ?? ''
          ).toLowerCase();

          return (
            type === 'bug' ||
            type === 'defect' ||
            type.includes('defect')
          );
        })
        .map((issue) => issue.key),

      openDefects: displayedIssues
        .filter((issue) => issue.statusCategoryKey !== 'done' && isDefectIssue(issue))
        .map((issue) => issue.key),

      overdue: displayedIssues
        .filter((issue) => issue.daysOverdue > 0)
        .map((issue) => issue.key),

      acceptanceCriteriaMissing: report.sprint?.state === 'future'
        ? [...(report.metrics?.acceptanceCriteria?.missingKeys ?? [])]
        : [],
    };
  }, [report, displayedIssues]);

  const history = report?.history ?? null;

  const historyAddedKeys =
    history?.scopeChange?.addedIssueKeys ?? [];

  const historyRemovedKeys =
    history?.scopeChange?.removedIssueKeys ?? [];

  const effort = useMemo(() => {
    const raw = report?.metrics?.effort ?? null;
    if (!raw) return null;

    const coverage = Number(raw.coverage?.remainingEstimateCoveragePercentage ?? 0);
    const minimumCoverage = Number(
      reportingSettings.rag?.minimumRemainingEstimateCoverage ?? 80
    );
    const inferredRemainingHours = Math.max(
      0,
      Number(raw.originalEstimateHours ?? 0) - Number(raw.timeSpentHours ?? 0)
    );

    return {
      ...raw,
      forecastProvisional: coverage < minimumCoverage,
      inferredRemainingHours,
      provisionalGapHours: Math.max(
        0,
        inferredRemainingHours - Number(raw.remainingEstimateHours ?? 0)
      ),
    };
  }, [report, reportingSettings]);

  const sprintTiming = useMemo(() => {
    if (!report?.sprint) {
      return {
        daysElapsed: 0,
        daysRemaining: 0,
        timeUsedPercentage: 0,
        isClosed: false,
      };
    }

    const start = new Date(report.sprint.startDate).getTime();
    const plannedEnd = new Date(report.sprint.endDate).getTime();
    const completion = new Date(
      report.sprint.completeDate ?? report.sprint.endDate
    ).getTime();

    const isClosed = report.sprint.state === 'closed';
    const now = isClosed ? completion : Date.now();

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(plannedEnd) ||
      plannedEnd <= start
    ) {
      return {
        daysElapsed: 0,
        daysRemaining: 0,
        timeUsedPercentage: 0,
        isClosed,
      };
    }

    const totalDuration = plannedEnd - start;
    const elapsedDuration = Math.max(
      0,
      Math.min(totalDuration, now - start)
    );

    return {
      daysElapsed: Math.max(
        0,
        Math.ceil(elapsedDuration / (24 * 60 * 60 * 1000))
      ),
      daysRemaining: isClosed
        ? 0
        : Math.max(
            0,
            Math.ceil(
              (plannedEnd - Date.now()) /
                (24 * 60 * 60 * 1000)
            )
          ),
      timeUsedPercentage: Math.round(
        (elapsedDuration / totalDuration) * 100
      ),
      isClosed,
    };
  }, [report]);

  const priorityCounts = useMemo(
    () =>
      displayedIssues.reduce((result, issue) => {
        const priority = issue.priority || 'None';
        result[priority] = (result[priority] ?? 0) + 1;
        return result;
      }, {}),
    [displayedIssues]
  );

  const planningAssessment = useMemo(() => {
    if (!report) {
      return {
        score: 0,
        label: 'Not Calculated',
        tone: 'neutral',
        averageVelocity: 0,
        velocityLoadPercentage: 0,
        velocityLoadLabel: '—',
        unassignedItems: 0,
        unestimatedItems: 0,
        hasSprintGoal: false,
        assignedCoveragePercentage: 0,
        estimatedCoveragePercentage: 0,
        acceptanceCriteria: {
          enabled: false, eligibleStories: 0, detectedStories: 0, missingStories: 0,
          noDescriptionStories: 0, emptyCriteriaStories: 0, notDetectedStories: 0, coveragePercentage: null,
          totalCriteria: 0, metCriteria: 0, notMetCriteria: 0, trackableCriteria: 0, unrecordedCriteria: 0, completionPercentage: null,
          detectedKeys: [], missingKeys: [], noDescriptionKeys: [], emptyCriteriaKeys: [], notDetectedKeys: [], metKeys: [], notMetKeys: [], unrecordedKeys: [], issueBreakdown: [],
        },
      };
    }

    const averageVelocity = Number(
      velocityReport?.averageCompleted ?? 0
    );

    const plannedPoints = Number(
      report.metrics.committedStoryPoints ?? 0
    );

    const velocityLoadPercentage =
      averageVelocity > 0
        ? Math.round((plannedPoints / averageVelocity) * 100)
        : 0;

    const unassignedItems = displayedIssues.filter(
      (issue) => issue.assignee === 'Unassigned'
    ).length;

    const unestimatedItems = displayedIssues.filter(
      (issue) => Number(issue.storyPoints ?? 0) <= 0
    ).length;

    const hasSprintGoal = Boolean(
      String(report.sprint.goal ?? '').trim()
    );

    const totalItems = Math.max(0, Number(report.metrics.total ?? displayedIssues.length ?? 0));
    const assignedCoveragePercentage = totalItems > 0
      ? Math.round(((totalItems - unassignedItems) / totalItems) * 100)
      : 0;
    const estimatedCoveragePercentage = totalItems > 0
      ? Math.round(((totalItems - unestimatedItems) / totalItems) * 100)
      : 0;

    const acceptanceCriteria = report.metrics.acceptanceCriteria ?? {
      enabled: false, eligibleStories: 0, detectedStories: 0, missingStories: 0,
      noDescriptionStories: 0, emptyCriteriaStories: 0, notDetectedStories: 0, coveragePercentage: null,
      totalCriteria: 0, metCriteria: 0, notMetCriteria: 0, trackableCriteria: 0, unrecordedCriteria: 0, completionPercentage: null,
      detectedKeys: [], missingKeys: [], noDescriptionKeys: [], emptyCriteriaKeys: [], notDetectedKeys: [], metKeys: [], notMetKeys: [], unrecordedKeys: [], issueBreakdown: [],
    };
    const minimumAcceptanceCriteriaCoverage = Number(
      reportingSettings.readiness?.minimumAcceptanceCriteriaCoverage ?? 80
    );
    const acceptanceCriteriaCoverage = acceptanceCriteria.eligibleStories > 0
      ? Number(acceptanceCriteria.coveragePercentage ?? 0)
      : null;

    const originalCoverage = Number(
      effort?.coverage?.originalEstimateCoveragePercentage ?? 0
    );

    const maximumVelocityLoad = Number(
      reportingSettings.readiness?.maximumVelocityLoad ?? 115
    );

    let score = 100;

    score -= Math.min(25, unassignedItems * 8);
    score -= Math.min(25, unestimatedItems * 8);
    score -= hasSprintGoal ? 0 : 15;
    score -= Math.min(20, Number(report.metrics.overdue ?? 0) * 7);

    if (originalCoverage < 80) {
      score -= Math.min(15, Math.round((80 - originalCoverage) / 4));
    }

    if (velocityLoadPercentage > maximumVelocityLoad) {
      score -= Math.min(
        25,
        Math.round((velocityLoadPercentage - maximumVelocityLoad) / 3)
      );
    } else if (
      velocityLoadPercentage > 0 &&
      velocityLoadPercentage < 50
    ) {
      score -= 8;
    }

    if (
      acceptanceCriteriaCoverage !== null &&
      acceptanceCriteriaCoverage < minimumAcceptanceCriteriaCoverage
    ) {
      score -= Math.min(
        20,
        Math.max(5, Math.round((minimumAcceptanceCriteriaCoverage - acceptanceCriteriaCoverage) / 4))
      );
    }

    score = Math.max(0, Math.min(100, Math.round(score)));

    let label = 'Ready to start';
    let tone = 'positive';

    if (unestimatedItems > 0) {
      label = 'Needs estimates';
      tone = 'warning';
    }

    if (unassignedItems > 0) {
      label = 'Needs assignment';
      tone = 'warning';
    }

    if (velocityLoadPercentage > maximumVelocityLoad) {
      label = 'Capacity concern';
      tone = 'negative';
    } else if (
      velocityLoadPercentage > 0 &&
      velocityLoadPercentage < 50
    ) {
      label = 'Under-planned';
      tone = 'warning';
    }

    if (
      acceptanceCriteriaCoverage !== null &&
      acceptanceCriteriaCoverage < minimumAcceptanceCriteriaCoverage &&
      tone !== 'negative'
    ) {
      label = 'Needs acceptance criteria';
      tone = 'warning';
    }

    if (
      !hasSprintGoal ||
      report.metrics.overdue > 0 ||
      originalCoverage < 80
    ) {
      label = tone === 'negative' ? label : label === 'Needs acceptance criteria' ? label : 'Planning Gaps';
      tone = tone === 'negative' ? tone : 'warning';
    }

    return {
      score,
      label,
      tone,
      averageVelocity,
      velocityLoadPercentage,
      velocityLoadLabel:
        averageVelocity > 0
          ? `${velocityLoadPercentage}%`
          : 'No baseline',
      unassignedItems,
      unestimatedItems,
      hasSprintGoal,
      assignedCoveragePercentage,
      estimatedCoveragePercentage,
      acceptanceCriteria,
      acceptanceCriteriaCoverage,
      minimumAcceptanceCriteriaCoverage,
      originalCoverage,
    };
  }, [report, velocityReport, displayedIssues, effort, reportingSettings]);

  const deliveryStatus = useMemo(() => {
    if (!report) {
      return {
        label: 'Not Calculated',
        tone: 'neutral',
      };
    }

    if (report.sprint.state === 'future') {
      return {
        label: planningAssessment.label,
        tone: planningAssessment.tone,
      };
    }

    const completion = Number(
      report.metrics.storyPointCompletionPercentage ?? 0
    );

    const timeUsed = Number(
      sprintTiming.timeUsedPercentage ?? 0
    );

    const rag = reportingSettings.rag ?? DEFAULT_REPORTING_SETTINGS.rag;
    const openDefects = displayedIssues.filter(
      (issue) => issue.statusCategoryKey !== 'done' && isDefectIssue(issue)
    ).length;

    if (report.sprint.state === 'closed') {
      if (
        completion >= rag.greenCompletion &&
        report.metrics.overdue < rag.amberOverdue &&
        openDefects < rag.amberOpenDefects
      ) {
        return { label: 'Delivered', tone: 'positive' };
      }

      if (
        completion >= rag.amberCompletion &&
        report.metrics.overdue < rag.redOverdue &&
        openDefects < rag.redOpenDefects
      ) {
        return { label: 'Delivered With Concerns', tone: 'warning' };
      }

      return { label: 'Below Commitment', tone: 'negative' };
    }

    if (
      report.metrics.overdue >= rag.redOverdue ||
      openDefects >= rag.redOpenDefects ||
      completion + 15 < timeUsed
    ) {
      return { label: 'At Risk', tone: 'negative' };
    }

    if (
      report.metrics.overdue >= rag.amberOverdue ||
      openDefects >= rag.amberOpenDefects ||
      completion + 5 < timeUsed
    ) {
      return { label: 'Watch Closely', tone: 'warning' };
    }

    return { label: 'On Track', tone: 'positive' };
  }, [report, sprintTiming, planningAssessment, reportingSettings, displayedIssues]);

  const completionTone = useMemo(() => {
    if (!report) return 'neutral';
    if (report.sprint.state === 'future') return planningAssessment.tone;

    const completion = Number(report.metrics.storyPointCompletionPercentage ?? 0);
    const green = Number(reportingSettings.rag?.greenCompletion ?? 85);
    const amber = Number(reportingSettings.rag?.amberCompletion ?? 65);

    if (completion >= green) return 'positive';
    if (completion >= amber) return 'warning';
    return 'negative';
  }, [report, planningAssessment, reportingSettings]);

  const readiness = useMemo(() => {
    if (!report) {
      return {
        score: 0,
        label: 'Not Calculated',
        metricLabel: 'delivery health',
      };
    }

    if (report.sprint.state === 'future') {
      return {
        score: planningAssessment.score,
        label: planningAssessment.label,
        metricLabel: 'planning',
      };
    }

    const completion = Number(
      report.metrics.storyPointCompletionPercentage ?? 0
    );

    /*
     * Delivery health penalises only unresolved defects.
     * Completed defects are historical delivery work, not current risk.
     */
    const openDefects = displayedIssues.filter((issue) => {
      const issueType = String(issue.issueType ?? '').toLowerCase();

      return (
        issue.statusCategoryKey !== 'done' &&
        (
          issueType === 'bug' ||
          issueType === 'defect' ||
          issueType.includes('defect')
        )
      );
    }).length;

    const overduePenalty = Math.min(
      15,
      Number(report.metrics.overdue ?? 0) * 5
    );

    const openDefectPenalty = Math.min(
      12,
      openDefects * 2
    );

    /*
     * Incomplete Remaining Estimate coverage is a confidence problem,
     * not proof of delivery failure, so cap this penalty at 8 points.
     */
    const estimateConfidencePenalty = effort?.forecastProvisional
      ? Math.min(
          8,
          Math.round(
            (100 -
              Number(
                effort.coverage
                  ?.remainingEstimateCoveragePercentage ?? 0
              )) / 12.5
          )
        )
      : 0;

    const score = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          completion -
            overduePenalty -
            openDefectPenalty -
            estimateConfidencePenalty
        )
      )
    );

    return {
      score,
      openDefects,
      label:
        score >= Number(reportingSettings.rag?.greenCompletion ?? 85)
          ? 'Strong Outcome'
          : score >= Number(reportingSettings.rag?.amberCompletion ?? 65)
            ? 'Delivered With Concerns'
            : score >= 50
              ? 'Needs Follow-Up'
              : 'Needs Attention',
      metricLabel:
        report.sprint.state === 'closed'
          ? 'delivery health'
          : 'readiness',
    };
  }, [
    report,
    effort,
    planningAssessment,
    displayedIssues,
    reportingSettings,
  ]);


  const overallRag = useMemo(
    () => getOverallRag({ report, readiness, settings: reportingSettings }),
    [report, readiness, reportingSettings]
  );

  const deliveryRiskTone = useMemo(() => {
    if (!report) return 'neutral';
    if (report.sprint.state === 'future') return planningAssessment.tone;

    const rag = reportingSettings.rag ?? DEFAULT_REPORTING_SETTINGS.rag;
    const overdue = Number(report.metrics.overdue ?? 0);
    const unresolvedDefects = Number(readiness?.openDefects ?? 0);

    if (overdue >= Number(rag.redOverdue) || unresolvedDefects >= Number(rag.redOpenDefects)) {
      return 'negative';
    }
    if (overdue >= Number(rag.amberOverdue) || unresolvedDefects >= Number(rag.amberOpenDefects)) {
      return 'warning';
    }
    return 'positive';
  }, [report, readiness, planningAssessment, reportingSettings]);


  const returnToGreen = useMemo(
    () => buildReturnToGreen({
      report,
      displayedIssues,
      readiness,
      settings: reportingSettings,
    }),
    [report, displayedIssues, readiness, reportingSettings]
  );

  const projectView = useMemo(
    () => (projectReport ? deriveProjectReportView(projectReport, reportingSettings) : null),
    [projectReport, reportingSettings]
  );

  const detectedEstimationLabel = useMemo(() => {
    const estimation = boardConfiguration?.estimation;
    if (!estimation) return 'Not detected';
    if (estimation.type === 'field') return estimation.fieldName || estimation.fieldId || 'Configured field';
    if (estimation.type === 'issueCount') return 'Issue Count';
    return 'No estimation statistic configured';
  }, [boardConfiguration]);

  const workloadWithIssueKeys = useMemo(
    () =>
      (report?.metrics?.workload ?? []).map((person) => ({
        ...person,
        issueKeys: displayedIssues
          .filter((issue) => issue.assignee === person.name)
          .map((issue) => issue.key),
      })),
    [report, displayedIssues]
  );

  const burndownPoints =
    burndownView === 'live'
      ? history?.burndownLive ?? []
      : history?.burndownDaily ??
        history?.burndown ??
        [];

  const compactLiveBurndownPoints = (() => {
    const live = Array.isArray(history?.burndownLive)
      ? [...history.burndownLive].filter((point) => point?.timestamp)
      : [];
    if (live.length < 2) {
      return history?.burndownDaily ?? history?.burndown ?? [];
    }

    live.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const latestDateKey = String(live[live.length - 1]?.date ?? '').slice(0, 10);
    const sameDay = latestDateKey
      ? live.filter((point) => String(point?.date ?? '').slice(0, 10) === latestDateKey)
      : [];

    const firstSameDayIndex = sameDay.length
      ? live.findIndex((point) => point === sameDay[0])
      : -1;
    const openingPoint = firstSameDayIndex > 0 ? live[firstSameDayIndex - 1] : null;
    const intraday = openingPoint ? [openingPoint, ...sameDay] : sameDay;

    return intraday.length >= 2 ? intraday : live;
  })();

  function getAssigneeIssues(
    assigneeName,
    condition = () => true
  ) {
    return displayedIssues
      .filter(
        (issue) =>
          issue.assignee === assigneeName &&
          condition(issue)
      )
      .map((issue) => issue.key);
  }


  async function registerExport(exportType) {
    const result = await invoke('registerExport', {
      exportType,
    });

    setUsageStatus(result.usage);
    return result;
  }

  async function handlePresent() {
    if (!report) {
      return;
    }
    setSectionMoveMenu(null);
    setOverviewMoveMenu(null);
    setProjectSectionMoveMenu(null);
    setSettingsOpen(false);
    setCustomKpiOpen(false);
    setSchedulerOpen(false);
    setFilterPanelOpen(false);
    setPresentationMode(true);
  }

  function handleExitPresentation() {
    setPresentationMode(false);
  }

  function openExportDialog(format = 'pptx') {
    if (!report && !projectReport) return;
    setExportFormat(format);
    setExportDestination('download');
    setConfluenceChildPageTitle(report ? getConfluenceSprintPageTitle(report.sprint?.name) : `${projectReport?.projectName || projectKey} Project Status`);
    setExportNotice(null);
    setExportModalOpen(true);
  }

  function confluenceTable(headers, rows, width = 760) {
    if (!rows?.length) return '<p>Not available.</p>';
    return `<table data-layout="default" data-table-width="${width}"><tbody><tr>${headers.map((header) => `<th>${escapeConfluenceStorage(header)}</th>`).join('')}</tr>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeConfluenceStorage(cell ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  function confluenceRichTable(headers, rows, width = 760) {
    if (!rows?.length) return '<p>Not available.</p>';
    return `<table data-layout="default" data-table-width="${width}"><tbody><tr>${headers.map((header) => `<th>${escapeConfluenceStorage(header)}</th>`).join('')}</tr>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell ?? ''}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  function buildConfluenceInsightImageFileName(index) {
    const safeProject = String(projectKey || 'Jira').replace(/[^a-z0-9-_]+/gi, '_').replace(/^_+|_+$/g, '');
    const reportName = report?.sprint?.name || projectReport?.projectName || 'Report';
    const safeReport = String(reportName).replace(/[^a-z0-9-_]+/gi, '_').replace(/^_+|_+$/g, '');
    return `${safeProject}_${safeReport}_StatusDeck_Custom_Insight_${Number(index) + 1}.png`;
  }

  function canvasToPngBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Unable to render Confluence chart image.')), 'image/png');
    });
  }

  function configureConfluenceChartCanvas(width = 1600, height = 720) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Browser canvas is unavailable for Confluence chart rendering.');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, width, height);
    ctx.textBaseline = 'middle';
    return { canvas, ctx, width, height };
  }

  async function renderConfluenceCreatedResolvedPng(insight) {
    const points = Array.isArray(insight?.timeSeries) ? insight.timeSeries : [];
    if (!points.length) return null;
    const { canvas, ctx, width, height } = configureConfluenceChartCanvas();
    const left = 105;
    const right = width - 55;
    const top = 90;
    const bottom = height - 95;
    const chartW = right - left;
    const chartH = bottom - top;
    const maxValue = Math.max(1, ...points.flatMap((point) => [Number(point.created || 0), Number(point.resolved || 0)]));
    const pointX = (index) => points.length <= 1 ? left : left + (index / (points.length - 1)) * chartW;
    const pointY = (value) => bottom - (Number(value || 0) / maxValue) * chartH;

    ctx.font = '600 26px Arial, sans-serif';
    ctx.fillStyle = '#172B4D';
    ctx.fillText('Created vs. Resolved', left, 38);
    ctx.font = '18px Arial, sans-serif';
    ctx.fillStyle = '#5E6C84';
    ctx.fillText(`Created ${formatNumber(getCreatedResolvedTotals(insight).created)}   Resolved ${formatNumber(getCreatedResolvedTotals(insight).resolved)}`, left, 68);

    ctx.font = '16px Arial, sans-serif';
    for (let i = 0; i <= 5; i += 1) {
      const ratio = i / 5;
      const y = bottom - ratio * chartH;
      ctx.strokeStyle = '#D9E2EC';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.fillStyle = '#6B778C';
      ctx.textAlign = 'right';
      ctx.fillText(formatNumber(Math.round(maxValue * ratio)), left - 14, y);
    }

    const drawLine = (field, colour) => {
      ctx.strokeStyle = colour;
      ctx.lineWidth = 5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      points.forEach((point, index) => {
        const x = pointX(index);
        const y = pointY(point[field]);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };
    drawLine('created', '#BF2600');
    drawLine('resolved', '#227D5A');

    ctx.textAlign = 'center';
    ctx.fillStyle = '#5E6C84';
    ctx.font = '16px Arial, sans-serif';
    getCreatedResolvedTickIndices(points, 7).forEach((index) => {
      const label = points[index]?.label || points[index]?.date || '';
      ctx.fillText(String(label), pointX(index), bottom + 30);
    });

    ctx.textAlign = 'left';
    ctx.fillStyle = '#BF2600';
    ctx.fillRect(right - 260, 34, 26, 5);
    ctx.fillStyle = '#172B4D';
    ctx.font = '16px Arial, sans-serif';
    ctx.fillText('Created', right - 224, 37);
    ctx.fillStyle = '#227D5A';
    ctx.fillRect(right - 140, 34, 26, 5);
    ctx.fillStyle = '#172B4D';
    ctx.fillText('Resolved', right - 104, 37);
    return canvasToPngBlob(canvas);
  }

  async function renderConfluencePiePng(insight) {
    const source = Array.isArray(insight?.series) ? insight.series.filter((item) => Number(item?.value || 0) > 0) : [];
    if (!source.length) return null;
    const { canvas, ctx, width, height } = configureConfluenceChartCanvas(1500, 720);
    const colours = ['#0C66E4', '#22A06B', '#E2B203', '#AE2E24', '#6E5DC6', '#2898BD', '#B65C02', '#5E6C84', '#7F5F01'];
    const visible = source.slice(0, 8).map((item) => ({ label: item.label || 'None', value: Number(item.value || 0) }));
    if (source.length > 8) visible.push({ label: 'Other', value: source.slice(8).reduce((sum, item) => sum + Number(item.value || 0), 0) });
    const total = visible.reduce((sum, item) => sum + item.value, 0) || 1;
    const cx = 390;
    const cy = 370;
    const radius = 220;
    const inner = 125;
    let angle = -Math.PI / 2;

    ctx.font = '600 26px Arial, sans-serif';
    ctx.fillStyle = '#172B4D';
    ctx.fillText(insight.name || 'Jira distribution', 80, 48);
    visible.forEach((item, index) => {
      const next = angle + (item.value / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, angle, next);
      ctx.closePath();
      ctx.fillStyle = colours[index % colours.length];
      ctx.fill();
      angle = next;
    });
    ctx.beginPath();
    ctx.arc(cx, cy, inner, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#172B4D';
    ctx.font = '700 36px Arial, sans-serif';
    ctx.fillText(formatNumber(insight.matchedIssues ?? total), cx, cy - 8);
    ctx.font = '17px Arial, sans-serif';
    ctx.fillStyle = '#5E6C84';
    ctx.fillText('issues', cx, cy + 30);

    ctx.textAlign = 'left';
    visible.forEach((item, index) => {
      const y = 155 + index * 58;
      ctx.fillStyle = colours[index % colours.length];
      ctx.fillRect(760, y - 11, 22, 22);
      ctx.fillStyle = '#172B4D';
      ctx.font = '18px Arial, sans-serif';
      ctx.fillText(String(item.label), 800, y);
      ctx.textAlign = 'right';
      ctx.font = '600 18px Arial, sans-serif';
      ctx.fillText(formatNumber(item.value), 1370, y);
      ctx.textAlign = 'left';
    });
    return canvasToPngBlob(canvas);
  }

  async function generateConfluenceInsightImages() {
    const images = [];
    const insights = Array.isArray(customKpiResults) ? customKpiResults : [];
    for (let index = 0; index < insights.length; index += 1) {
      const insight = insights[index];
      if (!insight || insight.error) continue;
      let blob = null;
      if (insight.viewType === 'createdResolved') blob = await renderConfluenceCreatedResolvedPng(insight);
      else if (insight.viewType === 'pie') blob = await renderConfluencePiePng(insight);
      if (!blob) continue;
      images.push({ index, fileName: buildConfluenceInsightImageFileName(index), blob });
    }
    return images;
  }

  function confluenceAttachmentImage(fileName, alt = 'StatusDeck chart', width = 900) {
    if (!fileName) return '';
    return `<p><ac:image ac:align="center" ac:border="false" ac:width="${Math.max(320, Math.min(1100, Number(width) || 900))}" ac:alt="${escapeConfluenceStorage(alt)}"><ri:attachment ri:filename="${escapeConfluenceStorage(fileName)}" /></ac:image></p>`;
  }

  function buildConfluenceCustomJiraInsightStorage(insight, index, insightImageFiles = {}) {
    if (!insight) return '';
    const title = insight.name || 'Custom Jira insight';
    if (insight.error) {
      return `<h3>${escapeConfluenceStorage(title)}</h3>${confluencePanelMacro({ title: 'Insight Unavailable', tone: 'danger', bodyHtml: `<p>${escapeConfluenceStorage(insight.error)}</p>` })}`;
    }
    if (insight.viewType === 'createdResolved' && Array.isArray(insight.timeSeries)) {
      const totals = getCreatedResolvedTotals(insight);
      const rows = insight.timeSeries.map((point) => [point.label || point.date || '', Number(point.created || 0), Number(point.resolved || 0)]);
      const image = confluenceAttachmentImage(insightImageFiles[index], `${title} Created vs. Resolved`, 950);
      return [
        `<h3>${escapeConfluenceStorage(title)}</h3>`,
        `<p><strong>${escapeConfluenceStorage(formatNumber(insight.matchedIssues ?? insight.value ?? 0))} in chart window</strong> · Created ${escapeConfluenceStorage(formatNumber(totals.created))} · Resolved ${escapeConfluenceStorage(formatNumber(totals.resolved))} · ${escapeConfluenceStorage(insight.period || 'day')} buckets · last ${escapeConfluenceStorage(formatNumber(insight.daysPreviously || 30))} days${Number.isFinite(Number(insight.sourceFilterCount)) ? ` · source filter ≈${escapeConfluenceStorage(formatNumber(insight.sourceFilterCount))}` : ''}</p>`,
        image || confluenceTable(['Date', 'Created', 'Resolved'], rows, 900),
      ].join('');
    }
    if (insight.viewType === 'pie' && Array.isArray(insight.series)) {
      const rows = insight.series.slice(0, 30).map((item) => [item.label || 'None', Number(item.value || 0)]);
      const image = confluenceAttachmentImage(insightImageFiles[index], `${title} pie chart`, 850);
      return [
        `<h3>${escapeConfluenceStorage(title)}</h3>`,
        `<p><strong>${escapeConfluenceStorage(formatNumber(insight.matchedIssues ?? insight.value ?? 0))} total</strong> · Grouped by ${escapeConfluenceStorage(formatJiraStatisticLabel(insight.statisticType))}</p>`,
        image || confluenceTable([formatJiraStatisticLabel(insight.statisticType), 'Issues'], rows, 760),
      ].join('');
    }
    if (insight.viewType === 'twoDimensional' && insight.table?.rows?.length) {
      const headers = [formatJiraStatisticLabel(insight.xStatistic), ...(insight.table.columns ?? []).map((column) => column.label), 'Total'];
      const rows = insight.table.rows.slice(0, 50).map((row) => [
        row.rowLabel,
        ...(row.values ?? []).map((value) => Number(value || 0)),
        (row.values ?? []).reduce((sum, value) => sum + Number(value || 0), 0),
      ]);
      return `<h3>${escapeConfluenceStorage(title)}</h3><p><strong>${escapeConfluenceStorage(formatNumber(insight.matchedIssues ?? insight.value ?? 0))} total</strong> · ${escapeConfluenceStorage(formatJiraStatisticLabel(insight.xStatistic))} × ${escapeConfluenceStorage(formatJiraStatisticLabel(insight.yStatistic))}</p>${confluenceTable(headers, rows, 900)}`;
    }
    const value = formatNumber(insight.value ?? insight.matchedIssues ?? 0);
    return `<h3>${escapeConfluenceStorage(title)}</h3>${confluencePanelMacro({ title: insight.viewType === 'daysRemaining' ? 'Days Remaining' : 'Jira Filter Result', tone: 'info', bodyHtml: `<p><strong>${escapeConfluenceStorage(value)}</strong></p><p>${escapeConfluenceStorage(getCustomInsightEvidence(insight))}</p>` })}`;
  }

  function buildConfluenceCustomJiraInsightsStorage(results, insightImageFiles = {}) {
    const insights = (results ?? []).filter(Boolean);
    if (!insights.length) return '';
    return `<h2>Custom Jira Insights</h2>${insights.map((insight, index) => buildConfluenceCustomJiraInsightStorage(insight, index, insightImageFiles)).join('')}`;
  }

  function buildConfluenceStorageReport({ pdfFileName, pptxFileName, publishedAt, insightImageFiles = {} }) {
    if (!report) return '';
    const estimationDisplay = getEstimationDisplay(report);
    const overall = getOverallRag({ report, readiness, settings: reportingSettings });
    const generatedAt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(publishedAt || Date.now()));
    const fallbackNarrative = getManagementNarrative({ report, readiness, deliveryStatus, settings: reportingSettings });
    const commentaryOutlook = buildNextSprintOutlookSummary(nextSprintOutlook, velocityReport);
    const generatedCommentary = [
      'Summary', ...(fallbackNarrative.summary ?? []).map((item) => `• ${item}`),
      'Key Risks', ...(fallbackNarrative.risks ?? []).map((item) => `• ${item}`),
      'Recommended Actions', ...(fallbackNarrative.actions ?? []).map((item) => `• ${item}`),
      commentaryOutlook ? 'Next Sprint Outlook' : '',
      commentaryOutlook ? `• Load: ${commentaryOutlook.sprintName} · ${formatNumber(commentaryOutlook.plannedPoints)} planned ${estimationDisplay.short} / ${formatNumber(commentaryOutlook.plannedItems)} items / ${formatNumber(commentaryOutlook.carryOverItems)} carry-over` : '',
      commentaryOutlook?.goal ? `• Goal: ${commentaryOutlook.goal}` : '',
      commentaryOutlook?.risks?.length ? 'Planning checks' : '',
      ...(commentaryOutlook?.risks ?? []).map((item) => `• ${/defect|acceptance criteria/i.test(item) ? 'Quality check' : 'Planning check'}: ${item}`),
    ].filter(Boolean).join('\n');
    const managementCommentary = String(commentaryStale ? generatedCommentary : (commentaryText || commentaryOverlay.published || commentaryOverlay.draft || generatedCommentary)).trim();
    const effortData = report.metrics.effort ?? {};
    const acceptanceCriteriaData = report.metrics.acceptanceCriteria ?? null;
    const traceabilityData = report.metrics.traceability ?? null;
    const acceptanceCriteriaSection = acceptanceCriteriaData?.eligibleStories > 0
      ? [
          '<h2>Acceptance Criteria</h2>',
          confluenceTable(['Stories With AC', 'Criteria Identified', 'Met', 'Not Met', 'Status Not Recorded', 'Tracked completion'], [[
            `${acceptanceCriteriaData.detectedStories}/${acceptanceCriteriaData.eligibleStories} (${formatNumber(acceptanceCriteriaData.coveragePercentage)}%)`,
            acceptanceCriteriaData.totalCriteria ?? 0,
            acceptanceCriteriaData.metCriteria ?? 0,
            acceptanceCriteriaData.notMetCriteria ?? 0,
            acceptanceCriteriaData.unrecordedCriteria ?? 0,
            Number(acceptanceCriteriaData.trackableCriteria ?? 0) > 0 ? `${formatNumber(acceptanceCriteriaData.completionPercentage)}% (${acceptanceCriteriaData.metCriteria}/${acceptanceCriteriaData.trackableCriteria})` : 'Not calculable',
          ]]),
          confluencePanelMacro({ title: 'Acceptance Criteria Interpretation', tone: 'info', bodyHtml: `<p>Met / Not met is reported only where Jira explicitly records a checkbox/task completion state. ${escapeConfluenceStorage(acceptanceCriteriaData.unrecordedCriteria ?? 0)} plain-text criterion/criteria have no explicit completion state and are therefore shown as <strong>Status Not Recorded</strong>. StatusDeck does not infer completion from prose or Story status.</p>` }),
        ].join('')
      : '';
    const traceabilitySection = traceabilityData?.eligibleStories > 0
      ? [
          '<h2>Traceability &amp; Quality Evidence</h2>',
          confluenceTable(['Parent / Requirement Linked', 'Acceptance Criteria', 'Linked Test Evidence', 'Release / Fix Version Mapped', 'Stories With Open Linked Defects'], [[
            `${formatNumber(traceabilityData.parentCoveragePercentage)}% (${traceabilityData.parentLinkedStories}/${traceabilityData.eligibleStories})`,
            `${formatNumber(acceptanceCriteriaData?.coveragePercentage ?? 0)}% (${acceptanceCriteriaData?.detectedStories ?? 0}/${acceptanceCriteriaData?.eligibleStories ?? 0})`,
            `${formatNumber(traceabilityData.testEvidenceCoveragePercentage)}% (${traceabilityData.testEvidenceStories}/${traceabilityData.eligibleStories})`,
            `${formatNumber(traceabilityData.releaseCoveragePercentage)}% (${traceabilityData.releaseMappedStories}/${traceabilityData.eligibleStories})`,
            traceabilityData.storiesWithOpenLinkedDefects ?? 0,
          ]]),
          confluencePanelMacro({ title: 'Traceability Gaps', tone: traceabilityData.criticalGapKeys?.length ? 'warning' : 'success', bodyHtml: `<p><strong>${escapeConfluenceStorage(traceabilityData.criticalGapKeys?.length ?? 0)} Story/Stories</strong> are missing a parent/requirement link or identifiable Acceptance Criteria.</p><p>Acceptance Criteria source: <strong>${escapeConfluenceStorage(report.acceptanceCriteriaSource?.name || 'Jira Description')}</strong>. ${escapeConfluenceStorage(traceabilityData.methodology || '')}</p>` }),
        ].join('')
      : '';
    const scope = history?.scopeChange ?? {};
    const currentScope = history?.currentScope ?? {};
    const originalCommitment = history?.originalCommitment ?? {};
    const statusRows = Object.entries(report.metrics.statusCounts ?? {}).sort((a, b) => b[1] - a[1]);
    const typeRows = Object.entries(report.metrics.typeCounts ?? {}).sort((a, b) => b[1] - a[1]);
    const priorityRows = Object.entries(priorityCounts ?? {}).sort((a, b) => b[1] - a[1]);
    const workloadRows = (report.metrics.workload ?? []).map((person) => [
      person.name, person.total, person.open, person.completed, formatNumber(person.storyPoints),
      formatNumber(person.remainingStoryPoints), formatHours(person.originalEstimateHours), formatHours(person.timeSpentHours),
      formatHours(person.remainingEstimateHours), formatHours(person.forecastHours), person.overdue,
    ]);
    const velocityRows = (velocityReport?.velocity ?? []).map((item) => [
      item.sprintName || item.name || 'Sprint',
      formatNumber(velocityReport?.usesStoryPoints ? item.committedStoryPoints : item.totalItems),
      formatNumber(velocityReport?.usesStoryPoints ? item.completedStoryPoints : item.completedItems),
    ]);
    const workItemRows = (displayedIssues ?? []).map((issue) => [
      issue.key, issue.summary, issue.issueType, issue.status, formatNumber(issue.storyPoints ?? issue.estimationValue ?? 0),
      issue.assignee || 'Unassigned', issue.dueDate || '—', issue.isOverdue ? 'Yes' : 'No',
    ]);
    const recoveryItems = returnToGreen.length
      ? `<ul>${returnToGreen.map((item) => `<li><strong>${escapeConfluenceStorage(item.priority)}</strong> — ${escapeConfluenceStorage(item.text)}</li>`).join('')}</ul>`
      : '<p>No immediate recovery action identified.</p>';
    const outlook = commentaryOutlook;
    const ragColour = overall.label === 'RED' ? 'Red' : overall.label === 'AMBER' ? 'Yellow' : 'Green';
    const completion = Number(report.metrics.storyPointCompletionPercentage ?? 0);
    const greenCompletion = Number(reportingSettings?.rag?.greenCompletion ?? 85);
    const amberCompletion = Number(reportingSettings?.rag?.amberCompletion ?? 65);
    const completionColour = completion >= greenCompletion ? 'Green' : completion >= amberCompletion ? 'Yellow' : 'Red';
    const healthScore = Number(readiness?.score ?? 0);
    const healthColour = healthScore >= greenCompletion ? 'Green' : healthScore >= amberCompletion ? 'Yellow' : 'Red';
    const overdue = Number(report.metrics.overdue ?? 0);
    const unresolvedDefects = Number(readiness?.openDefects ?? 0);
    const overdueColour = overdue >= Number(reportingSettings?.rag?.redOverdue ?? 4) ? 'Red' : overdue >= Number(reportingSettings?.rag?.amberOverdue ?? 1) ? 'Yellow' : 'Green';
    const defectColour = unresolvedDefects >= Number(reportingSettings?.rag?.redOpenDefects ?? 4) ? 'Red' : unresolvedDefects >= Number(reportingSettings?.rag?.amberOpenDefects ?? 1) ? 'Yellow' : 'Green';
    const executivePulseTable = confluenceRichTable(['RAG', 'Completion', 'Health', 'Scope', 'Done', 'Remaining', 'Open', 'Overdue', 'Defects'], [[
      confluenceStatusMacro(overall.label, ragColour), confluenceStatusMacro(`${formatNumber(completion)}%`, completionColour), confluenceStatusMacro(`${formatNumber(healthScore)}%`, healthColour),
      escapeConfluenceStorage(`${formatNumber(report.metrics.committedStoryPoints)} ${estimationDisplay.short}`), escapeConfluenceStorage(`${formatNumber(report.metrics.completedStoryPoints)} ${estimationDisplay.short}`),
      escapeConfluenceStorage(`${formatNumber(report.metrics.remainingStoryPoints)} ${estimationDisplay.short}`), escapeConfluenceStorage(report.metrics.open), confluenceStatusMacro(String(overdue), overdueColour), confluenceStatusMacro(String(unresolvedDefects), defectColour),
    ]], 900);
    const customInsightStorage = buildConfluenceCustomJiraInsightsStorage(customKpiResults, insightImageFiles);

    return [
      '<h1>StatusDeck Executive Sprint Report</h1>',
      `<p><strong>${escapeConfluenceStorage(report.sprint.name)}</strong>${report.sprint.goal ? `<br />Sprint Goal: ${escapeConfluenceStorage(report.sprint.goal)}` : ''}</p>`,
      `<p>State: ${escapeConfluenceStorage(report.sprint.state)} · Published ${escapeConfluenceStorage(generatedAt)} · Prepared from Jira by StatusDeck / QTI Labs</p>`,

      '<h2>Executive Pulse</h2>',
      confluencePanelMacro({ title: `Overall RAG · ${overall.label}`, tone: overall.label === 'RED' ? 'danger' : overall.label === 'AMBER' ? 'warning' : 'success', bodyHtml: `<p>${confluenceStatusMacro(overall.label, ragColour)} <strong>${escapeConfluenceStorage(overall.detail)}</strong></p>${executivePulseTable}` }),

      '<h2>Management Commentary</h2>',
      confluencePanelMacro({ title: 'Executive Commentary', tone: 'info', bodyHtml: managementCommentary ? commentaryToConfluenceStorage(managementCommentary) : '<p>No management commentary has been published.</p>' }),

      '<h2>Sprint Health &amp; Core KPIs</h2>',
      confluenceTable(['Delivery Progress', 'Completed', 'Remaining', 'Delivery Risk'], [[
        `${formatNumber(report.metrics.storyPointCompletionPercentage)}%`, `${formatNumber(report.metrics.completedStoryPoints)} ${estimationDisplay.short}`,
        `${formatNumber(report.metrics.remainingStoryPoints)} ${estimationDisplay.short}`, `${formatNumber(readiness?.openDefects ?? 0)} unresolved defects · ${formatNumber(report.metrics.overdue)} overdue`,
      ]]),
      acceptanceCriteriaSection,
      traceabilitySection,

      '<h2>Risk Profile &amp; Scope Health</h2>',
      confluenceTable(['Unresolved Defects', 'Overdue items', 'Forecast Confidence', 'Original Commitment', 'Added', 'Removed', 'Estimate Revisions', 'Current Scope'], [[
        readiness?.openDefects ?? 0, report.metrics.overdue, effortData.forecastProvisional ? 'Provisional' : 'Supported',
        `${formatNumber(originalCommitment.storyPoints ?? report.metrics.committedStoryPoints)} ${estimationDisplay.short}`,
        `+${formatNumber(scope.addedStoryPoints ?? 0)}`, `-${formatNumber(scope.removedStoryPoints ?? 0)}`,
        `${formatNumber(scope.estimateChangeStoryPoints ?? 0)}`, `${formatNumber(currentScope.storyPoints ?? report.metrics.committedStoryPoints)} ${estimationDisplay.short}`,
      ]]),
      '<h3>Return to Green</h3>', confluencePanelMacro({ title: 'Recommended Recovery Actions', tone: returnToGreen.length ? 'success' : 'neutral', bodyHtml: recoveryItems }),

      '<h2>Effort Estimate &amp; Variance</h2>',
      confluenceTable(['Original Estimate', 'Time Spent', 'Remaining Estimate', 'Forecast Effort', 'Variance', 'Original coverage', 'Remaining coverage', 'Time-Spent Coverage'], [[
        formatHours(effortData.originalEstimateHours), formatHours(effortData.timeSpentHours), formatHours(effortData.remainingEstimateHours),
        formatHours(effortData.forecastHours), `${formatHours(effortData.varianceHours)} (${formatNumber(effortData.variancePercentage ?? 0)}%)`,
        `${formatNumber(effortData.coverage?.originalEstimateCoveragePercentage ?? 0)}%`, `${formatNumber(effortData.coverage?.remainingEstimateCoveragePercentage ?? 0)}%`,
        `${formatNumber(effortData.coverage?.timeSpentCoveragePercentage ?? 0)}%`,
      ]]),

      customInsightStorage,

      '<h2>Work Distribution</h2>',
      '<h3>Issues by Status</h3>', confluenceTable(['Status', 'Items'], statusRows),
      '<h3>Work-Item Types</h3>', confluenceTable(['Type', 'Items'], typeRows),
      '<h3>Priority Profile</h3>', confluenceTable(['Priority', 'Items'], priorityRows),

      '<h2>Capacity View</h2>',
      confluenceTable(['Assignee', 'Total', 'Open', 'Completed', 'Estimate', 'Remaining', 'Original', 'Spent', 'Remaining Effort', 'Forecast', 'Overdue'], workloadRows),

      '<h2>Velocity</h2>',
      velocityRows.length ? `<p>Recent average completed: <strong>${escapeConfluenceStorage(formatNumber(velocityReport?.averageCompleted ?? 0))} ${escapeConfluenceStorage(estimationDisplay.short)}</strong></p>${confluenceTable(['Sprint', 'Committed', 'Completed'], velocityRows)}` : '<p>No historical velocity is available yet.</p>',

      outlook ? '<h2>Next Sprint Outlook</h2>' : '',
      outlook ? confluenceTable(['Sprint', 'Goal', 'Planned', 'Carry-Over', 'Velocity Load', 'Planning Checks'], [[outlook.sprintName, outlook.goal, `${formatNumber(outlook.plannedPoints)} ${estimationDisplay.short} / ${outlook.plannedItems} items`, `${outlook.carryOverItems} items / ${formatNumber(outlook.carryOverPoints)} ${estimationDisplay.short}`, outlook.averageVelocity > 0 ? `${outlook.velocityLoadPercentage}%` : 'No velocity baseline', outlook.risks.length ? outlook.risks.join(' · ') : 'No planning checks triggered']]) : '',

      '<h2>Sprint Work Items</h2>',
      confluenceTable(['Key', 'Summary', 'Type', 'Status', estimationDisplay.short, 'Assignee', 'Due', 'Overdue'], workItemRows),

      '<h2>Full Report Files</h2>',
      confluencePanelMacro({ title: 'Published Report Files', tone: 'info', bodyHtml: `<p>${confluenceStatusMacro('PDF', 'Blue')} <strong>Executive Report:</strong> <ac:link><ri:attachment ri:filename="${escapeConfluenceStorage(pdfFileName)}" /></ac:link><br /><small>Open in Confluence preview for the complete branded report.</small></p><p>${confluenceStatusMacro('PPTX', 'Blue')} <strong>Editable Presentation:</strong> <ac:link><ri:attachment ri:filename="${escapeConfluenceStorage(pptxFileName)}" /></ac:link><br /><small>Open or download the editable PowerPoint.</small></p>` }),
      `<p><em>Published from Jira by StatusDeck · QTI Labs · ${escapeConfluenceStorage(generatedAt)}</em></p>`,
    ].filter(Boolean).join('');
  }

  function buildProjectConfluenceStorageReport({ pdfFileName, pptxFileName, publishedAt, insightImageFiles = {} }) {
    if (!projectReport || !projectView) return '';
    const generatedAt = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(publishedAt || Date.now()));
    const commentary = String(projectCommentaryText || projectCommentaryOverlay?.published || projectCommentaryOverlay?.draft || projectView.commentary?.generated || '').trim();
    const teamRows = (projectView.teams ?? []).map((team) => [
      team.board?.name || 'Team', team.sprint?.name || '—', team.rag?.label || '—', `${formatNumber(team.completion)}%`,
      formatNumber(team.report?.metrics?.open ?? 0), formatNumber(team.overdue), formatNumber(team.unresolvedDefects), team.hasScopeBaseline ? formatNumber(team.scopeDeltaItems ?? 0) : 'Baseline unavailable',
    ]);
    const customInsightStorage = buildConfluenceCustomJiraInsightsStorage(customKpiResults, insightImageFiles);
    return [
      '<h1>StatusDeck Project / Program Report</h1>',
      `<p><strong>${escapeConfluenceStorage(projectReport.projectName || projectKey)}</strong></p>`,
      `<p>Published ${escapeConfluenceStorage(generatedAt)} · Prepared from Jira by StatusDeck / QTI Labs</p>`,
      '<h2>Executive &amp; Program Health</h2>',
      confluenceTable(['Overall RAG','Mean Team Completion','Teams on Track','Teams at Risk','Overdue','Defects','Blocked'], [[
        projectView.rag?.label || '—', `${formatNumber(projectView.meanCompletion ?? 0)}%`, projectView.teamsOnTrack ?? 0,
        projectView.teamsAtRisk ?? 0, projectView.overdue ?? 0, projectView.unresolvedDefects ?? 0, projectView.blocked ?? 0,
      ]], 900),
      '<h2>Management Commentary</h2>',
      confluencePanelMacro({ title: 'Project Management Summary', tone: 'info', bodyHtml: commentary ? commentaryToConfluenceStorage(commentary) : '<p>No management commentary has been published.</p>' }),
      '<h2>Delivery &amp; Team Health</h2>',
      confluenceTable(['Board','Sprint','RAG','Progress','Open','Overdue','Defects','Scope change'], teamRows, 900),
      customInsightStorage,
      '<h2>Full Report Files</h2>',
      confluencePanelMacro({ title: 'Published Report Files', tone: 'info', bodyHtml: `<p>${confluenceStatusMacro('PDF', 'Blue')} <strong>Executive Report:</strong> <ac:link><ri:attachment ri:filename="${escapeConfluenceStorage(pdfFileName)}" /></ac:link></p><p>${confluenceStatusMacro('PPTX', 'Blue')} <strong>Editable Presentation:</strong> <ac:link><ri:attachment ri:filename="${escapeConfluenceStorage(pptxFileName)}" /></ac:link></p>` }),
      `<p><em>Published from Jira by StatusDeck · QTI Labs · ${escapeConfluenceStorage(generatedAt)}</em></p>`,
    ].filter(Boolean).join('');
  }

  async function uploadConfluenceAttachment(pageId, blob, fileName, mimeType) {
    const formData = new FormData();
    const file = new File([blob], fileName, { type: mimeType });
    formData.append('file', file, fileName);
    formData.append('minorEdit', 'true');
    formData.append('comment', `StatusDeck report publish · ${report?.sprint?.name || projectReport?.projectName || 'Report'}`);

    const response = await requestConfluence(`/wiki/rest/api/content/${pageId}/child/attachment`, {
      method: 'PUT',
      headers: { Accept: 'application/json', 'X-Atlassian-Token': 'nocheck' },
      body: formData,
    });
    if (!response.ok) {
      const detail = await response.text();
      if ([401, 403].includes(response.status)) throw new Error('StatusDeck does not have permission to attach report files to that Confluence page.');
      throw new Error(`Unable to upload ${fileName} to Confluence (${response.status}). ${detail.slice(0, 240)}`);
    }
    const payload = await response.json();
    const attachment = Array.isArray(payload?.results) ? payload.results[0] : null;
    return { id: attachment?.id ?? '', title: attachment?.title ?? fileName, fileName };
  }

  async function generateConfluenceReportFiles() {
    if (projectReport && projectView && !report) {
      const baseName = `${projectReport.projectName || projectKey}_Project_Program`;
      const pdfFileName = buildConfluenceAttachmentFileName(projectKey, baseName, 'pdf');
      const pptxFileName = buildConfluenceAttachmentFileName(projectKey, baseName, 'pptx');
      await registerExport('pdf');
      await registerExport('pptx');
      const [pdf, pptx] = await Promise.all([
        createProjectPdf({ projectReport, projectView, projectCommentaryText, customKpiResults }),
        createProjectPowerPoint({ projectReport, projectView, projectCommentaryText, customKpiResults }),
      ]);
      const pdfBlob = pdf.output('blob');
      const pptxOutput = await pptx.write({ outputType: 'blob' });
      const pptxBlob = pptxOutput instanceof Blob ? pptxOutput : new Blob([pptxOutput], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
      return { pdfFileName, pptxFileName, pdfBlob, pptxBlob };
    }
    const pdfFileName = buildConfluenceAttachmentFileName(projectKey, report.sprint.name, 'pdf');
    const pptxFileName = buildConfluenceAttachmentFileName(projectKey, report.sprint.name, 'pptx');
    await registerExport('pdf');
    await registerExport('pptx');
    const [pdf, pptx] = await Promise.all([
      createPdfReport({ report, velocityReport, nextSprintOutlook, projectKey, selectedSections: FULL_EXPORT_SECTIONS, filteredIssues: displayedIssues, readiness, deliveryStatus, planningAssessment, managementCommentaryText: commentaryForExport, customKpiResults, reportingSettings }),
      createPowerPoint({ report, velocityReport, nextSprintOutlook, projectKey, selectedSections: FULL_EXPORT_SECTIONS, filteredIssues: displayedIssues, readiness, deliveryStatus, planningAssessment, managementCommentaryText: commentaryForExport, customKpiResults, reportingSettings }),
    ]);
    const pdfBlob = pdf.output('blob');
    const pptxOutput = await pptx.write({ outputType: 'blob' });
    const pptxBlob = pptxOutput instanceof Blob ? pptxOutput : new Blob([pptxOutput], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    return { pdfFileName, pptxFileName, pdfBlob, pptxBlob };
  }

  async function resolveConfluenceReportPage() {
    const space = confluenceSpaces.find((item) => String(item.id) === String(confluenceSpaceId));
    const parentPage = confluencePages.find((item) => String(item.id) === String(confluenceParentPageId));
    const title = String(confluenceChildPageTitle || (report ? getConfluenceSprintPageTitle(report?.sprint?.name) : `${projectReport?.projectName || projectKey} Project Status`)).trim();
    if (!space) throw new Error('Select a Confluence space.');
    if (!parentPage) throw new Error('Select a Confluence parent page.');
    if (!title) throw new Error('Enter the report page title.');

    let pages = confluencePagesCache.current.get(String(space.id));
    if (!pages) {
      pages = await fetchConfluenceCollection(`/wiki/api/v2/spaces/${encodeURIComponent(space.id)}/pages?limit=250`, 6);
      confluencePagesCache.current.set(String(space.id), pages);
      setConfluencePages(pages);
    }
    const existing = pages.find((page) => String(page.parentId) === String(parentPage.id) && normaliseAssistantLookup(page.title) === normaliseAssistantLookup(title));
    if (existing) return { space, parentPage, page: existing, created: false };

    const createResponse = await requestConfluence('/wiki/api/v2/pages', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spaceId: String(space.id),
        status: 'current',
        title,
        parentId: String(parentPage.id),
        body: { representation: 'storage', value: `<h1>${escapeConfluenceStorage(title)}</h1><p>StatusDeck is preparing this report.</p>` },
      }),
    });
    if (!createResponse.ok) {
      const detail = await createResponse.text();
      throw new Error(`Unable to create the Confluence report page (${createResponse.status}). ${detail.slice(0, 240)}`);
    }
    const page = await createResponse.json();
    const nextPages = [...pages.filter((item) => String(item.id) !== String(page.id)), page]
      .sort((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? '')));
    confluencePagesCache.current.set(String(space.id), nextPages);
    setConfluencePages(nextPages);
    return { space, parentPage, page, created: true };
  }

  async function publishReportToConfluence() {
    if ((!report && !projectReport) || exporting) return;
    if (!confluenceSpaceId || !confluenceParentPageId || !String(confluenceChildPageTitle).trim()) {
      setExportNotice({ tone: 'error', message: 'Select a Confluence space and parent page, then confirm the report page title.' });
      return;
    }

    try {
      setExporting('confluence');
      setExportNotice({ tone: 'info', message: 'Preparing PDF and PowerPoint…' });
      const files = await generateConfluenceReportFiles();

      setExportNotice({ tone: 'info', message: 'Resolving the report page under the selected parent…' });
      const target = await resolveConfluenceReportPage();
      const pageId = String(target.page.id);

      const pageResponse = await requestConfluence(`/wiki/api/v2/pages/${pageId}?body-format=storage&include-version=true`, { headers: { Accept: 'application/json' } });
      if (!pageResponse.ok) throw new Error(`Unable to read Confluence report page ${pageId} (${pageResponse.status}).`);
      const page = await pageResponse.json();

      setExportNotice({ tone: 'info', message: 'Uploading PDF to the report page…' });
      const pdfAttachment = await uploadConfluenceAttachment(pageId, files.pdfBlob, files.pdfFileName, 'application/pdf');
      setExportNotice({ tone: 'info', message: 'Uploading PowerPoint to the report page…' });
      const pptxAttachment = await uploadConfluenceAttachment(pageId, files.pptxBlob, files.pptxFileName, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');

      setExportNotice({ tone: 'info', message: 'Preparing Custom Jira Insight chart images for Confluence…' });
      const insightImages = await generateConfluenceInsightImages();
      const insightImageFiles = {};
      for (const image of insightImages) {
        setExportNotice({ tone: 'info', message: `Uploading Custom Jira Insight ${image.index + 1} to Confluence…` });
        const attachment = await uploadConfluenceAttachment(pageId, image.blob, image.fileName, 'image/png');
        insightImageFiles[image.index] = attachment.fileName;
      }

      const publishedAt = new Date().toISOString();
      const reportStorage = report
        ? buildConfluenceStorageReport({ pdfFileName: files.pdfFileName, pptxFileName: files.pptxFileName, publishedAt, insightImageFiles })
        : buildProjectConfluenceStorageReport({ pdfFileName: files.pdfFileName, pptxFileName: files.pptxFileName, publishedAt, insightImageFiles });
      const currentVersion = Number(page?.version?.number ?? 0);
      if (!currentVersion) throw new Error('Confluence did not return the current report page version. Refresh and try again.');

      setExportNotice({ tone: 'info', message: 'Publishing the full report to Confluence…' });
      const updateResponse = await requestConfluence(`/wiki/api/v2/pages/${pageId}`, {
        method: 'PUT',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: pageId,
          status: 'current',
          title: String(confluenceChildPageTitle).trim(),
          body: { representation: 'storage', value: reportStorage },
          version: { number: currentVersion + 1, message: `StatusDeck report publish · ${report?.sprint?.name || projectReport?.projectName || projectKey}` },
        }),
      });
      if (!updateResponse.ok) {
        const detail = await updateResponse.text();
        throw new Error(`Confluence publish failed (${updateResponse.status}). ${detail.slice(0, 240)}`);
      }
      const updatedPage = await updateResponse.json();
      const publishedPageTitle = String(updatedPage?.title || page?.title || confluenceChildPageTitle);
      const pageUrl = buildConfluenceCanonicalPageUrl(target.space.key, pageId, publishedPageTitle, updatedPage?._links?.webui || page?._links?.webui || target.page?._links?.webui || '');
      const publication = {
        destination: 'confluence', pageId, pageTitle: publishedPageTitle, pageUrl,
        spaceId: String(target.space.id), spaceKey: String(target.space.key || ''), spaceName: String(target.space.name || ''),
        parentPageId: String(target.parentPage.id), parentPageTitle: String(target.parentPage.title || ''),
        reportName: report?.sprint?.name || projectReport?.projectName || projectKey, projectKey, boardId: String(report ? (boardId || '') : 'all'), sprintId: String(report ? (sprintId || report.sprint.id || '') : 'project-program'),
        publishedAt, pdfFileName: pdfAttachment.fileName, pptxFileName: pptxAttachment.fileName, status: 'success',
      };
      try {
        const savedPublication = await invoke('saveLastPublication', publication);
        setLastPublication(savedPublication);
        setPublishSuccess(savedPublication);
      } catch {
        setLastPublication(publication);
        setPublishSuccess(publication);
      }
      // Keep the newly created/updated page in the browser-only catalogue so
      // re-publishing the same sprint resolves the existing child immediately.
      const cachedPages = confluencePagesCache.current.get(String(target.space.id)) ?? [];
      const refreshedPages = [...cachedPages.filter((item) => String(item.id) !== pageId), updatedPage]
        .sort((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? '')));
      confluencePagesCache.current.set(String(target.space.id), refreshedPages);
      setConfluencePages(refreshedPages);
      setExportModalOpen(false);
      setExportNotice(null);
      setError('');
    } catch (caughtError) {
      const message = String(caughtError?.message ?? caughtError ?? 'Unable to publish to Confluence.');
      setExportNotice({ tone: 'error', message });
      setError(message);
    } finally {
      setExporting('');
    }
  }

  async function confirmExportDestination() {
    if (exportDestination === 'confluence') {
      await publishReportToConfluence();
      return;
    }
    setExportModalOpen(false);
    if (exportFormat === 'pdf') await handlePdfExport();
    else await handlePowerPointExport();
  }

  async function handlePdfExport() {
    if ((!report && !projectReport) || exporting) return;
    try {
      setExporting('pdf');
      await registerExport('pdf');
      if (projectReport && projectView && !report) {
        const pdf = await createProjectPdf({ projectReport, projectView, projectCommentaryText, customKpiResults });
        pdf.save(buildExportFileName(projectKey, `${projectReport.projectName}_Project_Program`, 'pdf'));
        return;
      }
      const pdf = await createPdfReport({
        report,
        velocityReport,
        nextSprintOutlook,
        projectKey,
        selectedSections: FULL_EXPORT_SECTIONS,
        filteredIssues: displayedIssues,
        readiness,
        deliveryStatus,
        planningAssessment,
        managementCommentaryText: commentaryForExport,
        customKpiResults,
        reportingSettings,
      });

      pdf.save(
        buildExportFileName(
          projectKey,
          report.sprint.name,
          'pdf'
        )
      );
    } catch (caughtError) {
      console.error(caughtError);
      setError(
        caughtError.message ||
          'Unable to generate the PDF report.'
      );
    } finally {
      setExporting('');
    }
  }

  async function handlePowerPointExport() {
    if ((!report && !projectReport) || exporting) return;
    try {
      setExporting('pptx');
      await registerExport('pptx');
      if (projectReport && projectView && !report) {
        const pptx = await createProjectPowerPoint({ projectReport, projectView, projectCommentaryText, customKpiResults });
        await pptx.writeFile({ fileName: buildExportFileName(projectKey, `${projectReport.projectName}_Project_Program`, 'pptx') });
        return;
      }
      const pptx = await createPowerPoint({
        report,
        velocityReport,
        nextSprintOutlook,
        projectKey,
        selectedSections: FULL_EXPORT_SECTIONS,
        filteredIssues: displayedIssues,
        readiness,
        deliveryStatus,
        planningAssessment,
        managementCommentaryText: commentaryForExport,
        customKpiResults,
        reportingSettings,
      });

      await pptx.writeFile({
        fileName: buildExportFileName(
          projectKey,
          report.sprint.name,
          'pptx'
        ),
      });
    } catch (caughtError) {
      console.error(caughtError);
      setError(
        caughtError.message ||
          'Unable to generate the PowerPoint.'
      );
    } finally {
      setExporting('');
    }
  }

  function updatePresentationFilter(name, value) {
    setPresentationFilters((current) => ({
      ...current,
      [name]: value,
    }));
  }

  function resetPresentationFilters() {
    setPresentationFilters(FILTER_DEFAULTS);
  }


  function markLicenseInactive(caughtError) {
    const message = String(caughtError?.message ?? caughtError ?? '');

    if (
      caughtError?.code === 'LICENSE_REQUIRED' ||
      message.includes('LICENSE_REQUIRED') ||
      message.includes('valid StatusDeck subscription or trial')
    ) {
      setLicenseStatus({
        loading: false,
        active: false,
        state: 'inactive',
      });
      return true;
    }

    return false;
  }


  const visibleSectionCount = REPORT_SECTIONS.filter(
    (section) => visibleSections[section.id]
  ).length;

  function toggleSection(sectionId) {
    setVisibleSections((current) => ({
      ...current,
      [sectionId]: !current[sectionId],
    }));
    setActiveReportPreset('custom');
  }

  function showExecutiveView() {
    setVisibleSections(DEFAULT_VISIBLE_SECTIONS);
    setActiveReportPreset('executive');
  }

  function showAllSections() {
    setVisibleSections(
      REPORT_SECTIONS.reduce(
        (selection, section) => ({
          ...selection,
          [section.id]: true,
        }),
        {}
      )
    );
    setActiveReportPreset('detailed');
  }

  function sectionClass(sectionId, baseClass) {
    return [
      baseClass,
      'report-section',
      visibleSections[sectionId] ? '' : 'report-section-hidden',
    ]
      .filter(Boolean)
      .join(' ');
  }

  function sectionStyle(sectionId) {
    const index = sectionOrder.indexOf(sectionId);
    return { order: index >= 0 ? 20 + index : 99 };
  }

  function moveReportSectionByDirection(sectionId, direction) {
    const visibleOrdered = sectionOrder.filter((id) => visibleSections[id]);
    const visibleIndex = visibleOrdered.indexOf(sectionId);
    if (visibleIndex < 0) return;

    if (direction !== 'up' && direction !== 'down') return;
    const targetVisibleIndex = direction === 'up' ? visibleIndex - 1 : visibleIndex + 1;
    if (targetVisibleIndex < 0 || targetVisibleIndex >= visibleOrdered.length) return;

    const targetId = visibleOrdered[targetVisibleIndex];
    const next = [...sectionOrder];
    const from = next.indexOf(sectionId);
    const to = next.indexOf(targetId);
    if (from < 0 || to < 0) return;
    [next[from], next[to]] = [next[to], next[from]];
    setSectionOrder(next);
    setActiveReportPreset('custom');
    setSectionMoveMenu(null);
  }

  function sectionMovementState(sectionId) {
    const visibleOrdered = sectionOrder.filter((id) => visibleSections[id]);
    const index = visibleOrdered.indexOf(sectionId);
    return {
      up: index > 0,
      down: index >= 0 && index < visibleOrdered.length - 1,
      left: false,
      right: false,
    };
  }

  function sectionProps(sectionId, baseClass) {
    return {
      className: sectionClass(sectionId, baseClass),
      style: sectionStyle(sectionId),
      'data-section-id': sectionId,
    };
  }

  function sectionHandleProps(sectionId) {
    return {
      draggable: false,
      role: 'button',
      tabIndex: 0,
      'aria-label': `Move ${REPORT_SECTIONS.find((section) => section.id === sectionId)?.label ?? 'section'}`,
      onClick: (event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        setSectionMoveMenu({
          sectionId,
          top: rect.bottom + 6,
          left: rect.left,
        });
      },
      onKeyDown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          setSectionMoveMenu({ sectionId, top: rect.bottom + 6, left: rect.left });
        }
      },
    };
  }


  function currentProjectSectionOrder() {
    return [
      ...projectSectionOrder.filter((id) => PROJECT_REPORT_SECTION_IDS.includes(id)),
      ...PROJECT_REPORT_SECTION_IDS.filter((id) => !projectSectionOrder.includes(id)),
    ];
  }

  function buildProjectSectionRows(order) {
    const rows = [];
    order.forEach((id) => {
      if (PROJECT_FULL_WIDTH_SECTION_IDS.has(id)) {
        rows.push([id]);
        return;
      }
      const last = rows[rows.length - 1];
      if (last && last.length === 1 && !PROJECT_FULL_WIDTH_SECTION_IDS.has(last[0])) {
        last.push(id);
      } else {
        rows.push([id]);
      }
    });
    return rows;
  }

  function projectSectionStyle(sectionId) {
    const index = projectSectionOrder.indexOf(sectionId);
    return {
      order: index >= 0 ? 20 + index : 99,
      display: projectVisibleSections[sectionId] ? undefined : 'none',
      gridColumn: PROJECT_FULL_WIDTH_SECTION_IDS.has(sectionId) ? '1 / -1' : 'span 1',
    };
  }

  function projectSectionMovementState(sectionId) {
    const visibleOrder = currentProjectSectionOrder().filter((id) => projectVisibleSections[id]);
    const rows = buildProjectSectionRows(visibleOrder);
    const rowIndex = rows.findIndex((row) => row.includes(sectionId));
    const colIndex = rowIndex >= 0 ? rows[rowIndex].indexOf(sectionId) : -1;
    const row = rowIndex >= 0 ? rows[rowIndex] : [];
    return {
      up: rowIndex > 0,
      down: rowIndex >= 0 && rowIndex < rows.length - 1,
      left: row.length === 2 && colIndex === 1,
      right: row.length === 2 && colIndex === 0,
    };
  }

  function moveProjectSectionByDirection(sectionId, direction) {
    const visibleOrder = currentProjectSectionOrder().filter((id) => projectVisibleSections[id]);
    const rows = buildProjectSectionRows(visibleOrder).map((row) => [...row]);
    const rowIndex = rows.findIndex((row) => row.includes(sectionId));
    if (rowIndex < 0) return;
    const colIndex = rows[rowIndex].indexOf(sectionId);
    const availability = projectSectionMovementState(sectionId);

    if (direction === 'left' && availability.left) {
      [rows[rowIndex][0], rows[rowIndex][1]] = [rows[rowIndex][1], rows[rowIndex][0]];
    } else if (direction === 'right' && availability.right) {
      [rows[rowIndex][0], rows[rowIndex][1]] = [rows[rowIndex][1], rows[rowIndex][0]];
    } else if ((direction === 'up' && availability.up) || (direction === 'down' && availability.down)) {
      const targetRowIndex = direction === 'up' ? rowIndex - 1 : rowIndex + 1;
      const sourceRow = rows[rowIndex];
      const targetRow = rows[targetRowIndex];
      if (sourceRow.length === 2 && targetRow.length === 2) {
        const targetColumn = Math.min(colIndex, targetRow.length - 1);
        [sourceRow[colIndex], targetRow[targetColumn]] = [targetRow[targetColumn], sourceRow[colIndex]];
      } else {
        [rows[rowIndex], rows[targetRowIndex]] = [rows[targetRowIndex], rows[rowIndex]];
      }
    } else {
      return;
    }

    const nextVisible = rows.flat();
    const visibleSet = new Set(visibleOrder);
    let replacementIndex = 0;
    setProjectSectionOrder((current) => current.map((id) => {
      if (!visibleSet.has(id)) return id;
      const replacement = nextVisible[replacementIndex];
      replacementIndex += 1;
      return replacement;
    }));
    setProjectSectionMoveMenu(null);
  }

  function projectSectionHandleProps(sectionId) {
    return {
      draggable: false,
      role: 'button',
      tabIndex: 0,
      'aria-label': `Move ${PROJECT_REPORT_SECTIONS.find((section) => section.id === sectionId)?.label ?? 'project section'}`,
      onClick: (event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        setProjectSectionMoveMenu({ sectionId, top: rect.bottom + 6, left: rect.left });
      },
      onKeyDown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          setProjectSectionMoveMenu({ sectionId, top: rect.bottom + 6, left: rect.left });
        }
      },
    };
  }

  function currentOverviewOrder() {
    const availableIds = OVERVIEW_CARD_ORDER_DEFAULT.filter(
      (id) => id !== 'velocity-summary' || Boolean(velocityReport)
    );
    return [
      ...overviewOrder.filter((id) => availableIds.includes(id)),
      ...availableIds.filter((id) => !overviewOrder.includes(id)),
    ];
  }

  function buildOverviewRows(order) {
    const rows = [];
    order.forEach((id) => {
      if (OVERVIEW_FULL_WIDTH_CARD_IDS.has(id)) {
        rows.push([id]);
        return;
      }
      const last = rows[rows.length - 1];
      if (last && last.length === 1 && !OVERVIEW_FULL_WIDTH_CARD_IDS.has(last[0])) {
        last.push(id);
      } else {
        rows.push([id]);
      }
    });
    return rows;
  }

  function overviewMovementState(cardId) {
    const rows = buildOverviewRows(currentOverviewOrder());
    const rowIndex = rows.findIndex((row) => row.includes(cardId));
    const colIndex = rowIndex >= 0 ? rows[rowIndex].indexOf(cardId) : -1;
    const row = rowIndex >= 0 ? rows[rowIndex] : [];
    return {
      up: rowIndex > 0,
      down: rowIndex >= 0 && rowIndex < rows.length - 1,
      left: row.length === 2 && colIndex === 1,
      right: row.length === 2 && colIndex === 0,
    };
  }

  function moveOverviewCardByDirection(cardId, direction) {
    const visibleOrder = currentOverviewOrder();
    const rows = buildOverviewRows(visibleOrder).map((row) => [...row]);
    const rowIndex = rows.findIndex((row) => row.includes(cardId));
    if (rowIndex < 0) return;
    const colIndex = rows[rowIndex].indexOf(cardId);
    const availability = overviewMovementState(cardId);

    if (direction === 'left' && availability.left) {
      [rows[rowIndex][0], rows[rowIndex][1]] = [rows[rowIndex][1], rows[rowIndex][0]];
    } else if (direction === 'right' && availability.right) {
      [rows[rowIndex][0], rows[rowIndex][1]] = [rows[rowIndex][1], rows[rowIndex][0]];
    } else if ((direction === 'up' && availability.up) || (direction === 'down' && availability.down)) {
      const targetRowIndex = direction === 'up' ? rowIndex - 1 : rowIndex + 1;
      const targetRow = rows[targetRowIndex];
      const sourceRow = rows[rowIndex];
      if (sourceRow.length === 2 && targetRow.length === 2) {
        const targetColumn = Math.min(colIndex, targetRow.length - 1);
        [sourceRow[colIndex], targetRow[targetColumn]] = [targetRow[targetColumn], sourceRow[colIndex]];
      } else {
        [rows[rowIndex], rows[targetRowIndex]] = [rows[targetRowIndex], rows[rowIndex]];
      }
    } else {
      return;
    }

    const nextVisible = rows.flat();
    const visibleSet = new Set(visibleOrder);
    let nextIndex = 0;
    setOverviewOrder((current) => current.map((id) => {
      if (!visibleSet.has(id)) return id;
      const replacement = nextVisible[nextIndex];
      nextIndex += 1;
      return replacement;
    }));
    setOverviewMoveMenu(null);
  }

  function overviewCardStyle(cardId) {
    const index = overviewOrder.indexOf(cardId);
    return { order: index >= 0 ? index : 99 };
  }

  function overviewHandleProps(cardId, label) {
    return {
      draggable: false,
      'aria-label': `Move ${label}`,
      title: `Move ${label}`,
      onClick: (event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        setOverviewMoveMenu({
          cardId,
          label,
          top: rect.bottom + 6,
          left: rect.left,
        });
      },
    };
  }


  if (licenseStatus.loading) {
    return (
      <main className="page-shell">
        <div className="loading-panel">
          Checking StatusDeck licence…
        </div>
      </main>
    );
  }

  if (!licenseStatus.active) {
    return (
      <main className="page-shell licence-page">
        <section className="licence-card" aria-labelledby="licence-title">
          <div className="licence-product-mark" aria-hidden="true">SD</div>
          <p className="eyebrow">StatusDeck Licensing</p>
          <h1 id="licence-title">StatusDeck Subscription Required</h1>
          <p className="licence-summary">
            A valid StatusDeck subscription or Atlassian Marketplace trial is
            required to generate executive Jira sprint reports.
          </p>
          <p className="licence-detail">
            Subscribe or renew through Atlassian Marketplace, then reopen the
            app. Jira data is not loaded while the licence is inactive.
          </p>
          <div className="licence-actions">
            <a
              className="primary-button licence-primary-link"
              href="https://marketplace.atlassian.com/"
              target="_blank"
              rel="noreferrer"
            >
              Open Atlassian Marketplace
            </a>
            <a
              href="https://qtilabs.com/products/statusdeck/"
              target="_blank"
              rel="noreferrer"
            >
              Documentation
            </a>
            <a
              href="https://qtilabs.com/statusdeck/support/"
              target="_blank"
              rel="noreferrer"
            >
              Support
            </a>
          </div>
          {licenseStatus.state === 'error' ? (
            <p className="licence-error-note">
              StatusDeck could not verify the licence. Please reopen the app or
              contact QTI Labs support if the problem continues.
            </p>
          ) : null}
        </section>
      </main>
    );
  }

  if (loading) {
    return (
      <main className={presentationMode ? 'page-shell presentation-mode' : 'page-shell'}>
        <div className="loading-panel">
          Loading StatusDeck…
        </div>
      </main>
    );
  }

  return (
    <main className={presentationMode ? 'page-shell presentation-mode' : 'page-shell'}>
      {!presentationMode && sectionMoveMenu ? (
        <MoveMenu
          position={sectionMoveMenu}
          availability={sectionMovementState(sectionMoveMenu.sectionId)}
          label={REPORT_SECTIONS.find((section) => section.id === sectionMoveMenu.sectionId)?.label ?? 'section'}
          onMove={(direction) => moveReportSectionByDirection(sectionMoveMenu.sectionId, direction)}
          onClose={() => setSectionMoveMenu(null)}
        />
      ) : null}
      {!presentationMode && overviewMoveMenu ? (
        <MoveMenu
          position={overviewMoveMenu}
          availability={overviewMovementState(overviewMoveMenu.cardId)}
          label={overviewMoveMenu.label}
          onMove={(direction) => moveOverviewCardByDirection(overviewMoveMenu.cardId, direction)}
          onClose={() => setOverviewMoveMenu(null)}
        />
      ) : null}

      {!presentationMode && projectSectionMoveMenu ? (
        <MoveMenu
          position={projectSectionMoveMenu}
          availability={projectSectionMovementState(projectSectionMoveMenu.sectionId)}
          label={PROJECT_REPORT_SECTIONS.find((section) => section.id === projectSectionMoveMenu.sectionId)?.label ?? 'project section'}
          onMove={(direction) => moveProjectSectionByDirection(projectSectionMoveMenu.sectionId, direction)}
          onClose={() => setProjectSectionMoveMenu(null)}
        />
      ) : null}
      {presentationMode ? (
        <div className="presentation-toolbar">
          <div>
            <strong>{report?.sprint?.name ?? 'Presentation'}</strong>
            <span>
              {displayedIssues.length} visible items
              {activeFilterCount > 0
                ? ` · ${activeFilterCount} filters`
                : ''}
            </span>
          </div>

          <div className="presentation-toolbar-actions">
            <button type="button" onClick={() => openExportDialog('pdf')}>
              {exporting === 'pdf' ? 'Generating PDF…' : 'PDF'}
            </button>
            <button type="button" onClick={() => openExportDialog('pptx')}>
              {exporting === 'pptx' ? 'Generating PPT…' : 'PowerPoint'}
            </button>
            <button
              type="button"
              className="presentation-exit-button"
              onClick={handleExitPresentation}
            >
              Exit Presentation
            </button>
          </div>
        </div>
      ) : null}


      <section className="product-identity" aria-label="StatusDeck product identity">
        <div>
          <p className="product-identity-kicker">
            Executive Sprint Reporting
          </p>

          <p className="product-identity-description">
            Management-ready Jira reporting and presentations without JQL or manual filters.
          </p>
        </div>

        <p className="product-identity-brand">
          by <strong>QTI Labs</strong>
          <span aria-hidden="true"> · </span>
          <a
            href="https://qtilabs.com"
            target="_blank"
            rel="noreferrer"
          >
            qtilabs.com
          </a>
        </p>
      </section>

      <section className="configuration-card">
        <div className="section-heading">
          <div>
            <h2>Create Report</h2>

            <p>
              Select the report scope. StatusDeck handles the
              Jira queries.
            </p>
          </div>
        </div>

        <div className="selector-grid">
          <label>
            <span>Project</span>

            <select
              value={projectKey}
              onChange={(event) =>
                setProjectKey(event.target.value)
              }
            >
              <option value="">Select Project</option>

              {projects.map((project) => (
                <option
                  key={project.id}
                  value={project.key}
                >
                  {project.name} ({project.key})
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Report Type</span>

            <select
              value={reportType}
              onChange={(event) => {
                const nextType = event.target.value;
                setReportType(nextType);
                setReport(null);
                setProjectReport(null);
                if (nextType === 'project') {
                  setBoardId('all');
                  setSprintId('');
                }
              }}
            >
              <option value="sprint">Sprint Status Report</option>
              <option value="project">Project / Program Report</option>
            </select>
          </label>

          <label>
            <span>Board</span>

            <select
              value={boardId}
              onChange={(event) =>
                setBoardId(event.target.value)
              }
              disabled={
                !projectKey || boards.length === 0
              }
            >
              <option value="">Select Board</option>
              {reportType === 'project' ? <option value="all">All Scrum Boards</option> : null}

              {boards.map((board) => (
                <option
                  key={board.id}
                  value={board.id}
                >
                  {board.name} ({board.type})
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>Sprint</span>

            <select
              value={sprintId}
              onChange={(event) =>
                setSprintId(event.target.value)
              }
              disabled={
                reportType === 'project' || !boardId || boardId === 'all' || sprints.length === 0
              }
            >
              <option value="">Select Sprint</option>

              {sprints.map((sprint) => (
                <option
                  key={sprint.id}
                  value={sprint.id}
                >
                  {sprint.name} — {sprint.displayLabel ?? sprint.state}
                </option>
              ))}
            </select>
          </label>
        </div>

        {reportType === 'project' ? (
          <ProjectSectionSelector
            visibleSections={projectVisibleSections}
            onToggle={(sectionId) => setProjectVisibleSections((current) => ({ ...current, [sectionId]: !current[sectionId] }))}
            collapsed={sectionSelectorCollapsed}
            onToggleCollapsed={() => setSectionSelectorCollapsed((current) => !current)}
            sectionOrder={projectSectionOrder}
          />
        ) : (
          <SectionSelector
            visibleSections={visibleSections}
            onToggle={toggleSection}
            onExecutiveView={showExecutiveView}
            onSelectAll={showAllSections}
            visibleCount={visibleSectionCount}
            activePreset={activeReportPreset}
            collapsed={sectionSelectorCollapsed}
            onToggleCollapsed={() => setSectionSelectorCollapsed((current) => !current)}
            sectionOrder={sectionOrder}
            onReorder={(nextOrder) => {
              setSectionOrder(nextOrder);
              setActiveReportPreset('custom');
            }}
            includeSubtasks={includeSubtasks}
            onIncludeSubtasksChange={handleIncludeSubtasksChange}
          />
        )}

        <div className="action-row action-row-buttons-only">
          <div className="report-action-buttons">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setSettingsOpen(true)}
              disabled={!projectKey}
            >
              Configuration
            </button>
            <button type="button" className="secondary-button" onClick={() => setSchedulerOpen(true)} disabled={!projectKey}>
              Reporting Scheduler
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setCustomKpiOpen(true)}
              disabled={!projectKey}
            >
              Custom Jira Insights
              {(reportingSettings.kpiProfile?.custom ?? []).filter((item) => item.enabled !== false).length > 0
                ? ` (${(reportingSettings.kpiProfile?.custom ?? []).filter((item) => item.enabled !== false).length})`
                : ''}
            </button>

            <button
              type="button"
              className="secondary-button"
              onClick={handlePresent}
              disabled={!report}
            >
              Present
            </button>

            <button
              type="button"
              className="secondary-button"
              onClick={() => openExportDialog('pptx')}
              disabled={(!report && !projectReport) || Boolean(exporting)}
            >
              {exporting ? 'Working…' : 'Export / Publish'}
            </button>

            <button
              type="button"
              className="primary-button"
              onClick={loadReport}
              disabled={
                loadingReport ||
                !projectKey ||
                (reportType === 'sprint' && (!boardId || !sprintId)) ||
                (reportType === 'project' && boards.length === 0)
              }
            >
              {loadingReport
                ? 'Loading Report…'
                : 'Load Report'}
            </button>
          </div>
        </div>
        {loadingReport ? (
          <div className="statusdeck-progress-panel no-export" role="status" aria-live="polite">
            <div className="statusdeck-progress-head"><strong>Building StatusDeck Report</strong><span>{loadingProgress.percent}%</span></div>
            <div className="statusdeck-progress-track"><div className="statusdeck-progress-fill" style={{ width: `${Math.max(3, loadingProgress.percent)}%` }} /></div>
            <small>{loadingProgress.label || 'Analysing Jira data…'}</small>
          </div>
        ) : null}
        {lastPublication?.publishedAt ? (
          <button type="button" className="last-publication-chip no-export" onClick={() => setPublishSuccess(lastPublication)} title="View last Confluence publication">
            Last published: Confluence · {new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(lastPublication.publishedAt))}
          </button>
        ) : null}
      </section>

      {settingsOpen ? (
        <ReportingSettingsModal
          initialSettings={reportingSettings}
          boardConfiguration={boardConfiguration}
          detectedEstimationLabel={detectedEstimationLabel}
          onClose={() => setSettingsOpen(false)}
          onSave={saveReportingSettings}
        />
      ) : null}

      {customKpiOpen ? (
        <CustomKpiFiltersModal
          initialSettings={reportingSettings}
          onClose={() => setCustomKpiOpen(false)}
          onSave={saveReportingSettings}
        />
      ) : null}

      {schedulerOpen ? (
        <div className="statusdeck-modal-backdrop no-export" role="presentation">
          <section className="statusdeck-modal statusdeck-modal-compact" role="dialog" aria-modal="true" aria-labelledby="scheduler-title">
            <div className="statusdeck-modal-header">
              <div>
                <p className="eyebrow">Calendar Reminder</p>
                <h2 id="scheduler-title">Reporting Scheduler</h2>
                <p>Save the cadence in StatusDeck, then add a recurring reminder to your own calendar. No background Forge polling is required.</p>
              </div>
              <button type="button" className="modal-close-button" onClick={() => setSchedulerOpen(false)} aria-label="Close Scheduler">×</button>
            </div>
            <label className="checkbox-option"><input type="checkbox" checked={Boolean(reportSchedule.enabled)} onChange={(event) => { const checked = event.currentTarget.checked; setReportSchedule((current) => ({ ...current, enabled: checked })); }} /><span>Enable Schedule for This Reporting Scope</span></label>
            <div className="settings-grid settings-grid-two">
              <label><span>Cadence</span><select value={reportSchedule.cadence} onChange={(event) => { const value = event.currentTarget.value; setReportSchedule((current) => ({ ...current, cadence: value })); }}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
              <label><span>Time</span><input type="time" step="60" value={reportSchedule.time} onChange={(event) => { const value = event.currentTarget.value; setReportSchedule((current) => ({ ...current, time: value })); }} /></label>
              {reportSchedule.cadence === 'weekly' ? <label><span>Day</span><select value={reportSchedule.dayOfWeek} onChange={(event) => { const value = event.currentTarget.value; setReportSchedule((current) => ({ ...current, dayOfWeek: Number(value) })); }}><option value={0}>Sunday</option><option value={1}>Monday</option><option value={2}>Tuesday</option><option value={3}>Wednesday</option><option value={4}>Thursday</option><option value={5}>Friday</option><option value={6}>Saturday</option></select></label> : null}
              <label><span>Time Zone</span><select value={reportSchedule.timeZone} onChange={(event) => { const value = event.currentTarget.value; setReportSchedule((current) => ({ ...current, timeZone: value })); }}>{getStatusDeckTimeZoneOptions(reportSchedule.timeZone).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label><span>Calendar Reminder</span><select value={Number(reportSchedule.reminderMinutes ?? 15)} onChange={(event) => { const value = event.currentTarget.value; setReportSchedule((current) => ({ ...current, reminderMinutes: Number(value) })); }}><option value={5}>5 minutes before</option><option value={10}>10 minutes before</option><option value={15}>15 minutes before</option><option value={30}>30 minutes before</option><option value={60}>1 hour before</option></select></label>
            </div>
            <label className="settings-full-field"><span>Reminder Message</span><textarea rows="3" value={reportSchedule.message} onChange={(event) => { const value = event.currentTarget.value; setReportSchedule((current) => ({ ...current, message: value })); }} /></label>
            {schedulerNotice ? <div className={`settings-validation-message settings-validation-message-${schedulerNotice.tone}`} role="status">{schedulerNotice.message}</div> : null}
            <p className="scheduler-disclosure">StatusDeck stores the exact schedule, including minutes such as 3:15 PM. Calendar reminders run in Google Calendar, Outlook, Apple Calendar or any app that imports .ics files, so StatusDeck does not need a five-minute Forge scheduler.</p>
            <div className="calendar-action-grid">
              <button type="button" className="secondary-button" onClick={addScheduleToGoogleCalendar}>Add to Google Calendar</button>
              <button type="button" className="secondary-button" onClick={addScheduleToOutlookCalendar}>Open in Outlook</button>
              <button type="button" className="secondary-button" onClick={downloadScheduleCalendarInvite}>Download Recurring .ICS</button>
            </div>
            <div className="modal-actions"><button type="button" className="primary-button" onClick={saveReportSchedule}>Save Schedule</button></div>
          </section>
        </div>
      ) : null}

      {exportModalOpen ? (
        <div className="statusdeck-modal-backdrop no-export" role="presentation">
          <section className="statusdeck-modal statusdeck-modal-compact export-publish-modal" role="dialog" aria-modal="true" aria-labelledby="export-publish-title">
            <div className="statusdeck-modal-header">
              <div>
                <p className="eyebrow">Export / Publish</p>
                <h2 id="export-publish-title">Choose Where This Report Should Go</h2>
                <p>Downloads use your browser's normal save behaviour. Confluence publishes a concise executive summary and attaches the complete PDF plus editable PowerPoint.</p>
              </div>
              <button type="button" className="modal-close-button" onClick={() => setExportModalOpen(false)} aria-label="Close Export Dialog">×</button>
            </div>
            <div className="export-destination-grid">
              <button type="button" className={`export-destination-card ${exportDestination === 'download' ? 'selected' : ''}`} onClick={() => { setExportDestination('download'); setExportNotice(null); }}>
                <strong>Download</strong><span>PowerPoint or PDF to this device</span>
              </button>
              <button type="button" className={`export-destination-card ${exportDestination === 'confluence' ? 'selected' : ''}`} onClick={() => { setExportDestination('confluence'); setExportNotice(null); }}>
                <strong>Publish to Confluence</strong><span>Attach PDF + PowerPoint and update the report page</span>
              </button>
            </div>
            {exportDestination === 'download' ? (
              <div className="settings-grid settings-grid-two">
                <label><span>Format</span><select value={exportFormat} onChange={(event) => { const value = event.currentTarget.value; setExportFormat(value); }}><option value="pptx">PowerPoint (.pptx)</option><option value="pdf">PDF (.pdf)</option></select></label>
                <div className="export-browser-note"><strong>Save Location</strong><span>Your browser controls the folder prompt. Enable “Ask where to save each file” in Chrome/Edge if you want a folder chooser.</span></div>
              </div>
            ) : (
              <div className="confluence-publish-fields">
                <label className="settings-full-field"><span>Confluence Space</span><select value={confluenceSpaceId} disabled={confluenceSpacesLoading || !confluenceSpaces.length} onChange={(event) => { const value = event.currentTarget.value; setConfluenceSpaceId(value); setConfluenceParentPageId(''); setExportNotice(null); }}><option value="">{confluenceSpacesLoading ? 'Loading spaces…' : 'Select a space'}</option>{confluenceSpaces.map((space) => <option key={space.id} value={space.id}>{space.name} ({space.key})</option>)}</select></label>
                <label className="settings-full-field"><span>Parent Page</span><select value={confluenceParentPageId} disabled={!confluenceSpaceId || confluencePagesLoading || !confluencePages.length} onChange={(event) => { const value = event.currentTarget.value; setConfluenceParentPageId(value); setExportNotice(null); }}><option value="">{confluencePagesLoading ? 'Loading pages…' : 'Select a parent page'}</option>{confluencePages.map((page) => <option key={page.id} value={page.id}>{page.title}</option>)}</select></label>
                <label className="settings-full-field"><span>{report ? 'Sprint child page' : 'Project / Program page'}</span><input value={confluenceChildPageTitle} onChange={(event) => { const value = event.currentTarget.value; setConfluenceChildPageTitle(value); }} placeholder="Sprint 02" /></label>
                <div className="confluence-file-plan"><strong>What StatusDeck Will Publish</strong><span>✓ Creates the report page under the selected parent if it does not exist</span><span>✓ Updates the same report page on later publishes</span><span>✓ Full native StatusDeck report data on the page</span><span>✓ Branded PDF executive report attached below</span><span>✓ Editable PowerPoint attached below</span><small>Stable PDF/PPT filenames are reused so Confluence keeps attachment version history.</small></div>
                <p className="scheduler-disclosure">Confluence publishing runs as the current Atlassian user. Only spaces/pages the user can access are shown. StatusDeck stores only small last-publication metadata; report files stay in Confluence.</p>
              </div>
            )}
            {exportNotice ? <div className={`settings-validation-message settings-validation-message-${exportNotice.tone}`} role="status">{exportNotice.message}</div> : null}
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setExportModalOpen(false)}>Cancel</button>
              <button type="button" className="primary-button" disabled={Boolean(exporting) || (exportDestination === 'confluence' && (!confluenceSpaceId || !confluenceParentPageId || !String(confluenceChildPageTitle).trim()))} onClick={confirmExportDestination}>
                {exporting === 'confluence' ? 'Publishing…' : exporting ? 'Generating…' : exportDestination === 'confluence' ? 'Publish to Confluence' : `Download ${exportFormat === 'pdf' ? 'PDF' : 'PowerPoint'}`}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {publishSuccess ? (
        <div className="statusdeck-modal-backdrop no-export" role="presentation">
          <section className="statusdeck-modal statusdeck-modal-compact publish-success-modal" role="dialog" aria-modal="true" aria-labelledby="publish-success-title">
            <div className="publish-success-icon" aria-hidden="true">✓</div>
            <div className="statusdeck-modal-header publish-success-header">
              <div>
                <p className="eyebrow">Confluence Publish</p>
                <h2 id="publish-success-title">Report Published Successfully</h2>
                <p>{publishSuccess.reportName}</p>
              </div>
            </div>
            <div className="publish-success-details">
              <div><span>Space</span><strong>{publishSuccess.spaceName || publishSuccess.spaceKey || 'Confluence'}</strong></div>
              <div><span>Parent</span><strong>{publishSuccess.parentPageTitle || publishSuccess.parentPageId || '—'}</strong></div>
              <div><span>Report Page</span><strong>{publishSuccess.pageTitle || publishSuccess.pageId}</strong></div>
              <div><span>Published</span><strong>{new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(publishSuccess.publishedAt))}</strong></div>
              <div><span>PDF</span><strong>{publishSuccess.pdfFileName}</strong></div>
              <div><span>PowerPoint</span><strong>{publishSuccess.pptxFileName}</strong></div>
            </div>
            <p className="scheduler-disclosure">The PDF preserves the complete StatusDeck design for Confluence preview. The PowerPoint is attached as the editable companion. Re-publishing this report updates the attachment versions.</p>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setPublishSuccess(null)}>Done</button>
              <button type="button" className="primary-button" onClick={async () => { const url = buildConfluenceCanonicalPageUrl(publishSuccess.spaceKey, publishSuccess.pageId, publishSuccess.pageTitle, publishSuccess.pageUrl); setPublishSuccess(null); await router.open(url); }}>Open Confluence Page</button>
            </div>
          </section>
        </div>
      ) : null}

      {!assistantOpen ? (
        <button type="button" className="assistant-launcher no-export" onClick={() => setAssistantOpen(true)} aria-label="Open StatusDeck Assistant">
          <span className="assistant-launcher-icon" aria-hidden="true">◆</span>
          <span><strong>StatusDeck Assistant</strong><small>Ask Jira delivery questions</small></span>
        </button>
      ) : (
        <section className="assistant-panel assistant-panel-chat no-export" aria-label="StatusDeck Assistant">
          <div className="assistant-header">
            <div className="assistant-title"><strong>StatusDeck Assistant</strong></div>
            <div className="assistant-header-controls">
              <label className="assistant-mode-control" title={ASSISTANT_MODES[assistantMode].description}>
                <span>Mode</span>
                <select value={assistantMode} onChange={(event) => { const value = event.currentTarget.value; setAssistantMode(ASSISTANT_MODES[value] ? value : 'instant'); }}>
                  <option value="instant">Instant</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>
              <button type="button" onClick={() => setAssistantOpen(false)} aria-label="Collapse assistant">−</button>
            </div>
          </div>
          <div className="assistant-conversation" aria-live="polite">
            {assistantMessages.length === 0 ? (
              <div className="assistant-welcome">
                <strong>Ask without generating a report.</strong>
                <p>Try “Give me details on Sprint 51 in XYZ project”, “Why was it Amber?”, or “Compare Sprint 50 and Sprint 51”.</p>
                <div className="assistant-quick-actions">
                  <button type="button" onClick={() => submitAssistantQuestion('What is the status of the current sprint?')}>Current Sprint Status</button>
                  <button type="button" onClick={() => submitAssistantQuestion('What are the current sprint risks?')}>Current Risks</button>
                </div>
              </div>
            ) : assistantMessages.map((message, index) => (
              <div key={`${message.role}-${index}`} className={`assistant-message assistant-message-${message.role}`}>
                <span className="assistant-message-role">{message.role === 'user' ? 'You' : 'StatusDeck'}</span>
                <div className="assistant-message-text">{renderAssistantMessageText(message.text)}</div>
                {message.visual ? renderAssistantVisual(message.visual) : null}
                {message.actions?.length ? (
                  <div className="assistant-followups">
                    {message.actions.map((action, actionIndex) => {
                      const label = typeof action === 'string' ? action : action?.label ?? 'Continue';
                      return <button type="button" key={`${label}-${actionIndex}`} onClick={() => handleAssistantAction(action)}>{label}</button>;
                    })}
                  </div>
                ) : null}
              </div>
            ))}
            {assistantBusy ? <div className="assistant-message assistant-message-assistant"><span className="assistant-message-role">StatusDeck</span><div className="assistant-message-text">{assistantMode === 'high' ? 'Running bounded deep analysis…' : assistantMode === 'medium' ? 'Checking targeted Jira data…' : 'Checking Jira…'}</div></div> : null}
          </div>
          <form onSubmit={(event) => { event.preventDefault(); submitAssistantQuestion(); }}>
            <input value={assistantQuestion} onChange={(event) => { const value = event.currentTarget.value; setAssistantQuestion(value); }} placeholder="Ask about any sprint, project, risk, scope or workload…" />
            <button type="submit" className="primary-button" disabled={assistantBusy || !assistantQuestion.trim()}>Ask</button>
          </form>
          <div className="assistant-context-line">{assistantContext.sprintName ? `Context: ${assistantContext.projectKey} · ${assistantContext.sprintName} · ${ASSISTANT_MODES[assistantMode].label}` : `No generated report required · ${ASSISTANT_MODES[assistantMode].label}`}</div>
        </section>
      )}

      {usageStatus ? (
        <div className="usage-strip">
          <span>
            Reports: {usageStatus.reports.hourlyUsed}/{usageStatus.reports.hourlyLimit} this hour
          </span>
          <span>
            {usageStatus.reports.dailyUsed}/{usageStatus.reports.dailyLimit} today
          </span>
          <span>
            PowerPoints: {usageStatus.powerPoints.dailyUsed}/{usageStatus.powerPoints.dailyLimit} today
          </span>
          <span>
            PDFs: {usageStatus.pdfs.dailyUsed}/{usageStatus.pdfs.dailyLimit} today
          </span>
          {reportMeta ? (
            <span className={reportMeta.cacheHit ? 'cache-hit' : ''}>
              {reportMeta.cacheHit
                ? `Loaded from cache · ${formatShortDate(reportMeta.generatedAt, true)}`
                : `Fresh Jira data · ${formatShortDate(reportMeta.generatedAt, true)}`}
            </span>
          ) : null}
        </div>
      ) : null}

      {filterPanelOpen && report ? (
        <section className="optional-filters-panel">
          <div className="optional-filters-heading">
            <div>
              <p className="eyebrow">Optional Presentation Filters</p>
              <h3>Refine Dashboard and Exports</h3>
              <p>
                Headline sprint totals remain the full Jira sprint.
                Distribution charts, issue links, workload and exports use these filters.
              </p>
            </div>
            <button type="button" onClick={resetPresentationFilters}>
              Reset Filters
            </button>
          </div>

          <div className="optional-filter-grid">
            <label>
              <span>Assignee</span>
              <select
                value={presentationFilters.assignee}
                onChange={(event) =>
                  updatePresentationFilter('assignee', event.target.value)
                }
              >
                <option value="all">All Assignees</option>
                {filterOptions.assignees.map((value) => (
                  <option value={value} key={value}>{value}</option>
                ))}
              </select>
            </label>

            <label>
              <span>Status</span>
              <select
                value={presentationFilters.status}
                onChange={(event) =>
                  updatePresentationFilter('status', event.target.value)
                }
              >
                <option value="all">All Statuses</option>
                {filterOptions.statuses.map((value) => (
                  <option value={value} key={value}>{value}</option>
                ))}
              </select>
            </label>

            <label>
              <span>Priority</span>
              <select
                value={presentationFilters.priority}
                onChange={(event) =>
                  updatePresentationFilter('priority', event.target.value)
                }
              >
                <option value="all">All Priorities</option>
                {filterOptions.priorities.map((value) => (
                  <option value={value} key={value}>{value}</option>
                ))}
              </select>
            </label>

            <label>
              <span>Issue Type</span>
              <select
                value={presentationFilters.issueType}
                onChange={(event) =>
                  updatePresentationFilter('issueType', event.target.value)
                }
              >
                <option value="all">All Issue Types</option>
                {filterOptions.issueTypes.map((value) => (
                  <option value={value} key={value}>{value}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="optional-filter-toggles">
            <label>
              <input
                type="checkbox"
                checked={presentationFilters.onlyOverdue}
                onChange={(event) =>
                  updatePresentationFilter('onlyOverdue', event.target.checked)
                }
              />
              Overdue only
            </label>
            <label>
              <input
                type="checkbox"
                checked={presentationFilters.onlyDefects}
                onChange={(event) =>
                  updatePresentationFilter('onlyDefects', event.target.checked)
                }
              />
              Defects only
            </label>
            <label>
              <input
                type="checkbox"
                checked={presentationFilters.onlyUnassigned}
                onChange={(event) =>
                  updatePresentationFilter('onlyUnassigned', event.target.checked)
                }
              />
              Unassigned only
            </label>
          </div>

          <div className="active-filter-summary">
            Showing <strong>{displayedIssues.length}</strong> of{' '}
            <strong>{baseDisplayedIssues.length}</strong> report items.
          </div>
        </section>
      ) : null}

      {error ? (
        <div className="error-banner">{error}</div>
      ) : null}

      {supplementaryWarning ? (
        <div className="warning-banner">{supplementaryWarning}</div>
      ) : null}

      {projectReport && projectView ? (
        <section className="project-report-shell">
          <section className="report-header-card project-report-header">
            <div>
              <p className="eyebrow">Project / Program Report</p>
              <h2>{projectReport.projectName}</h2>
              <p>{projectView.teams.length} Scrum team{projectView.teams.length === 1 ? '' : 's'} included · latest active/closed reporting sprint per board</p>
            </div>
            <div className="sprint-dates"><span><strong>Generated:</strong> {formatDate(projectReport.generatedAt)}</span></div>
          </section>

          <div className="project-report-section-stack">
            <section className="dashboard-card content-card project-report-section project-health-section" style={projectSectionStyle('projectHealth')}>
              <button type="button" className="section-drag-handle no-export" {...projectSectionHandleProps('projectHealth')}>⠿</button>
              <div className="dashboard-card-heading">
                <div><p className="eyebrow">Executive / Program Health</p><h3>Project Health at a Glance</h3></div>
                <span className={`project-rag-badge project-rag-${String(projectView.rag.label).toLowerCase()} heading-with-calculation-help`}>
                  <span>Overall RAG <strong>{projectView.rag.label}</strong></span>
                  <CalculationButton calculationKey="projectOverallRag" context={{ projectView, settings: reportingSettings }} />
                </span>
              </div>
              <div className="headline-metrics-grid project-health-kpi-grid">
                {reportingSettings.kpiProfile?.native?.completion !== false ? <MetricCard label="Mean Team Completion" value={projectView.meanCompletion} formatter={(value) => `${formatNumber(value)}%`} tone={projectView.rag.label === 'RED' ? 'negative' : projectView.rag.label === 'AMBER' ? 'warning' : 'positive'} helper="Simple mean across included teams" calculationKey="projectMeanCompletion" calculationContext={{ projectView, settings: reportingSettings }} /> : null}
                <MetricCard label="Teams on Track" value={projectView.teamsOnTrack} helper={`${projectView.teamsOnTrack} of ${projectView.teams.length} Green`} tone={projectView.teamsOnTrack === projectView.teams.length ? 'positive' : 'neutral'} calculationKey="projectTeamsOnTrack" calculationContext={{ projectView, settings: reportingSettings }} />
                <MetricCard label="Teams at Risk" value={projectView.teamsAtRisk} helper={`${projectView.rag.counts.RED} Red · ${projectView.rag.counts.AMBER} Amber`} tone={projectView.rag.counts.RED ? 'negative' : projectView.teamsAtRisk ? 'warning' : 'positive'} calculationKey="projectTeamsAtRisk" calculationContext={{ projectView, settings: reportingSettings }} />
                <MetricCard label="Open Work" value={projectView.open} helper={`${projectView.totalItems} Jira items in reporting scope`} tone={projectView.open ? 'neutral' : 'positive'} />
                {reportingSettings.kpiProfile?.native?.overdue !== false ? <MetricCard label="Overdue Work" value={projectView.overdue} helper="Open items across included teams" tone={projectView.overdue ? 'warning' : 'positive'} calculationKey="projectOverdue" calculationContext={{ projectView, settings: reportingSettings }} /> : null}
                {reportingSettings.kpiProfile?.native?.defects !== false ? <MetricCard label="Unresolved Defects" value={projectView.unresolvedDefects} helper="Current reporting-sprint scope" tone={projectView.unresolvedDefects ? 'negative' : 'positive'} calculationKey="projectDefects" calculationContext={{ projectView, settings: reportingSettings }} /> : null}
                <MetricCard label="Blocked / Impeded" value={projectView.blocked} helper="Open blocked / waiting statuses" tone={projectView.blocked ? 'negative' : 'positive'} calculationKey="projectBlocked" calculationContext={{ projectView, settings: reportingSettings }} />
                <MetricCard label="Scope Growth Teams" value={projectView.scopeIncreasedTeams} helper={projectView.scopeBaselineUnavailableTeams ? `${projectView.scopeBaselineUnavailableTeams} baseline unavailable` : 'Compared with sprint-start item scope'} tone={projectView.scopeIncreasedTeams ? 'warning' : 'positive'} calculationKey="projectScopeGrowth" calculationContext={{ projectView, settings: reportingSettings }} />
                <MetricCard label="Forecast-Ready Teams" value={projectView.forecastReadyTeams} helper={`${projectView.forecastReadyTeams} of ${projectView.teams.length} non-provisional`} tone={projectView.forecastAttentionTeams ? 'warning' : 'positive'} />
                <MetricCard label="Open Epics" value={projectView.openEpics.length} helper={projectView.epics.length ? `${projectView.epics.length} recent epics in Jira context` : 'No Epic data returned'} tone={projectView.openEpics.length ? 'neutral' : 'positive'} />
              </div>
              <div className="project-executive-visual-grid">
                <div className="project-subcard project-chart-card">
                  <h4>Team Health Distribution</h4>
                  <p className="project-chart-description">Green / Amber / Red teams using the configured StatusDeck project thresholds.</p>
                  <ProjectRagDonut ragCounts={projectView.rag.counts} />
                </div>
                <div className="project-subcard project-chart-card">
                  <h4>Completion by Team</h4>
                  <p className="project-chart-description">Latest active/closed reporting sprint for each included Scrum board.</p>
                  <ProjectTeamCompletionBars teams={projectView.teams} />
                </div>
              </div>
              {projectView.cadenceMismatch ? <div className="warning-banner project-inline-warning">Sprint cadence differs materially across boards. Cross-team comparisons should be read as exception indicators rather than a single like-for-like sprint period.</div> : null}
            </section>

            {customKpiResults.length ? (
              <CustomJiraInsightsSection
                results={customKpiResults}
                project
                layoutProps={{ style: projectSectionStyle('projectCustomJiraInsights') }}
                handleProps={projectSectionHandleProps('projectCustomJiraInsights')}
              />
            ) : null}

            <div style={projectSectionStyle('projectCommentary')}>
              <ProjectManagementSummary
                projectReport={projectReport}
                settings={reportingSettings}
                commentaryOverlay={projectCommentaryOverlay}
                commentaryText={projectCommentaryText}
                commentarySaving={projectCommentarySaving}
                commentaryNotice={projectCommentaryNotice}
                onCommentaryTextChange={setProjectCommentaryText}
                onSaveCommentary={saveProjectCommentary}
                onResetCommentary={resetProjectCommentary}
                handleProps={projectSectionHandleProps('projectCommentary')}
                readOnly={presentationMode}
              />
            </div>

            <section className={`dashboard-card content-card project-report-section ${projectView.epics.length ? '' : 'project-empty-section'}`} style={projectSectionStyle('projectStrategic')}>
              <button type="button" className="section-drag-handle no-export" {...projectSectionHandleProps('projectStrategic')}>⠿</button>
              <div className="dashboard-card-heading"><div><p className="eyebrow">Strategic Themes & Epics</p><h3>High-Level Jira Focus Areas</h3><p>Most recently updated Epics in this project. StatusDeck does not invent portfolio hierarchy where Jira does not provide it.</p></div><span className="mini-badge">{projectView.epics.length} epics</span></div>
              {projectView.epics.length ? (
                <div className="project-epic-grid">
                  {projectView.epics.slice(0, 8).map((epic) => (
                    <div className="project-epic-card" key={epic.id || epic.key}>
                      <div><strong>{epic.key}</strong><span>{epic.status}</span></div>
                      <p>{epic.summary}</p>
                      <small>{epic.priority && epic.priority !== 'None' ? `Priority: ${epic.priority}` : 'No priority'}{epic.dueDate ? ` · Due ${formatDate(epic.dueDate)}` : ''}</small>
                    </div>
                  ))}
                </div>
              ) : <div className="project-empty-strip"><strong>No Epic Data Available</strong><span>Jira returned no Epic issues for this project.</span></div>}
              {(projectReport.portfolioContext?.warnings ?? []).length ? <p className="project-data-note">{projectReport.portfolioContext.warnings.join(' ')}</p> : null}
            </section>

            <section className="dashboard-card content-card project-report-section" style={projectSectionStyle('projectDelivery')}>
              <button type="button" className="section-drag-handle no-export" {...projectSectionHandleProps('projectDelivery')}>⠿</button>
              <div className="dashboard-card-heading"><div><p className="eyebrow">Delivery & Team Health</p><h3>Cross-Team Delivery Exceptions</h3><p>Team RAG is evaluated against the same configured completion, overdue, defect and estimate-confidence thresholds used by StatusDeck.</p></div></div>
              <div className="project-team-health-grid">
                {projectView.teams.map((item) => (
                  <article className={`project-team-health-card project-team-health-${String(item.rag.label).toLowerCase()}`} key={item.board.id}>
                    <div className="project-team-health-heading"><div><strong>{item.board.name}</strong><span>{item.sprint?.name ?? 'No sprint'}</span></div><span className={`project-rag-badge project-rag-${String(item.rag.label).toLowerCase()}`}>{item.rag.label}</span></div>
                    <div className="project-team-health-metrics">
                      <div><strong>{item.completion}%</strong><span className="project-team-metric-label">Complete <CalculationButton calculationKey="projectTeamCompletion" context={{ team: item }} /></span></div>
                      <div><strong>{item.report?.metrics?.open ?? 0}</strong><span>open</span></div>
                      <div><strong>{item.overdue}</strong><span className="project-team-metric-label">overdue <CalculationButton calculationKey="projectTeamOverdue" context={{ team: item }} /></span></div>
                      <div><strong>{item.unresolvedDefects}</strong><span className="project-team-metric-label">defects <CalculationButton calculationKey="projectTeamDefects" context={{ team: item }} /></span></div>
                    </div>
                    <p>{item.rag.reason}</p>
                    <small className="project-scope-signal">
                      {item.hasScopeBaseline ? (item.scopeDeltaItems !== 0 ? <>Scope {item.scopeDeltaItems > 0 ? 'increased' : 'decreased'} by {Math.abs(item.scopeDeltaItems)} item{Math.abs(item.scopeDeltaItems) === 1 ? '' : 's'} ({item.scopeDeltaPercentage > 0 ? '+' : ''}{item.scopeDeltaPercentage}%).</> : <>Scope remains aligned to the sprint-start item baseline.</>) : <>Scope baseline unavailable.</>}
                      <CalculationButton calculationKey="projectTeamScope" context={{ team: item }} />
                    </small>
                  </article>
                ))}
              </div>
              <div className="project-two-column project-delivery-visuals">
                <div className="project-subcard project-chart-card">
                  <h4>Delivery Exceptions by Team</h4>
                  <p className="project-chart-description">Exception bars combine overdue, unresolved-defect and blocked signals; open work is shown separately and is not double-counted into the bar.</p>
                  <ProjectTeamExceptionBars teams={projectView.teams} />
                </div>
                <div className="project-subcard project-chart-card">
                  <h4>Scope Change by Team</h4>
                  <p className="project-chart-description">Item-scope movement against each team's reliable sprint-start baseline. Positive values indicate scope growth.</p>
                  <ProjectScopeChangeBars teams={projectView.teams} />
                </div>
              </div>
            </section>

            <section className="dashboard-card content-card project-report-section" style={projectSectionStyle('projectOperational')}>
              <button type="button" className="section-drag-handle no-export" {...projectSectionHandleProps('projectOperational')}>⠿</button>
              <div className="dashboard-card-heading"><div><p className="eyebrow">Operational Flow & Capacity</p><h3>Pipeline Health and Workload</h3><p>Uses current Jira status and assignee data. Cycle/lead-time calculations are intentionally not fabricated without transition-history analysis.</p></div></div>
              <div className="project-two-column project-operational-visuals">
                <div className="project-subcard dashboard-card-status project-chart-card">
                  <h4 className="heading-with-calculation-help"><span>Status Distribution</span><CalculationButton calculationKey="projectStatusDistribution" context={{ projectView }} /></h4>
                  <StatusDonut statusCounts={projectView.statusCounts} total={Object.values(projectView.statusCounts ?? {}).reduce((sum, count) => sum + Number(count ?? 0), 0)} />
                </div>
                <div className="project-subcard project-chart-card">
                  <h4 className="heading-with-calculation-help"><span>Highest Open Workload</span><CalculationButton calculationKey="projectWorkload" context={{ projectView }} /></h4>
                  <ProjectWorkloadBars workload={projectView.workload} />
                </div>
                <div className="project-subcard project-chart-card">
                  <h4>Work Type Distribution</h4>
                  <p className="project-chart-description">Current reporting-sprint work items grouped by Jira issue type.</p>
                  <ProjectDistributionBars counts={projectView.typeCounts} emptyLabel="No Jira issue-type distribution is available." />
                </div>
              </div>
            </section>

            <section className="dashboard-card content-card project-report-section" style={projectSectionStyle('projectQuality')}>
              <button type="button" className="section-drag-handle no-export" {...projectSectionHandleProps('projectQuality')}>⠿</button>
              <div className="dashboard-card-heading"><div><p className="eyebrow">Quality, Risks & Dependencies</p><h3>Current Project Delivery Risks</h3></div></div>
              <div className="project-risk-grid">
                <div className={projectView.overdue ? 'project-risk-card project-risk-card-warning' : 'project-risk-card project-risk-card-good'}><span className="project-risk-label">Overdue Open Items <CalculationButton calculationKey="projectOverdue" context={{ projectView, settings: reportingSettings }} /></span><strong>{projectView.overdue}</strong><small>Across current reporting sprints</small></div>
                <div className={projectView.unresolvedDefects ? 'project-risk-card project-risk-card-danger' : 'project-risk-card project-risk-card-good'}><span className="project-risk-label">Unresolved Defects <CalculationButton calculationKey="projectDefects" context={{ projectView, settings: reportingSettings }} /></span><strong>{projectView.unresolvedDefects}</strong><small>Bug/defect items not Done</small></div>
                <div className={projectView.blocked ? 'project-risk-card project-risk-card-danger' : 'project-risk-card project-risk-card-good'}><span className="project-risk-label">Blocked / Impeded <CalculationButton calculationKey="projectBlocked" context={{ projectView, settings: reportingSettings }} /></span><strong>{projectView.blocked}</strong><small>Open statuses matching blocked/impediment/waiting</small></div>
                <div className={projectView.scopeIncreasedTeams ? 'project-risk-card project-risk-card-warning' : 'project-risk-card project-risk-card-good'}><span className="project-risk-label">Teams With Scope Growth <CalculationButton calculationKey="projectScopeGrowth" context={{ projectView, settings: reportingSettings }} /></span><strong>{projectView.scopeIncreasedTeams}</strong><small>{projectView.scopeBaselineUnavailableTeams ? `${projectView.scopeBaselineUnavailableTeams} baseline unavailable` : 'Compared with sprint-start item scope'}</small></div>
              </div>
              <div className="project-exception-list">
                {projectView.teams.filter((item) => item.rag.label !== 'GREEN').map((item) => <div key={item.board.id}><span className={`project-rag-dot project-rag-dot-${String(item.rag.label).toLowerCase()}`} /> <strong>{item.board.name}</strong><span>{item.rag.reason}</span></div>)}
                {!projectView.teams.some((item) => item.rag.label !== 'GREEN') ? <p>No team is currently breaching configured project reporting thresholds.</p> : null}
              </div>
            </section>

            <section className={`dashboard-card content-card project-report-section ${projectView.versions.length ? '' : 'project-empty-section'}`} style={projectSectionStyle('projectRelease')}>
              <button type="button" className="section-drag-handle no-export" {...projectSectionHandleProps('projectRelease')}>⠿</button>
              <div className="dashboard-card-heading"><div><p className="eyebrow">Release & Milestone Readiness</p><h3>Jira Versions and Target Dates</h3><p>Shows Jira project version metadata. StatusDeck does not infer a release-readiness percentage unless issue-to-version completion data is available.</p></div></div>
              {projectView.versions.length ? (
                <div className="project-release-list">
                  {projectView.versions.map((version) => (
                    <div className={`project-release-row ${version.overdue && !version.released ? 'project-release-overdue' : ''}`} key={version.id}>
                      <div><strong>{version.name}</strong><span>{version.released ? 'Released' : version.overdue ? 'Release date passed' : 'Planned'}</span></div>
                      <div><span>Start</span><strong>{version.startDate ? formatDate(version.startDate) : '—'}</strong></div>
                      <div><span>Release</span><strong>{version.releaseDate ? formatDate(version.releaseDate) : 'Not set'}</strong></div>
                    </div>
                  ))}
                </div>
              ) : <div className="project-empty-strip"><strong>No Release/Version Data Available</strong><span>Jira returned no project versions to track.</span></div>}
            </section>

            <section className="dashboard-card content-card project-report-section" style={projectSectionStyle('projectTeams')}>
              <button type="button" className="section-drag-handle no-export" {...projectSectionHandleProps('projectTeams')}>⠿</button>
              <div className="dashboard-card-heading"><div><p className="eyebrow">Detailed Team / Board Health</p><h3>Supporting Board Metrics</h3><p>Raw team-level evidence supporting the executive assessment. Velocity is displayed per team rather than aggregated across boards.</p></div></div>
              <div className="table-wrapper project-team-table-wrapper">
                <table className="project-team-table">
                  <thead><tr><th>Board</th><th>Sprint</th><th>RAG</th><th>Progress</th><th>Scope</th><th>Completed</th><th>Open</th><th>Overdue</th><th>Defects</th><th>Velocity</th></tr></thead>
                  <tbody>
                    {projectView.teams.map((item) => {
                      const metrics = item.report?.metrics ?? {};
                      return (
                        <tr key={item.board.id}>
                          <td><strong>{item.board.name}</strong></td>
                          <td>{item.sprint?.name ?? 'No sprint'}</td>
                          <td><span className={`project-rag-badge project-rag-${String(item.rag.label).toLowerCase()}`}>{item.rag.label}</span></td>
                          <td>{item.completion}%</td>
                          <td>{formatNumber(metrics.committedStoryPoints ?? 0)} {item.report?.estimationSource?.unit ?? ''}</td>
                          <td>{formatNumber(metrics.completedStoryPoints ?? 0)}</td>
                          <td>{formatNumber(metrics.open ?? 0)}</td>
                          <td>{item.overdue}</td>
                          <td>{item.unresolvedDefects}</td>
                          <td>{formatNumber(item.velocity?.averageCompleted ?? 0)} {item.report?.estimationSource?.unit ?? ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <section className="dashboard-card methodology-note project-report-note">
            <strong>Project Reporting Methodology</strong>
            <p>StatusDeck evaluates each board against the configured RAG thresholds, then reports cross-team health and exceptions. Raw estimation units and velocity remain team-level signals; incompatible board estimation units are not combined into a single project velocity or productivity score.</p>
          </section>
        </section>
      ) : null}

      {report ? (
        <>
          <div className="report-layout report-layout-grid">
            <div className="report-main">
          <section className="report-header-card">
            <div>
              <p className="eyebrow">
                Sprint Status Report
              </p>

              <button
                type="button"
                className="text-link sprint-title-link"
                onClick={() =>
                  openSprintBoard(projectKey, boardId)
                }
                title="Open the sprint board in Jira"
              >
                {report.sprint.name}
                <span aria-hidden="true"> ↗</span>
              </button>

              <p>
                {report.sprint.goal ||
                  'No sprint goal has been entered.'}
              </p>
            </div>

            <div className="sprint-dates">
              <span>
                <strong>Start:</strong>{' '}
                {formatDate(report.sprint.startDate)}
              </span>

              <span>
                <strong>End:</strong>{' '}
                {formatDate(report.sprint.endDate)}
              </span>

              <span
                className={`state-pill ${report.sprint.state}`}
              >
                {report.sprint.state}
              </span>
            </div>
          </section>

          <SprintProgressStrip
            report={report}
            timing={sprintTiming}
            deliveryStatus={deliveryStatus}
            completionTone={completionTone}
            planningAssessment={planningAssessment}
            overallRag={overallRag}
            showDaysRemaining={reportingSettings.kpiProfile?.native?.daysRemaining !== false}
          />

          {customKpiResults.length ? (
            <CustomJiraInsightsSection
              results={customKpiResults}
              layoutProps={sectionProps('customJiraInsights', '')}
              handleProps={sectionHandleProps('customJiraInsights')}
            />
          ) : null}

          <section {...sectionProps('overview', 'executive-dashboard-overview')}>
            <span className="report-section-drag-handle no-export" aria-hidden="false" title="Move section" {...sectionHandleProps('overview')}>⠿</span>

            <div className="overview-card-canvas">
              <div className="overview-layout-item overview-span-12 executive-briefing-wrap">
                <ExecutiveBriefing report={report} readiness={readiness} overallRag={overallRag} deliveryStatus={deliveryStatus} settings={reportingSettings} />
              </div>
              <div className="overview-layout-item overview-span-12 statusdeck-movable-card" data-card-id="management-commentary" style={overviewCardStyle('management-commentary')}>
                <button type="button" className="statusdeck-card-drag-handle no-export" {...overviewHandleProps('management-commentary', 'Management Commentary')}>⠿</button>
                <ManagementSummary
                  report={report}
                  history={history}
                  effort={effort}
                  timing={sprintTiming}
                  readiness={readiness}
                  deliveryStatus={deliveryStatus}
                  planningAssessment={planningAssessment}
                  nextSprintOutlook={nextSprintOutlook}
                  velocityReport={velocityReport}
                  commentaryOverlay={commentaryOverlay}
                  commentaryText={commentaryText}
                  commentarySaving={commentarySaving}
                  commentaryNotice={commentaryNotice}
                  onCommentaryTextChange={setCommentaryText}
                  onSaveCommentary={saveCommentary}
                  onResetCommentary={resetCommentary}
                  settings={reportingSettings}
                  readOnly={presentationMode}
                  commentaryStale={commentaryStale}
                />
              </div>

              <div className="overview-layout-item overview-span-12 statusdeck-movable-card" data-card-id="sprint-health-core" style={overviewCardStyle('sprint-health-core')}>
                <button type="button" className="statusdeck-card-drag-handle no-export" {...overviewHandleProps('sprint-health-core', 'Sprint Health')}>⠿</button>
                <article className="dashboard-card sprint-health-core-card">
                  <div className="dashboard-card-heading">
                    <div>
                      <p className="eyebrow">
                        {report.sprint.state === 'future' ? 'Planning health' : 'Sprint health'}
                      </p>
                      <h3 className="heading-with-calculation-help">
                        <span>{report.sprint.state === 'future' ? 'Planning Readiness & Core KPIs' : 'Delivery Progress & Core KPIs'}</span>
                        {report.sprint.state !== 'future' ? (
                          <CalculationButton calculationKey="health" context={{ report, effort, readiness, settings: reportingSettings }} />
                        ) : null}
                      </h3>
                    </div>
                    <span className="dashboard-chip">{report.sprint.state}</span>
                  </div>

                  <div className="headline-metrics-grid sprint-health-kpi-grid">
                    {reportingSettings.kpiProfile?.native?.completion !== false ? <MetricCard
                      label={report.sprint.state === 'future' ? 'Planning Readiness' : 'Delivery Progress'}
                      tone={report.sprint.state === 'future' ? planningAssessment.tone : completionTone}
                      value={report.sprint.state === 'future' ? planningAssessment.score : report.metrics.storyPointCompletionPercentage}
                      formatter={(value) => `${formatNumber(value)}%`}
                      calculationKey={report.sprint.state === 'future' ? 'planningReadiness' : 'completion'}
                      calculationContext={{ report, effort, readiness, settings: reportingSettings }}
                      helper={report.sprint.state === 'future' ? `${report.metrics.total} planned items` : `${report.metrics.completed} of ${report.metrics.total} items completed`}
                      onClick={report.sprint.state === 'future' ? () => openJiraIssues(issueGroups.all) : () => openJiraIssues(issueGroups.completed)}
                    /> : null}

                    {reportingSettings.kpiProfile?.native?.completed !== false ? <MetricCard
                      label="Completed"
                      tone="positive"
                      value={report.storyPointField ? report.metrics.completedStoryPoints : report.metrics.completed}
                      helper={report.storyPointField ? `${report.metrics.completed} completed items` : 'Completed Work Items'}
                      onClick={() => openJiraIssues(issueGroups.completed)}
                    /> : null}

                    {reportingSettings.kpiProfile?.native?.remaining !== false ? <MetricCard
                      label="Remaining"
                      tone="warning"
                      value={report.storyPointField ? report.metrics.remainingStoryPoints : report.metrics.open}
                      helper={`${report.metrics.open} open items`}
                      onClick={() => openJiraIssues(issueGroups.open)}
                    /> : null}

                    {(reportingSettings.kpiProfile?.native?.overdue !== false || reportingSettings.kpiProfile?.native?.defects !== false) ? <MetricCard
                      label={report.sprint.state === 'future' ? 'Planning Gaps' : 'Delivery Risk'}
                      tone={report.sprint.state === 'future' ? planningAssessment.tone : deliveryRiskTone}
                      value={report.sprint.state === 'future' ? planningAssessment.unassignedItems + planningAssessment.unestimatedItems + planningAssessment.acceptanceCriteria.missingStories + (planningAssessment.hasSprintGoal ? 0 : 1) : report.metrics.overdue}
                      helper={report.sprint.state === 'future' ? `${planningAssessment.unassignedItems} unassigned · ${planningAssessment.unestimatedItems} unestimated · ${planningAssessment.acceptanceCriteria.missingStories} AC gaps` : `${readiness.openDefects ?? 0} unresolved defects · ${report.metrics.overdue} overdue`}
                      onClick={() => openJiraIssues(report.sprint.state === 'future' ? issueGroups.all : [...issueGroups.overdue, ...issueGroups.openDefects])}
                    /> : null}
                  </div>

                  <div className="progress-visual-layout sprint-health-progress-layout">
                    <ProgressRing
                      percentage={report.sprint.state === 'future' ? planningAssessment.score : report.metrics.storyPointCompletionPercentage}
                      label={report.sprint.state === 'future' ? 'Planning Ready' : 'Complete'}
                      value={report.sprint.state === 'future' ? `${formatNumber(report.metrics.committedStoryPoints)} planned ${getEstimationDisplay(report).short} · ${planningAssessment.velocityLoadLabel} of average velocity` : `${formatNumber(report.metrics.completedStoryPoints)} of ${formatNumber(report.metrics.committedStoryPoints)} ${getEstimationDisplay(report).noun}`}
                      tone={report.sprint.state === 'future' ? planningAssessment.tone : completionTone}
                    />
                    <DeliveryProgress metrics={report.metrics} />
                  </div>

                  {report.sprint.state === 'future' ? (
                    <div className="future-readiness-panel">
                      <div className="overview-subheading">
                        <div>
                          <p className="eyebrow">Definition of Ready Signals</p>
                          <h4 className="heading-with-calculation-help"><span>Future Sprint Readiness Checks</span><CalculationButton calculationKey="planningReadiness" context={{ report, effort, readiness, settings: reportingSettings }} /></h4>
                        </div>
                        <span className={`delivery-status-pill delivery-status-${planningAssessment.tone}`}>{planningAssessment.label}</span>
                      </div>
                      <div className="future-readiness-grid">
                        <div className={planningAssessment.hasSprintGoal ? 'future-readiness-check future-readiness-good' : 'future-readiness-check future-readiness-warning'}>
                          <span>Sprint Goal</span><strong>{planningAssessment.hasSprintGoal ? '✓ Present' : '! Missing'}</strong><small>Outcome for the Sprint</small>
                        </div>
                        <div className={planningAssessment.assignedCoveragePercentage >= 90 ? 'future-readiness-check future-readiness-good' : 'future-readiness-check future-readiness-warning'}>
                          <span>Assigned</span><strong>{planningAssessment.assignedCoveragePercentage}%</strong><small>{planningAssessment.unassignedItems} unassigned</small>
                        </div>
                        <div className={planningAssessment.estimatedCoveragePercentage >= 90 ? 'future-readiness-check future-readiness-good' : 'future-readiness-check future-readiness-warning'}>
                          <span>Estimated</span><strong>{planningAssessment.estimatedCoveragePercentage}%</strong><small>{planningAssessment.unestimatedItems} unestimated</small>
                        </div>
                        <div className={planningAssessment.acceptanceCriteria.eligibleStories === 0 ? 'future-readiness-check future-readiness-neutral' : planningAssessment.acceptanceCriteriaCoverage >= planningAssessment.minimumAcceptanceCriteriaCoverage ? 'future-readiness-check future-readiness-good' : 'future-readiness-check future-readiness-warning'}>
                          <span className="heading-with-calculation-help"><span>Acceptance Criteria</span><CalculationButton calculationKey="acceptanceCriteriaCoverage" context={{ report, effort, readiness, settings: reportingSettings }} /></span>
                          <strong>{planningAssessment.acceptanceCriteria.eligibleStories > 0 ? `${formatNumber(planningAssessment.acceptanceCriteriaCoverage)}%` : '—'}</strong>
                          <small>{planningAssessment.acceptanceCriteria.eligibleStories > 0 ? `${planningAssessment.acceptanceCriteria.detectedStories}/${planningAssessment.acceptanceCriteria.eligibleStories} Stories · ${planningAssessment.acceptanceCriteria.totalCriteria ?? 0} criteria` : 'No Stories to assess'}</small>
                        </div>
                        <div className={planningAssessment.velocityLoadPercentage > Number(reportingSettings.readiness?.maximumVelocityLoad ?? 115) ? 'future-readiness-check future-readiness-danger' : 'future-readiness-check future-readiness-good'}>
                          <span>Velocity Load</span><strong>{planningAssessment.velocityLoadLabel}</strong><small>vs recent completed average</small>
                        </div>
                      </div>
                      <AcceptanceCriteriaSummary
                        summary={planningAssessment.acceptanceCriteria}
                        calculationContext={{ report, effort, readiness, settings: reportingSettings }}
                        title="Acceptance Criteria Detail"
                      />
                      {planningAssessment.acceptanceCriteria.missingKeys.length ? (
                        <div className="future-ac-gaps">
                          <strong>Stories Needing Acceptance Criteria</strong>
                          <p>{planningAssessment.acceptanceCriteria.missingKeys.slice(0, 8).join(' · ')}{planningAssessment.acceptanceCriteria.missingKeys.length > 8 ? ` · +${planningAssessment.acceptanceCriteria.missingKeys.length - 8} more` : ''}</p>
                          <button type="button" className="text-link" onClick={() => openJiraIssues(planningAssessment.acceptanceCriteria.missingKeys)}>Open Flagged Stories in Jira</button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {history?.available && report.sprint.state !== 'future' ? (
                    <div className="sprint-health-burndown">
                      <div className="overview-subheading">
                        <div>
                          <p className="eyebrow">Live Burndown</p>
                          <h4>Live / Intraday Jira-Event Trajectory</h4>
                        </div>
                        <span className="dashboard-chip">Live Events</span>
                      </div>
                      <BurndownChart
                        points={compactLiveBurndownPoints}
                        basis={getEstimationDisplay(report).short === 'hours' ? 'effort' : 'points'}
                        view="live"
                        sprintEndDate={report.sprint.endDate}
                        provisional={false}
                        coveragePercentage={100}
                      />
                    </div>
                  ) : null}

                  {report.sprint.state !== 'future' ? (
                    <AcceptanceCriteriaSummary
                      summary={report.metrics?.acceptanceCriteria}
                      calculationContext={{ report, effort, readiness, settings: reportingSettings }}
                      title="Acceptance Criteria Completion"
                    />
                  ) : null}

                  <div className="secondary-metrics-strip sprint-health-secondary-strip">
                    <button type="button" onClick={() => openJiraIssues(issueGroups.all)}>
                      <span>Scope</span>
                      <strong>{formatNumber(report.metrics.committedStoryPoints)}</strong>
                      <small>{getEstimationDisplay(report).short}</small>
                    </button>
                    <button type="button" onClick={() => openJiraIssues(issueGroups.completed)}>
                      <span>Completed</span>
                      <strong>{report.metrics.completed}</strong>
                      <small>work items</small>
                    </button>
                    <button type="button" onClick={() => openJiraIssues(issueGroups.open)}>
                      <span>Open</span>
                      <strong>{report.metrics.open}</strong>
                      <small>work items</small>
                    </button>
                    <button type="button" onClick={() => openJiraIssues(issueGroups.defects)}>
                      <span>Defects</span>
                      <strong>{report.metrics.defects}</strong>
                      <small>current scope</small>
                    </button>
                    <button type="button" onClick={() => openJiraIssues(issueGroups.overdue)}>
                      <span>Overdue</span>
                      <strong>{report.metrics.overdue}</strong>
                      <small>open items</small>
                    </button>
                  </div>
                </article>
              </div>

              <div className="overview-layout-item overview-span-6 statusdeck-movable-card" data-card-id="risk-profile" style={overviewCardStyle('risk-profile')}>
                <button type="button" className="statusdeck-card-drag-handle no-export" {...overviewHandleProps('risk-profile', 'Risk Profile')}>⠿</button>
                <article className="dashboard-card priority-dashboard-card">
                  <div className="dashboard-card-heading">
                    <div>
                      <p className="eyebrow">Risk Profile</p>
                      <h3>Issues by Priority</h3>
                    </div>
                    <span className="dashboard-chip">
                      {Object.values(priorityCounts).reduce((sum, count) => sum + count, 0)} items
                    </span>
                  </div>
                  <PriorityDonut issues={displayedIssues} />
                </article>
              </div>

              <div className="overview-layout-item overview-span-6 statusdeck-movable-card" data-card-id="scope-health" style={overviewCardStyle('scope-health')}>
                <button type="button" className="statusdeck-card-drag-handle no-export" {...overviewHandleProps('scope-health', 'Scope Health')}>⠿</button>
                <article className="dashboard-card scope-dashboard-card">
                  <div className="dashboard-card-heading">
                    <div>
                      <p className="eyebrow">Scope Health</p>
                      <h3 className="heading-with-calculation-help"><span>Sprint Scope Movement</span><CalculationButton calculationKey="scopeCurrent" context={{ report, effort, readiness, settings: reportingSettings }} /></h3>
                    </div>
                    <button
                      type="button"
                      className="dashboard-link-button"
                      onClick={() => setVisibleSections((current) => ({ ...current, scopeHistory: true }))}
                    >
                      Details
                    </button>
                  </div>
                  <ScopeMovementVisual history={history} estimationDisplay={getEstimationDisplay(report)} />
                </article>
              </div>

              <div className="overview-layout-item overview-span-6 statusdeck-movable-card" data-card-id="work-distribution" style={overviewCardStyle('work-distribution')}>
                <button type="button" className="statusdeck-card-drag-handle no-export" {...overviewHandleProps('work-distribution', 'Work Distribution')}>⠿</button>
                <article className="dashboard-card dashboard-card-status">
                  <div className="dashboard-card-heading">
                    <div>
                      <p className="eyebrow">Work Distribution</p>
                      <h3>Issues by Status</h3>
                    </div>
                    <button
                      type="button"
                      className="dashboard-link-button"
                      onClick={() => setVisibleSections((current) => ({ ...current, statusTypes: true }))}
                    >
                      Details
                    </button>
                  </div>
                  <StatusDonut statusCounts={report.metrics.statusCounts} total={report.metrics.total} />
                </article>
              </div>

              <div className="overview-layout-item overview-span-6 statusdeck-movable-card" data-card-id="capacity-view" style={overviewCardStyle('capacity-view')}>
                <button type="button" className="statusdeck-card-drag-handle no-export" {...overviewHandleProps('capacity-view', 'Capacity View')}>⠿</button>
                <article className="dashboard-card workload-dashboard-card">
                  <div className="dashboard-card-heading">
                    <div>
                      <p className="eyebrow">Capacity View</p>
                      <h3>Forward Workload by Assignee</h3>
                    </div>
                    <button
                      type="button"
                      className="dashboard-link-button"
                      onClick={() => setVisibleSections((current) => ({ ...current, teamWorkload: true }))}
                    >
                      Full Table
                    </button>
                  </div>
                  <TeamWorkloadBars workload={workloadWithIssueKeys} />
                </article>
              </div>

              {velocityReport ? (
                <div className="overview-layout-item overview-span-6 statusdeck-movable-card" data-card-id="velocity-summary" style={overviewCardStyle('velocity-summary')}>
                <button type="button" className="statusdeck-card-drag-handle no-export" {...overviewHandleProps('velocity-summary', 'Velocity')}>⠿</button>
                  <article className="dashboard-card velocity-summary-card">
                    <div className="dashboard-card-heading">
                      <div>
                        <p className="eyebrow">Velocity</p>
                        <h3>Recent Delivery Trend</h3>
                      </div>
                      <span className="dashboard-chip">
                        Avg {velocityReport.averageCompleted} {velocityReport.usesStoryPoints ? 'pts' : 'items'}
                      </span>
                    </div>

                    {velocityReport.velocity.length === 0 ? (
                      <div className="empty-inline">Velocity will appear after this board has closed sprints.</div>
                    ) : (
                      <div className="velocity-chart velocity-chart-compact">
                        {velocityReport.velocity.slice(-3).map((item) => {
                          const committed = velocityReport.usesStoryPoints ? item.committedStoryPoints : item.totalItems;
                          const completed = velocityReport.usesStoryPoints ? item.completedStoryPoints : item.completedItems;
                          const maxValue = Math.max(committed, completed, 1);
                          const committedWidth = Math.round((committed / maxValue) * 100);
                          const completedWidth = Math.round((completed / maxValue) * 100);

                          return (
                            <div className="velocity-row" key={`overview-${item.sprintId}`}>
                              <div className="velocity-name">
                                <strong>{item.sprintName}</strong>
                                <span>{formatDate(item.endDate)}</span>
                              </div>
                              <div className="velocity-bars">
                                <div className="velocity-line">
                                  <span>Committed</span>
                                  <div className="bar-track"><div className="bar committed" style={{ width: `${committedWidth}%` }} /></div>
                                  <strong>{committed}</strong>
                                </div>
                                <div className="velocity-line">
                                  <span>Completed</span>
                                  <div className="bar-track"><div className="bar completed" style={{ width: `${completedWidth}%` }} /></div>
                                  <strong>{completed}</strong>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </article>
                </div>
              ) : null}

              <div className="overview-layout-item overview-span-6 statusdeck-movable-card" data-card-id="return-to-green" style={overviewCardStyle('return-to-green')}>
                <button type="button" className="statusdeck-card-drag-handle no-export" {...overviewHandleProps('return-to-green', 'Return to Green')}>⠿</button>
                <article className="dashboard-card return-to-green-card">
                  <div className="dashboard-card-heading">
                    <div>
                      <p className="eyebrow">Recovery Planning</p>
                      <h3>Return to Green</h3>
                    </div>
                    <span className={`delivery-status-pill delivery-status-${deliveryStatus.tone}`}>
                      {returnToGreen.length ? `${returnToGreen.length} action${returnToGreen.length === 1 ? '' : 's'}` : 'No immediate action'}
                    </span>
                  </div>
                  {returnToGreen.length ? (
                    <div className="return-to-green-commentary">
                      {returnToGreen.map((item, index) => (
                        <p key={`${item.priority}-${index}`}>
                          <strong>{item.priority}:</strong> {item.text}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p>Current Jira data and configured thresholds do not indicate an immediate recovery action.</p>
                  )}
                </article>
              </div>
            </div>
          </section>

          <TraceabilitySection
            report={report}
            settings={reportingSettings}
            layoutProps={sectionProps('traceability', '')}
            handleProps={sectionHandleProps('traceability')}
          />

{effort ? (
            <section {...sectionProps('effort', 'dashboard-card content-card effort-section executive-section-card')}>
              <span className="report-section-drag-handle no-export" aria-hidden="false" title="Move section" {...sectionHandleProps('effort')}>⠿</span>
              <div className="section-heading">
                <div>
                  <h3>
                    Effort Estimate and Variance
                  </h3>

                  <p>
                    Jira Original Estimate, Time Spent and
                    Remaining Estimate normalised to hours.
                  </p>
                </div>
              </div>

              {effort.forecastProvisional ? (
                <div className="warning-banner">
                  Remaining estimates are incomplete. Forecast
                  effort and variance are provisional and may be
                  understated.
                </div>
              ) : null}

              <div className="coverage-grid">
                <div className="coverage-item">
                  <span className="coverage-label-with-help"><span>Original Estimate Coverage</span><CalculationButton calculationKey="originalCoverage" context={{ report, effort, readiness, settings: reportingSettings }} /></span>
                  <strong>
                    {effort.coverage
                      ?.originalEstimateCoveredItems ?? 0}
                    {' / '}
                    {effort.coverage?.totalItems ?? 0}
                    {' · '}
                    {formatNumber(
                      effort.coverage
                        ?.originalEstimateCoveragePercentage
                    )}
                    %
                  </strong>
                </div>

                <div className="coverage-item">
                  <span className="coverage-label-with-help"><span>Remaining Estimate Coverage</span><CalculationButton calculationKey="remainingCoverage" context={{ report, effort, readiness, settings: reportingSettings }} /></span>
                  <strong>
                    {effort.coverage
                      ?.remainingEstimateCoveredItems ?? 0}
                    {' / '}
                    {effort.coverage
                      ?.remainingEstimateEligibleItems ?? 0}
                    {' · '}
                    {formatNumber(
                      effort.coverage
                        ?.remainingEstimateCoveragePercentage
                    )}
                    %
                  </strong>
                </div>

                <div className="coverage-item">
                  <span className="coverage-label-with-help"><span>Time-Spent Coverage</span><CalculationButton calculationKey="spentCoverage" context={{ report, effort, readiness, settings: reportingSettings }} /></span>
                  <strong>
                    {effort.coverage
                      ?.timeSpentCoveredItems ?? 0}
                    {' / '}
                    {effort.coverage?.totalItems ?? 0}
                    {' · '}
                    {formatNumber(
                      effort.coverage
                        ?.timeSpentCoveragePercentage
                    )}
                    %
                  </strong>
                </div>
              </div>

              <div className="history-metric-grid">
                <MetricCard
                  label="Original Estimate"
                  value={
                    effort.originalEstimateHours
                  }
                  formatter={formatHours}
                  onClick={() =>
                    openJiraIssues(
                      issueGroups.all
                    )
                  }
                />

                <MetricCard
                  label="Time Spent"
                  value={
                    effort.timeSpentHours
                  }
                  formatter={formatHours}
                  helper={`${formatNumber(
                    effort.burnedPercentage
                  )}% of original`}
                  onClick={() =>
                    openJiraIssues(
                      issueGroups.all
                    )
                  }
                />

                <MetricCard
                  label="Remaining Estimate"
                  calculationKey="remaining"
                  calculationContext={{ report, effort, readiness, settings: reportingSettings }}
                  value={
                    effort.remainingEstimateHours
                  }
                  formatter={formatHours}
                  helper={
                    effort.forecastProvisional && effort.provisionalGapHours > 0
                      ? `Jira value · ${formatHours(effort.inferredRemainingHours)} provisional balance from Original − Spent`
                      : `${formatNumber(effort.remainingPercentage)}% of original`
                  }
                  onClick={() =>
                    openJiraIssues(
                      issueGroups.open
                    )
                  }
                />

                <MetricCard
                  label={
                    effort.forecastProvisional
                      ? 'Forecast Effort · Provisional'
                      : 'Forecast Effort'
                  }
                  calculationKey="forecast"
                  calculationContext={{ report, effort, readiness, settings: reportingSettings }}
                  value={
                    effort.forecastHours
                  }
                  formatter={formatHours}
                  helper="Time spent + remaining"
                  tone={
                    effort.forecastProvisional
                      ? 'warning'
                      : 'default'
                  }
                />

                <MetricCard
                  label={
                    effort.forecastProvisional
                      ? 'Effort Variance · Provisional'
                      : 'Effort Variance'
                  }
                  calculationKey="variance"
                  calculationContext={{ report, effort, readiness, settings: reportingSettings }}
                  value={
                    effort.varianceHours
                  }
                  formatter={formatHours}
                  helper={`${formatNumber(
                    effort.variancePercentage
                  )}%`}
                  tone={
                    effort.forecastProvisional
                      ? 'warning'
                      : Number(
                            effort.varianceHours
                          ) > 0
                        ? 'negative'
                        : Number(
                              effort.varianceHours
                            ) < 0
                          ? 'positive'
                          : 'default'
                  }
                />
              </div>
            </section>
          ) : null}

          {history ? (
            <section {...sectionProps('scopeHistory', 'dashboard-card content-card history-section executive-section-card')}>
              <span className="report-section-drag-handle no-export" aria-hidden="false" title="Move section" {...sectionHandleProps('scopeHistory')}>⠿</span>
              <div className="section-heading">
                <div>
                  <h3>Sprint Scope History</h3>

                  <p>
                    Original commitment and scope changes
                    reconstructed from Jira issue history.
                  </p>
                </div>

                {history.calculatedAt ? (
                  <span className="calculated-at">
                    Calculated {formatDate(history.calculatedAt)}
                  </span>
                ) : null}
              </div>

              {!history.available ? (
                <div className="warning-banner">
                  {history.reason ||
                    'Sprint history is not available.'}
                </div>
              ) : (
                <>
                  {history.warnings?.map((warning) => (
                    <div
                      className="warning-banner"
                      key={warning}
                    >
                      {warning}
                    </div>
                  ))}

                  <div className="history-metric-grid">
                    <MetricCard
                      label="Original committed items"
                      value={
                        history.originalCommitment.items
                      }
                      helper="At sprint start"
                    />

                    <MetricCard
                      label="Original Committed Points"
                      value={
                        history.originalCommitment.storyPoints
                      }
                      helper="At sprint start"
                    />

                    <MetricCard
                      label="Current Scope Items"
                      value={history.currentScope.items}
                      onClick={() =>
                        openJiraIssues(issueGroups.all)
                      }
                    />

                    <MetricCard
                      label="Current Scope Points"
                      calculationKey="scopeCurrent"
                      calculationContext={{ report, effort, readiness, settings: reportingSettings }}
                      value={
                        history.currentScope.storyPoints
                      }
                      onClick={() =>
                        openJiraIssues(issueGroups.all)
                      }
                    />

                    <MetricCard
                      label="Items added"
                      value={
                        history.scopeChange.addedItems
                      }
                      helper={`${formatNumber(
                        history.scopeChange
                          .addedStoryPoints
                      )} points`}
                      onClick={
                        historyAddedKeys.length > 0
                          ? () =>
                              openJiraIssues(
                                historyAddedKeys
                              )
                          : undefined
                      }
                      tone="positive"
                    />

                    <MetricCard
                      label="Items removed"
                      value={
                        history.scopeChange.removedItems
                      }
                      helper={`${formatNumber(
                        history.scopeChange
                          .removedStoryPoints
                      )} points`}
                      onClick={
                        historyRemovedKeys.length > 0
                          ? () =>
                              openJiraIssues(
                                historyRemovedKeys
                              )
                          : undefined
                      }
                      tone="negative"
                    />

                    <MetricCard
                      label="Estimate Change"
                      calculationKey="scopeEstimateChange"
                      calculationContext={{ report, effort, readiness, settings: reportingSettings }}
                      value={
                        history.scopeChange
                          .estimateChangeStoryPoints
                      }
                      helper="Net point change"
                      tone={
                        Number(
                          history.scopeChange
                            .estimateChangeStoryPoints
                        ) > 0
                          ? 'warning'
                          : 'default'
                      }
                    />

                    <MetricCard
                      label="Current Completed Points"
                      value={
                        history.currentScope
                          .completedStoryPoints
                      }
                      onClick={() =>
                        openJiraIssues(
                          issueGroups.completed
                        )
                      }
                    />

                    <MetricCard
                      label="Current Remaining Points"
                      value={
                        history.currentScope
                          .remainingStoryPoints
                      }
                      onClick={() =>
                        openJiraIssues(issueGroups.open)
                      }
                    />

                    <MetricCard
                      label="Original Effort at Sprint Start"
                      value={
                        history.originalCommitment
                          .originalEstimateHours
                      }
                      formatter={formatHours}
                      helper="At sprint start"
                    />

                    <MetricCard
                      label="Current Original Estimate"
                      value={
                        history.currentScope
                          .originalEstimateHours
                      }
                      formatter={formatHours}
                      onClick={() =>
                        openJiraIssues(
                          issueGroups.all
                        )
                      }
                    />

                    <MetricCard
                      label="Current Remaining Estimate"
                      calculationKey="remaining"
                      calculationContext={{ report, effort, readiness, settings: reportingSettings }}
                      value={
                        history.currentScope
                          .remainingEstimateHours
                      }
                      formatter={formatHours}
                      onClick={() =>
                        openJiraIssues(
                          issueGroups.open
                        )
                      }
                    />

                    <MetricCard
                      label="Current time spent"
                      value={
                        history.currentScope
                          .timeSpentHours
                      }
                      formatter={formatHours}
                    />

                    <MetricCard
                      label={
                        effort?.forecastProvisional
                          ? 'Forecast Effort · Provisional'
                          : 'Forecast Effort'
                      }
                      calculationKey="forecast"
                      calculationContext={{ report, effort, readiness, settings: reportingSettings }}
                      value={
                        history.currentScope
                          .forecastHours
                      }
                      formatter={formatHours}
                      tone={
                        effort?.forecastProvisional
                          ? 'warning'
                          : 'default'
                      }
                    />

                    <MetricCard
                      label={
                        effort?.forecastProvisional
                          ? 'Effort Variance · Provisional'
                          : 'Effort Variance'
                      }
                      calculationKey="variance"
                      calculationContext={{ report, effort, readiness, settings: reportingSettings }}
                      value={
                        history.currentScope
                          .varianceHours
                      }
                      formatter={formatHours}
                      helper={`${formatNumber(
                        history.currentScope
                          .variancePercentage
                      )}%`}
                      tone={
                        effort?.forecastProvisional
                          ? 'warning'
                          : Number(
                                history.currentScope
                                  .varianceHours
                              ) > 0
                            ? 'negative'
                            : Number(
                                  history.currentScope
                                    .varianceHours
                                ) < 0
                              ? 'positive'
                              : 'default'
                      }
                    />

                    <MetricCard
                      label="Original Estimate Change"
                      value={
                        history.scopeChange
                          .originalEstimateChangeHours
                      }
                      formatter={formatHours}
                      helper="Net in-sprint revision"
                      tone="warning"
                    />

                    <MetricCard
                      label="Remaining Estimate Change"
                      value={
                        history.scopeChange
                          .remainingEstimateChangeHours
                      }
                      formatter={formatHours}
                      helper="Net in-sprint revision"
                      tone="warning"
                    />

                    <MetricCard
                      label="Time Logged"
                      value={
                        history.scopeChange
                          .timeLoggedHours
                      }
                      formatter={formatHours}
                    />
                  </div>
                </>
              )}
            </section>
          ) : null}

          {history?.available ? (
            <section {...sectionProps('burndown', 'dashboard-card content-card burndown-section executive-section-card')}>
              <span className="report-section-drag-handle no-export" aria-hidden="false" title="Move section" {...sectionHandleProps('burndown')}>⠿</span>
              <div className="section-heading burndown-heading">
                <div>
                  <h3>Detailed Sprint Burndown</h3>

                  <p>
                    Daily shows the full sprint trajectory. Live events
                    shows same-day scope, estimate, completion
                    and reopening changes immediately.
                  </p>
                </div>

                <div className="toggle-group">
                  <div className="segmented-control">
                    <button
                      type="button"
                      className={
                        burndownBasis === 'points'
                          ? 'active'
                          : ''
                      }
                      onClick={() =>
                        setBurndownBasis(
                          'points'
                        )
                      }
                    >
                      Story Points
                    </button>

                    <button
                      type="button"
                      className={
                        burndownBasis === 'effort'
                          ? 'active'
                          : ''
                      }
                      onClick={() =>
                        setBurndownBasis(
                          'effort'
                        )
                      }
                    >
                      Remaining Effort
                    </button>
                  </div>

                  <div className="segmented-control">
                    <button
                      type="button"
                      className={
                        burndownView === 'daily'
                          ? 'active'
                          : ''
                      }
                      onClick={() =>
                        setBurndownView(
                          'daily'
                        )
                      }
                    >
                      Daily
                    </button>

                    <button
                      type="button"
                      className={
                        burndownView === 'live'
                          ? 'active'
                          : ''
                      }
                      onClick={() =>
                        setBurndownView(
                          'live'
                        )
                      }
                    >
                      Live Events
                    </button>
                  </div>
                </div>
              </div>

              <BurndownChart
                points={burndownPoints}
                basis={burndownBasis}
                view={burndownView}
                sprintEndDate={report.sprint.endDate}
                provisional={
                  Boolean(effort?.forecastProvisional)
                }
                coveragePercentage={
                  effort?.coverage
                    ?.remainingEstimateCoveragePercentage ?? 100
                }
              />
            </section>
          ) : null}

          {history?.available ? (
            <section {...sectionProps('changeLog', 'dashboard-card content-card change-log-section')}>
              <span className="report-section-drag-handle no-export" aria-hidden="false" title="Move section" {...sectionHandleProps('changeLog')}>⠿</span>
              <div className="section-heading">
                <div>
                  <h3>Scope, Estimate and Effort Changes</h3>

                  <p>
                    Latest sprint scope, estimate, effort and status changes detected from Jira history.
                  </p>
                </div>
              </div>

              <details className="dashboard-details">
                <summary>
                  View Latest Jira History Changes
                </summary>
                <HistoryEventsTable
                  events={history.events}
                />
              </details>
            </section>
          ) : null}

          <section {...sectionProps('statusTypes', 'two-column-grid status-type-grid')}>
            <span className="report-section-drag-handle no-export" aria-hidden="false" title="Move section" {...sectionHandleProps('statusTypes')}>⠿</span>
            <article className="content-card">
              <h3>Status Distribution</h3>

              <div className="status-list">
                {Object.entries(
                  report.metrics.statusCounts
                ).map(([status, count]) => {
                  const statusKeys = displayedIssues
                    .filter(
                      (issue) =>
                        issue.status === status
                    )
                    .map((issue) => issue.key);

                  return (
                    <button
                      type="button"
                      className={`status-row status-row-button semantic-card-${getSemanticTone(status)}`}
                      key={status}
                      onClick={() =>
                        openJiraIssues(statusKeys)
                      }
                    >
                      <span>{status}</span>
                      <strong>{count}</strong>
                    </button>
                  );
                })}
              </div>
            </article>

            <article className="content-card">
              <h3>Work-Item Types</h3>

              <div className="status-list">
                {Object.entries(
                  report.metrics.typeCounts
                ).map(([type, count]) => {
                  const typeKeys = displayedIssues
                    .filter(
                      (issue) =>
                        issue.issueType === type
                    )
                    .map((issue) => issue.key);

                  return (
                    <button
                      type="button"
                      className={`status-row status-row-button semantic-card-${getSemanticTone(type)}`}
                      key={type}
                      onClick={() =>
                        openJiraIssues(typeKeys)
                      }
                    >
                      <span>{type}</span>
                      <strong>{count}</strong>
                    </button>
                  );
                })}
              </div>
            </article>
          </section>

          <section {...sectionProps('sprintReport', 'dashboard-card content-card sprint-report-section executive-section-card')}>
            <span className="report-section-drag-handle no-export" aria-hidden="false" title="Move section" {...sectionHandleProps('sprintReport')}>⠿</span>
            <div className="section-heading">
              <div>
                <h3>Sprint Report</h3>

                <p>
                  Select a value to open the corresponding
                  Jira work items.
                </p>
              </div>
            </div>

            <div className="sprint-report-summary">
              <MetricCard
                label="Completed Items"
                value={
                  report.sprintReport.completedCount
                }
                onClick={() =>
                  openJiraIssues(
                    report.sprintReport.completedIssues.map(
                      (issue) => issue.key
                    )
                  )
                }
              />

              <MetricCard
                label="Incomplete Items"
                value={
                  report.sprintReport.incompleteCount
                }
                onClick={() =>
                  openJiraIssues(
                    report.sprintReport.incompleteIssues.map(
                      (issue) => issue.key
                    )
                  )
                }
              />

              {report.storyPointField ? (
                <>
                  <MetricCard
                    label={`Completed ${getEstimationDisplay(report).short}`}
                    value={
                      report.sprintReport
                        .completedStoryPoints
                    }
                    onClick={() =>
                      openJiraIssues(
                        report.sprintReport.completedIssues.map(
                          (issue) => issue.key
                        )
                      )
                    }
                  />

                  <MetricCard
                    label={`Incomplete ${getEstimationDisplay(report).short}`}
                    value={
                      report.sprintReport
                        .incompleteStoryPoints
                    }
                    onClick={() =>
                      openJiraIssues(
                        report.sprintReport.incompleteIssues.map(
                          (issue) => issue.key
                        )
                      )
                    }
                  />
                </>
              ) : null}
            </div>
          </section>

          {velocityReport ? (
            <section {...sectionProps('velocity', `dashboard-card content-card velocity-section executive-section-card ${activeReportPreset === 'executive' ? 'executive-detail-duplicate' : ''}`)}>
              <span className="report-section-drag-handle no-export" aria-hidden="false" title="Move section" {...sectionHandleProps('velocity')}>⠿</span>
              <div className="section-heading">
                <div>
                  <h3 className="heading-with-calculation-help"><span>Velocity</span><CalculationButton calculationKey="velocity" context={{ report, effort, readiness, settings: reportingSettings }} /></h3>

                  <p>
                    Recent closed sprints · Average
                    completed:{' '}
                    <strong>
                      {velocityReport.averageCompleted}
                    </strong>{' '}
                    {velocityReport.usesStoryPoints
                      ? getEstimationDisplay(report).noun
                      : 'work items'}
                  </p>
                </div>
              </div>

              {velocityReport.velocity.length === 0 ? (
                <div className="empty-inline">
                  Velocity will appear after this board has
                  closed sprints.
                </div>
              ) : (
                <div className="velocity-chart">
                  {velocityReport.velocity.map((item) => {
                    const committed =
                      velocityReport.usesStoryPoints
                        ? item.committedStoryPoints
                        : item.totalItems;

                    const completed =
                      velocityReport.usesStoryPoints
                        ? item.completedStoryPoints
                        : item.completedItems;

                    const maxValue = Math.max(
                      committed,
                      completed,
                      1
                    );

                    const committedWidth = Math.round(
                      (committed / maxValue) * 100
                    );

                    const completedWidth = Math.round(
                      (completed / maxValue) * 100
                    );

                    return (
                      <div
                        className="velocity-row"
                        key={item.sprintId}
                      >
                        <div className="velocity-name">
                          <strong>
                            {item.sprintName}
                          </strong>

                          <span>
                            {formatDate(item.endDate)}
                          </span>
                        </div>

                        <div className="velocity-bars">
                          <div className="velocity-line">
                            <span>Committed</span>

                            <div className="bar-track">
                              <div
                                className="bar committed"
                                style={{
                                  width: `${committedWidth}%`,
                                }}
                              />
                            </div>

                            <strong>{committed}</strong>
                          </div>

                          <div className="velocity-line">
                            <span>Completed</span>

                            <div className="bar-track">
                              <div
                                className="bar completed"
                                style={{
                                  width: `${completedWidth}%`,
                                }}
                              />
                            </div>

                            <strong>{completed}</strong>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}

          <section {...sectionProps('teamWorkload', 'dashboard-card content-card team-workload-section')}>
            <span className="report-section-drag-handle no-export" aria-hidden="false" title="Move section" {...sectionHandleProps('teamWorkload')}>⠿</span>
            <div className="section-heading">
              <div>
                <h3>Team Workload</h3>

                <p>
                  Select a name or number to open matching
                  Jira work items.
                </p>
              </div>
            </div>

            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Assignee</th>
                    <th>Total</th>
                    <th>Open</th>
                    <th>Completed</th>
                    <th>{getEstimationDisplay(report).noun}</th>
                    <th>Remaining {getEstimationDisplay(report).short}</th>
                    <th>Original Estimate</th>
                    <th>Time Spent</th>
                    <th>Remaining Estimate</th>
                    <th>Forecast Effort</th>
                    <th>Overdue</th>
                  </tr>
                </thead>

                <tbody>
                  {report.metrics.workload.map((person) => (
                    <tr key={person.name}>
                      <td>
                        <button
                          type="button"
                          className="table-link"
                          onClick={() =>
                            openJiraIssues(
                              getAssigneeIssues(
                                person.name
                              )
                            )
                          }
                        >
                          {person.name}
                        </button>
                      </td>

                      <td>
                        <button
                          type="button"
                          className="table-number-link"
                          onClick={() =>
                            openJiraIssues(
                              getAssigneeIssues(
                                person.name
                              )
                            )
                          }
                        >
                          {person.total}
                        </button>
                      </td>

                      <td>
                        <button
                          type="button"
                          className="table-number-link"
                          onClick={() =>
                            openJiraIssues(
                              getAssigneeIssues(
                                person.name,
                                (issue) =>
                                  issue.statusCategoryKey !==
                                  'done'
                              )
                            )
                          }
                        >
                          {person.open}
                        </button>
                      </td>

                      <td>
                        <button
                          type="button"
                          className="table-number-link"
                          onClick={() =>
                            openJiraIssues(
                              getAssigneeIssues(
                                person.name,
                                (issue) =>
                                  issue.statusCategoryKey ===
                                  'done'
                              )
                            )
                          }
                        >
                          {person.completed}
                        </button>
                      </td>

                      <td>
                        <button
                          type="button"
                          className="table-number-link"
                          onClick={() =>
                            openJiraIssues(
                              getAssigneeIssues(
                                person.name
                              )
                            )
                          }
                        >
                          {person.storyPoints}
                        </button>
                      </td>

                      <td>
                        <button
                          type="button"
                          className="table-number-link"
                          onClick={() =>
                            openJiraIssues(
                              getAssigneeIssues(
                                person.name,
                                (issue) =>
                                  issue.statusCategoryKey !==
                                  'done'
                              )
                            )
                          }
                        >
                          {person.remainingStoryPoints}
                        </button>
                      </td>

                      <td>
                        {formatHours(
                          person.originalEstimateHours
                        )}
                      </td>

                      <td>
                        {formatHours(
                          person.timeSpentHours
                        )}
                      </td>

                      <td>
                        {formatHours(
                          person.remainingEstimateHours
                        )}
                      </td>

                      <td>
                        {formatHours(
                          person.forecastHours
                        )}
                      </td>

                      <td>
                        <button
                          type="button"
                          className="table-number-link"
                          onClick={() =>
                            openJiraIssues(
                              getAssigneeIssues(
                                person.name,
                                (issue) =>
                                  issue.daysOverdue > 0
                              )
                            )
                          }
                        >
                          {person.overdue}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section {...sectionProps('workItems', 'dashboard-card content-card work-items-section')}>
            <span className="report-section-drag-handle no-export" aria-hidden="false" title="Move section" {...sectionHandleProps('workItems')}>⠿</span>
            <div className="section-heading">
              <div>
                <h3>Sprint Work Items</h3>

                <p>
                  Select an issue key to open it in Jira.
                </p>
              </div>
            </div>

            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Summary</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Story Points</th>
                    <th>Original Estimate</th>
                    <th>Time Spent</th>
                    <th>Remaining Estimate</th>
                    <th>Forecast Effort</th>
                    <th>Assignee</th>
                    <th>Due Date</th>
                    <th>Overdue</th>
                  </tr>
                </thead>

                <tbody>
                  {displayedIssues.map((issue) => (
                    <tr key={issue.id}>
                      <td className="key-cell">
                        <button
                          type="button"
                          className="issue-key-link"
                          onClick={() =>
                            openJiraIssue(issue.key)
                          }
                          title={`Open ${issue.key} in Jira`}
                        >
                          {issue.key}
                          <span aria-hidden="true">
                            {' '}
                            ↗
                          </span>
                        </button>
                      </td>

                      <td>{issue.summary}</td>

                      <td>
                        {issue.issueType}

                        {issue.isSubtask ? (
                          <span className="subtask-badge">
                            Subtask
                          </span>
                        ) : null}
                      </td>

                      <td>{issue.status}</td>
                      <td>{issue.storyPoints}</td>
                      <td>
                        {formatHours(
                          issue.originalEstimateHours
                        )}
                      </td>
                      <td>
                        {formatHours(
                          issue.timeSpentHours
                        )}
                      </td>
                      <td>
                        {formatHours(
                          issue.remainingEstimateHours
                        )}
                      </td>
                      <td>
                        {formatHours(
                          issue.forecastHours
                        )}
                      </td>
                      <td>{issue.assignee}</td>
                      <td>{formatDate(issue.dueDate)}</td>

                      <td>
                        {issue.daysOverdue > 0
                          ? `${issue.daysOverdue} days`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
            </div>
          </div>
        </>
      ) : !projectReport ? (
        <section className="empty-state">
          <h2>
            Your Report Preview Will Appear Here
          </h2>

          <p>
            Select a project, board and sprint, then choose
            Load report.
          </p>
        </section>
      ) : null}
    </main>
  );
}


function getModuleType(context) {
  return String(
    context?.extension?.type ??
    context?.moduleType ??
    ''
  );
}

function StatusDeckDashboardGadget({ context }) {
  const [opening, setOpening] = useState(false);
  const projectKey =
    context?.extension?.project?.key ??
    context?.platformContext?.projectKey ??
    '';

  async function openStatusDeck() {
    try {
      setOpening(true);
      await router.navigate({
        target: 'module',
        moduleKey: projectKey
          ? 'statusdeck-project-page'
          : 'statusdeck-global-page',
        ...(projectKey ? { projectKey } : {}),
      });
    } catch (caughtError) {
      console.error('Unable to open StatusDeck', caughtError);
      setOpening(false);
    }
  }

  return (
    <main className="statusdeck-entry-surface statusdeck-gadget-surface">
      <p className="statusdeck-entry-kicker">Executive Sprint Reporting</p>
      <h2>StatusDeck</h2>
      <p>Create management-ready Jira sprint reports, PowerPoint decks and PDFs directly from Jira.</p>
      <button type="button" className="primary-button" onClick={openStatusDeck} disabled={opening}>
        {opening ? 'Opening…' : 'Open StatusDeck'}
      </button>
    </main>
  );
}

function App() {
  const [moduleContext, setModuleContext] = useState(null);
  const [contextLoading, setContextLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    view.getContext()
      .then((context) => {
        if (mounted) setModuleContext(context);
      })
      .catch((caughtError) => {
        console.warn('Unable to read Forge module context', caughtError);
      })
      .finally(() => {
        if (mounted) setContextLoading(false);
      });
    return () => { mounted = false; };
  }, []);

  if (contextLoading) {
    return <main className="statusdeck-entry-surface"><p>Loading StatusDeck…</p></main>;
  }

  const moduleType = getModuleType(moduleContext);
  if (moduleType.includes('dashboardGadget')) {
    return (
      <StatusDeckErrorBoundary>
        <StatusDeckDashboardGadget context={moduleContext} />
      </StatusDeckErrorBoundary>
    );
  }

  return (
    <StatusDeckErrorBoundary>
      <StatusDeckReportApp moduleContext={moduleContext} />
    </StatusDeckErrorBoundary>
  );
}

export default App;