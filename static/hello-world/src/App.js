import React, { useEffect, useMemo, useState } from 'react';
import { invoke, router } from '@forge/bridge';
import './App.css';

function formatDate(value) {
  if (!value) {
    return 'Not available';
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


const REPORT_SECTIONS = [
  {
    id: 'overview',
    label: 'Executive overview',
    description: 'Headline sprint health and delivery metrics',
    defaultVisible: true,
  },
  {
    id: 'effort',
    label: 'Effort & variance',
    description: 'Original estimate, time spent and forecast',
    defaultVisible: true,
  },
  {
    id: 'scopeHistory',
    label: 'Sprint scope history',
    description: 'Commitment, scope movement and estimate change',
    defaultVisible: false,
  },
  {
    id: 'burndown',
    label: 'Burndown',
    description: 'Story-point or remaining-effort trend',
    defaultVisible: true,
  },
  {
    id: 'changeLog',
    label: 'Change log',
    description: 'Detailed scope, estimate and status changes',
    defaultVisible: false,
  },
  {
    id: 'statusTypes',
    label: 'Status & work types',
    description: 'Current distribution by status and issue type',
    defaultVisible: false,
  },
  {
    id: 'sprintReport',
    label: 'Sprint report',
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
    label: 'Team workload',
    description: 'Assignee-level load, effort and overdue work',
    defaultVisible: false,
  },
  {
    id: 'workItems',
    label: 'Sprint work items',
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
}) {
  return (
    <aside
      className={[
        'section-selector',
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
        aria-label={collapsed ? 'Expand report sections' : 'Collapse report sections'}
        title={collapsed ? 'Expand report sections' : 'Collapse report sections'}
      >
        {collapsed ? '☰' : '‹'}
      </button>

      {collapsed ? (
        <div className="section-selector-rail">
          <span className="rail-monogram">SD</span>
          {REPORT_SECTIONS.map((section) => (
            <button
              type="button"
              key={section.id}
              className={[
                'rail-section-button',
                visibleSections[section.id] ? 'selected' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => onToggle(section.id)}
              title={section.label}
              aria-label={section.label}
            >
              {section.label.charAt(0)}
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="section-selector-header">
            <div>
              <p className="eyebrow">Presentation view</p>
              <h2>Report sections</h2>
              <p>
                The full Jira report is loaded once. Choose only the
                sections needed for this audience.
              </p>
            </div>

            <span className="selection-count">
              {visibleCount}
            </span>
          </div>

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

          <div className="section-selector-list">
            {REPORT_SECTIONS.map((section) => (
              <label
                className={[
                  'section-selector-item',
                  visibleSections[section.id] ? 'selected' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                key={section.id}
              >
                <input
                  type="checkbox"
                  checked={Boolean(visibleSections[section.id])}
                  onChange={() => onToggle(section.id)}
                />

                <span className="section-selector-copy">
                  <strong>{section.label}</strong>
                  <small>{section.description}</small>
                </span>
              </label>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}

function MetricCard({
  label,
  value,
  helper,
  onClick,
  tone = 'default',
  formatter = formatNumber,
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
      <span className="metric-label">{label}</span>

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
        aria-label="Status distribution"
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

      <div className="delivery-progress-track" aria-label="Delivery progress">
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

function ScopeMovementVisual({ history }) {
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
      label: 'Original commitment',
      value: original,
      className: 'scope-bar-original',
    },
    {
      label: 'Scope added',
      value: added,
      prefix: '+',
      className: 'scope-bar-added',
    },
    {
      label: 'Scope removed',
      value: removed,
      prefix: '−',
      className: 'scope-bar-removed',
    },
    {
      label: 'Estimate revisions',
      value: estimateChange,
      prefix: estimateChange > 0 ? '+' : '',
      className: 'scope-bar-estimate',
    },
    {
      label: 'Current scope',
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
        <strong>{formatNumber(current)} current points</strong>
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

function SprintProgressStrip({
  report,
  timing,
  deliveryStatus,
  planningAssessment,
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

  return (
    <section
      className={[
        'sprint-progress-strip',
        isFuture ? 'sprint-progress-strip-planning' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="sprint-progress-title">
        <p className="eyebrow">
          {isFuture ? 'Planning pulse' : 'Executive pulse'}
        </p>
        <strong>
          {isFuture ? 'Sprint readiness' : 'Sprint progress'}
        </strong>
      </div>

      <div className="sprint-progress-bar">
        <span
          className={[
            'sprint-progress-fill',
            isFuture ? 'sprint-planning-fill' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ width: `${displayedPercentage}%` }}
        />
      </div>

      <div className="sprint-progress-stat">
        <strong>{displayedPercentage}%</strong>
        <span>{isFuture ? 'planning ready' : 'complete'}</span>
      </div>

      <div className="sprint-progress-stat">
        <strong>
          {formatNumber(report.metrics.committedStoryPoints)}
        </strong>
        <span>{isFuture ? 'planned points' : 'scope points'}</span>
      </div>

      <div className="sprint-progress-stat">
        <strong>
          {isFuture
            ? planningAssessment.velocityLoadLabel
            : formatNumber(report.metrics.remainingStoryPoints)}
        </strong>
        <span>
          {isFuture ? 'of average velocity' : 'points remaining'}
        </span>
      </div>

      <div className="sprint-progress-stat">
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
      </div>

      <span
        className={`delivery-status-pill delivery-status-${deliveryStatus.tone}`}
      >
        {deliveryStatus.label}
      </span>
    </section>
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
}) {
  const isFuture = report.sprint.state === 'future';
  const isClosed = report.sprint.state === 'closed';

  const summaryItems = [];
  const riskItems = [];
  const mitigationItems = [];

  if (isFuture) {
    summaryItems.push(
      `${report.sprint.name} has not started. It currently contains ${report.metrics.total} work items totalling ${formatNumber(
        report.metrics.committedStoryPoints
      )} story points.`
    );

    if (planningAssessment.averageVelocity > 0) {
      summaryItems.push(
        `Planned scope is ${planningAssessment.velocityLoadPercentage}% of the recent average completed velocity of ${formatNumber(
          planningAssessment.averageVelocity
        )} points.`
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
        'Assign ownership for every planned work item before starting the sprint.'
      );
    }

    if (planningAssessment.unestimatedItems > 0) {
      riskItems.push(
        `${planningAssessment.unestimatedItems} ${
          planningAssessment.unestimatedItems === 1 ? 'item has' : 'items have'
        } no story-point estimate.`
      );
      mitigationItems.push(
        'Estimate all material work items and confirm the sprint total against recent velocity.'
      );
    }

    if (!planningAssessment.hasSprintGoal) {
      riskItems.push('No sprint goal has been entered.');
      mitigationItems.push(
        'Add a measurable sprint goal so the team and stakeholders share the same outcome.'
      );
    }

    if (report.metrics.overdue > 0) {
      riskItems.push(
        `${report.metrics.overdue} planned ${
          report.metrics.overdue === 1 ? 'item is' : 'items are'
        } already overdue before sprint start.`
      );
      mitigationItems.push(
        'Review overdue dates and either re-baseline, remove, or prioritise those items before activation.'
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
        'Reduce scope, split larger items, or confirm additional capacity before starting the sprint.'
      );
    } else if (
      planningAssessment.velocityLoadPercentage > 0 &&
      planningAssessment.velocityLoadPercentage < 60
    ) {
      riskItems.push(
        `Planned scope is only ${planningAssessment.velocityLoadPercentage}% of recent average velocity and may be under-planned.`
      );
      mitigationItems.push(
        'Confirm whether additional ready work should be included or whether reduced capacity is intentional.'
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
        'Complete effort estimates for planned items so capacity and forecast reporting are reliable.'
      );
    }
  } else {
    summaryItems.push(
      `${report.metrics.storyPointCompletionPercentage}% of current sprint story points are complete (${formatNumber(
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
          )}-point sprint-start commitment.`
        );
      } else {
        summaryItems.push(
          `Current scope is ${formatNumber(
            Math.abs(difference)
          )} points ${difference > 0 ? 'above' : 'below'} the sprint-start commitment.`
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

        mitigationItems.push(
          'Require Remaining Estimate updates for all open items and validate whether the apparent variance reflects real efficiency or missing data.'
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
          'Review the main effort drivers, confirm ownership, and agree corrective actions or revised delivery expectations.'
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
          'Validate that the favourable variance is supported by complete time and remaining-estimate data before treating it as realised efficiency.'
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
          ? 'Replan unfinished overdue work into the next sprint with a confirmed owner and revised due date.'
          : 'Review the overdue item owners and recovery dates during the next delivery checkpoint.'
      );
    }

    if (report.metrics.defects > 0) {
      riskItems.push(
        `Quality risk: ${report.metrics.defects} defects were included in the sprint scope; ${readiness.openDefects ?? 0} remain unresolved.`
      );

      mitigationItems.push(
        'Prioritise unresolved high-severity defects and confirm release acceptance criteria before deployment.'
      );
    }

    if (!timing.isClosed) {
      summaryItems.push(
        `${timing.daysRemaining} calendar days remain and ${timing.timeUsedPercentage}% of the sprint timebox has elapsed.`
      );
    }
  }

  return (
    <article className="dashboard-card management-summary-card">
      <div className="dashboard-card-heading">
        <div>
          <p className="eyebrow">
            {isFuture
              ? 'Planning commentary'
              : 'Management commentary'}
          </p>
          <h3>
            {isFuture
              ? 'Sprint readiness summary'
              : 'Executive summary'}
          </h3>
        </div>

        <span
          className={`delivery-status-pill delivery-status-${deliveryStatus.tone}`}
        >
          {deliveryStatus.label}
        </span>
      </div>

      <div className="readiness-summary">
        <div
          className="readiness-gauge"
          style={{
            '--readiness': `${readiness.score * 3.6}deg`,
          }}
        >
          <div>
            <strong>{readiness.score}%</strong>
            <span>
              {isFuture
                ? 'planning'
                : readiness.metricLabel ?? 'delivery health'}
            </span>
          </div>
        </div>

        <div>
          <strong className="readiness-label">
            {readiness.label}
          </strong>
          <p>
            {isFuture
              ? 'Planning indicator based on estimation, assignment, sprint goal, overdue work and velocity fit.'
              : 'Delivery-health indicator based on completion, overdue work, unresolved defects and estimate confidence.'}
          </p>
        </div>
      </div>

      <div className="management-commentary-block">
        <h4>Summary</h4>
        <ul className="management-summary-list">
          {summaryItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>

      {riskItems.length > 0 ? (
        <div className="management-commentary-block risk-commentary-block">
          <h4>Key risks</h4>
          <ul className="management-summary-list">
            {riskItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {mitigationItems.length > 0 ? (
        <div className="management-commentary-block mitigation-commentary-block">
          <h4>Recommended actions</h4>
          <ul className="management-summary-list">
            {[...new Set(mitigationItems)].map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
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
  const height = 360;

  const padding = {
    top: 28,
    right: 34,
    bottom: 82,
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
          Actual remaining
        </span>

        <span className="legend-item">
          <span className="legend-line ideal-line" />
          Ideal remaining
        </span>
      </div>

      <div className="burndown-scroll">
        <svg
          className="burndown-chart"
          viewBox={`0 0 ${width} ${height}`}
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
              ? 'Remaining effort (hours)'
              : 'Remaining story points'}
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

function App() {
  const [projects, setProjects] = useState([]);
  const [boards, setBoards] = useState([]);
  const [sprints, setSprints] = useState([]);

  const [projectKey, setProjectKey] = useState('');
  const [boardId, setBoardId] = useState('');
  const [sprintId, setSprintId] = useState('');

  const [report, setReport] = useState(null);
  const [velocityReport, setVelocityReport] = useState(null);

  const [loading, setLoading] = useState(true);
  const [loadingReport, setLoadingReport] = useState(false);
  const [includeSubtasks, setIncludeSubtasks] =
    useState(false);

  const [burndownView, setBurndownView] =
    useState('daily');

  const [burndownBasis, setBurndownBasis] =
    useState('points');

  const [error, setError] = useState('');

  const [visibleSections, setVisibleSections] = useState(
    DEFAULT_VISIBLE_SECTIONS
  );

  const [sectionSelectorCollapsed, setSectionSelectorCollapsed] =
    useState(false);

  const [activeReportPreset, setActiveReportPreset] =
    useState('executive');

  useEffect(() => {
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

        const preferredProject =
          softwareProjects.find(
            (project) => project.key === 'HDP'
          ) ?? softwareProjects[0];

        if (preferredProject) {
          setProjectKey(preferredProject.key);
        }
      } catch (caughtError) {
        console.error(caughtError);

        setError(
          caughtError.message ||
            'Unable to load Jira projects.'
        );
      } finally {
        setLoading(false);
      }
    }

    initialise();
  }, []);

  useEffect(() => {
    if (!projectKey) {
      setBoards([]);
      setBoardId('');
      setSprints([]);
      setSprintId('');
      setReport(null);
      setVelocityReport(null);
      return;
    }

    async function loadBoards() {
      try {
        setError('');
        setReport(null);
        setVelocityReport(null);
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

        setError(
          caughtError.message ||
            'Unable to load project boards.'
        );
      }
    }

    loadBoards();
  }, [projectKey]);

  useEffect(() => {
    if (!boardId) {
      setSprints([]);
      setSprintId('');
      setReport(null);
      setVelocityReport(null);
      return;
    }

    async function loadSprints() {
      try {
        setError('');
        setReport(null);
        setVelocityReport(null);

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

        setError(
          caughtError.message ||
            'Unable to load board sprints.'
        );
      }
    }

    loadSprints();
  }, [boardId]);

  function handleIncludeSubtasksChange(event) {
    setIncludeSubtasks(event.target.checked);
    setReport(null);
    setVelocityReport(null);
    setError('');
  }

  async function loadReport() {
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
      setError('');
      setReport(null);
      setVelocityReport(null);

      const [sprintResult, velocityResult] =
        await Promise.all([
          invoke('getSprintReport', {
            sprintId: Number(sprintId),
            includeSubtasks,
          }),

          invoke('getVelocityReport', {
            boardId: Number(boardId),
            includeSubtasks,
          }),
        ]);

      setReport(sprintResult);
      setVelocityReport(velocityResult);

      /*
       * Refresh the sprint list after loading the report. This keeps
       * labels accurate when a sprint has just been started or closed
       * in Jira while StatusDeck is already open.
       */
      const refreshedSprints = await invoke('getSprints', {
        boardId: Number(boardId),
      });

      setSprints(refreshedSprints);

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

      setError(
        caughtError.message ||
          'Unable to load the sprint report.'
      );
    } finally {
      setLoadingReport(false);
    }
  }

  const selectedProject = useMemo(
    () =>
      projects.find(
        (project) => project.key === projectKey
      ),
    [projects, projectKey]
  );

  const displayedIssues = useMemo(() => {
    if (!report) {
      return [];
    }

    return report.metrics.includedSubtasks
      ? report.metrics.issues
      : report.metrics.issues.filter(
          (issue) => !issue.isSubtask
        );
  }, [report]);

  const issueGroups = useMemo(() => {
    if (!report) {
      return {
        all: [],
        completed: [],
        open: [],
        defects: [],
        overdue: [],
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

      overdue: displayedIssues
        .filter((issue) => issue.daysOverdue > 0)
        .map((issue) => issue.key),
    };
  }, [report, displayedIssues]);

  const history = report?.history ?? null;

  const historyAddedKeys =
    history?.scopeChange?.addedIssueKeys ?? [];

  const historyRemovedKeys =
    history?.scopeChange?.removedIssueKeys ?? [];

  const effort =
    report?.metrics?.effort ?? null;

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
        label: 'Not calculated',
        tone: 'neutral',
        averageVelocity: 0,
        velocityLoadPercentage: 0,
        velocityLoadLabel: '—',
        unassignedItems: 0,
        unestimatedItems: 0,
        hasSprintGoal: false,
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

    const originalCoverage = Number(
      effort?.coverage?.originalEstimateCoveragePercentage ?? 0
    );

    let score = 100;

    score -= Math.min(25, unassignedItems * 8);
    score -= Math.min(25, unestimatedItems * 8);
    score -= hasSprintGoal ? 0 : 15;
    score -= Math.min(20, Number(report.metrics.overdue ?? 0) * 7);

    if (originalCoverage < 80) {
      score -= Math.min(15, Math.round((80 - originalCoverage) / 4));
    }

    if (velocityLoadPercentage > 120) {
      score -= Math.min(
        25,
        Math.round((velocityLoadPercentage - 120) / 3)
      );
    } else if (
      velocityLoadPercentage > 0 &&
      velocityLoadPercentage < 50
    ) {
      score -= 8;
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

    if (velocityLoadPercentage > 120) {
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
      !hasSprintGoal ||
      report.metrics.overdue > 0 ||
      originalCoverage < 80
    ) {
      label = tone === 'negative' ? label : 'Planning gaps';
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
      originalCoverage,
    };
  }, [report, velocityReport, displayedIssues, effort]);

  const deliveryStatus = useMemo(() => {
    if (!report) {
      return {
        label: 'Not calculated',
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

    if (report.sprint.state === 'closed') {
      if (
        completion >= 90 &&
        report.metrics.overdue === 0 &&
        report.metrics.defects === 0
      ) {
        return { label: 'Delivered', tone: 'positive' };
      }

      if (
        completion >= 90 &&
        (report.metrics.overdue > 0 ||
          report.metrics.defects > 0)
      ) {
        return {
          label: 'Delivered with concerns',
          tone: 'warning',
        };
      }

      if (completion >= 75) {
        return {
          label: 'Partially delivered',
          tone: 'warning',
        };
      }

      return {
        label: 'Below commitment',
        tone: 'negative',
      };
    }

    if (
      report.metrics.overdue > 0 ||
      completion + 15 < timeUsed
    ) {
      return { label: 'At risk', tone: 'negative' };
    }

    if (completion + 5 < timeUsed) {
      return { label: 'Watch closely', tone: 'warning' };
    }

    return { label: 'On track', tone: 'positive' };
  }, [report, sprintTiming, planningAssessment]);

  const readiness = useMemo(() => {
    if (!report) {
      return {
        score: 0,
        label: 'Not calculated',
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
        score >= 85
          ? 'Strong outcome'
          : score >= 65
            ? 'Delivered with concerns'
            : score >= 50
              ? 'Needs follow-up'
              : 'Needs attention',
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
  ]);

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

  if (loading) {
    return (
      <main className="page-shell">
        <div className="loading-panel">
          Loading StatusDeck…
        </div>
      </main>
    );
  }

  return (
    <main className="page-shell">

      <section className="configuration-card">
        <div className="section-heading">
          <div>
            <h2>Create report</h2>

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
              <option value="">Select project</option>

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
            <span>Report type</span>

            <select value="sprint-status" disabled>
              <option value="sprint-status">
                Sprint Status Report
              </option>
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
              <option value="">Select board</option>

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
                !boardId || sprints.length === 0
              }
            >
              <option value="">Select sprint</option>

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

        <div className="action-row">
          <div className="selected-context">
            {selectedProject
              ? `${selectedProject.name} · No JQL required`
              : 'Select a project'}
          </div>

          <label className="checkbox-option">
            <input
              type="checkbox"
              checked={includeSubtasks}
              onChange={handleIncludeSubtasksChange}
            />

            <span>
              Include subtasks in management totals
            </span>
          </label>

          <button
            type="button"
            className="primary-button"
            onClick={loadReport}
            disabled={!sprintId || loadingReport}
          >
            {loadingReport
              ? 'Loading report…'
              : 'Load report'}
          </button>
        </div>
      </section>

      {error ? (
        <div className="error-banner">{error}</div>
      ) : null}

      {report ? (
        <>
          <div
            className={[
              'report-layout',
              sectionSelectorCollapsed ? 'report-layout-collapsed' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <SectionSelector
              visibleSections={visibleSections}
              onToggle={toggleSection}
              onExecutiveView={showExecutiveView}
              onSelectAll={showAllSections}
              visibleCount={visibleSectionCount}
              activePreset={activeReportPreset}
              collapsed={sectionSelectorCollapsed}
              onToggleCollapsed={() =>
                setSectionSelectorCollapsed((current) => !current)
              }
            />

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
            planningAssessment={planningAssessment}
          />

          <section
            className={sectionClass(
              'overview',
              'executive-dashboard-overview'
            )}
          >
            <div className="headline-metrics-grid">
              <MetricCard
                label={
                  report.sprint.state === 'future'
                    ? 'Planning readiness'
                    : 'Delivery progress'
                }
                tone={
                  report.sprint.state === 'future'
                    ? planningAssessment.tone
                    : 'positive'
                }
                value={
                  report.sprint.state === 'future'
                    ? planningAssessment.score
                    : report.metrics.storyPointCompletionPercentage
                }
                formatter={(value) => `${formatNumber(value)}%`}
                helper={
                  report.sprint.state === 'future'
                    ? `${report.metrics.total} planned items`
                    : `${report.metrics.completed} of ${report.metrics.total} items completed`
                }
                onClick={
                  report.sprint.state === 'future'
                    ? () => openJiraIssues(issueGroups.all)
                    : () => openJiraIssues(issueGroups.completed)
                }
              />

              <MetricCard
                label="Completed"
                tone="positive"
                value={
                  report.storyPointField
                    ? report.metrics.completedStoryPoints
                    : report.metrics.completed
                }
                helper={
                  report.storyPointField
                    ? `${report.metrics.completed} completed items`
                    : 'Completed work items'
                }
                onClick={() => openJiraIssues(issueGroups.completed)}
              />

              <MetricCard
                label="Remaining"
                tone="warning"
                value={
                  report.storyPointField
                    ? report.metrics.remainingStoryPoints
                    : report.metrics.open
                }
                helper={`${report.metrics.open} open items`}
                onClick={() => openJiraIssues(issueGroups.open)}
              />

              <MetricCard
                label={
                  report.sprint.state === 'future'
                    ? 'Planning gaps'
                    : 'Delivery risk'
                }
                tone={
                  report.sprint.state === 'future'
                    ? planningAssessment.tone
                    : report.metrics.overdue > 0 ||
                        report.metrics.defects > 0
                      ? 'negative'
                      : 'positive'
                }
                value={
                  report.sprint.state === 'future'
                    ? planningAssessment.unassignedItems +
                      planningAssessment.unestimatedItems +
                      (planningAssessment.hasSprintGoal ? 0 : 1)
                    : report.metrics.overdue
                }
                helper={
                  report.sprint.state === 'future'
                    ? `${planningAssessment.unassignedItems} unassigned · ${planningAssessment.unestimatedItems} unestimated`
                    : `${report.metrics.defects} defects · ${report.metrics.overdue} overdue`
                }
                onClick={() =>
                  openJiraIssues(
                    report.sprint.state === 'future'
                      ? issueGroups.all
                      : [
                          ...issueGroups.overdue,
                          ...issueGroups.defects,
                        ]
                  )
                }
              />
            </div>

            <div className="executive-visual-grid">
              <article className="dashboard-card dashboard-card-progress">
                <div className="dashboard-card-heading">
                  <div>
                    <p className="eyebrow">
                      {report.sprint.state === 'future'
                        ? 'Planning health'
                        : 'Sprint health'}
                    </p>
                    <h3>
                      {report.sprint.state === 'future'
                        ? 'Planning readiness'
                        : 'Delivery progress'}
                    </h3>
                  </div>
                  <span className="dashboard-chip">
                    {report.sprint.state}
                  </span>
                </div>

                <div className="progress-visual-layout">
                  <ProgressRing
                    percentage={
                      report.sprint.state === 'future'
                        ? planningAssessment.score
                        : report.metrics.storyPointCompletionPercentage
                    }
                    label={
                      report.sprint.state === 'future'
                        ? 'planning ready'
                        : 'complete'
                    }
                    value={
                      report.sprint.state === 'future'
                        ? `${formatNumber(
                            report.metrics.committedStoryPoints
                          )} planned points · ${planningAssessment.velocityLoadLabel} of average velocity`
                        : `${formatNumber(
                            report.metrics.completedStoryPoints
                          )} of ${formatNumber(
                            report.metrics.committedStoryPoints
                          )} story points`
                    }
                  />

                  <DeliveryProgress metrics={report.metrics} />
                </div>
              </article>

              <article className="dashboard-card dashboard-card-status">
                <div className="dashboard-card-heading">
                  <div>
                    <p className="eyebrow">Work distribution</p>
                    <h3>Issues by status</h3>
                  </div>
                  <button
                    type="button"
                    className="dashboard-link-button"
                    onClick={() =>
                      setVisibleSections((current) => ({
                        ...current,
                        statusTypes: true,
                      }))
                    }
                  >
                    Details
                  </button>
                </div>

                <StatusDonut
                  statusCounts={report.metrics.statusCounts}
                  total={report.metrics.total}
                />
              </article>
            </div>

            <div className="secondary-metrics-strip">
              <button
                type="button"
                onClick={() => openJiraIssues(issueGroups.all)}
              >
                <span>Scope</span>
                <strong>
                  {formatNumber(report.metrics.committedStoryPoints)}
                </strong>
                <small>story points</small>
              </button>

              <button
                type="button"
                onClick={() => openJiraIssues(issueGroups.completed)}
              >
                <span>Completed</span>
                <strong>{report.metrics.completed}</strong>
                <small>work items</small>
              </button>

              <button
                type="button"
                onClick={() => openJiraIssues(issueGroups.open)}
              >
                <span>Open</span>
                <strong>{report.metrics.open}</strong>
                <small>work items</small>
              </button>

              <button
                type="button"
                onClick={() => openJiraIssues(issueGroups.defects)}
              >
                <span>Defects</span>
                <strong>{report.metrics.defects}</strong>
                <small>current scope</small>
              </button>

              <button
                type="button"
                onClick={() => openJiraIssues(issueGroups.overdue)}
              >
                <span>Overdue</span>
                <strong>{report.metrics.overdue}</strong>
                <small>open items</small>
              </button>
            </div>

            <div className="executive-insights-grid">
              <article className="dashboard-card priority-dashboard-card">
                <div className="dashboard-card-heading">
                  <div>
                    <p className="eyebrow">Risk profile</p>
                    <h3>Issues by priority</h3>
                  </div>
                  <span className="dashboard-chip">
                    {Object.values(priorityCounts).reduce(
                      (sum, count) => sum + count,
                      0
                    )}{' '}
                    items
                  </span>
                </div>

                <PriorityDonut issues={displayedIssues} />
              </article>

              <article className="dashboard-card scope-dashboard-card">
                <div className="dashboard-card-heading">
                  <div>
                    <p className="eyebrow">Scope health</p>
                    <h3>Sprint scope movement</h3>
                  </div>
                  <button
                    type="button"
                    className="dashboard-link-button"
                    onClick={() =>
                      setVisibleSections((current) => ({
                        ...current,
                        scopeHistory: true,
                      }))
                    }
                  >
                    Details
                  </button>
                </div>

                <ScopeMovementVisual history={history} />
              </article>
            </div>

            <div className="executive-insights-grid executive-insights-grid-lower">
              <article className="dashboard-card workload-dashboard-card">
                <div className="dashboard-card-heading">
                  <div>
                    <p className="eyebrow">Capacity view</p>
                    <h3>Forward workload by assignee</h3>
                  </div>
                  <button
                    type="button"
                    className="dashboard-link-button"
                    onClick={() =>
                      setVisibleSections((current) => ({
                        ...current,
                        teamWorkload: true,
                      }))
                    }
                  >
                    Full table
                  </button>
                </div>

                <TeamWorkloadBars
                  workload={workloadWithIssueKeys}
                />
              </article>

              <ManagementSummary
                report={report}
                history={history}
                effort={effort}
                timing={sprintTiming}
                readiness={readiness}
                deliveryStatus={deliveryStatus}
                planningAssessment={planningAssessment}
              />
            </div>
          </section>

{effort ? (
            <section className={sectionClass('effort', 'dashboard-card content-card effort-section executive-section-card')}>
              <div className="section-heading">
                <div>
                  <h3>
                    Effort estimate and variance
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
                  <span>Original estimate coverage</span>
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
                  <span>Remaining estimate coverage</span>
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
                  <span>Time-spent coverage</span>
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
                  label="Original estimate"
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
                  label="Time spent"
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
                  label="Remaining estimate"
                  value={
                    effort.remainingEstimateHours
                  }
                  formatter={formatHours}
                  helper={`${formatNumber(
                    effort.remainingPercentage
                  )}% of original`}
                  onClick={() =>
                    openJiraIssues(
                      issueGroups.open
                    )
                  }
                />

                <MetricCard
                  label={
                    effort.forecastProvisional
                      ? 'Forecast effort · provisional'
                      : 'Forecast effort'
                  }
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
                      ? 'Effort variance · provisional'
                      : 'Effort variance'
                  }
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
            <section className={sectionClass('scopeHistory', 'dashboard-card content-card history-section executive-section-card')}>
              <div className="section-heading">
                <div>
                  <h3>Sprint scope history</h3>

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
                      label="Original committed points"
                      value={
                        history.originalCommitment.storyPoints
                      }
                      helper="At sprint start"
                    />

                    <MetricCard
                      label="Current scope items"
                      value={history.currentScope.items}
                      onClick={() =>
                        openJiraIssues(issueGroups.all)
                      }
                    />

                    <MetricCard
                      label="Current scope points"
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
                      label="Estimate change"
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
                      label="Current completed points"
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
                      label="Current remaining points"
                      value={
                        history.currentScope
                          .remainingStoryPoints
                      }
                      onClick={() =>
                        openJiraIssues(issueGroups.open)
                      }
                    />

                    <MetricCard
                      label="Original effort at sprint start"
                      value={
                        history.originalCommitment
                          .originalEstimateHours
                      }
                      formatter={formatHours}
                      helper="At sprint start"
                    />

                    <MetricCard
                      label="Current original estimate"
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
                      label="Current remaining estimate"
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
                          ? 'Forecast effort · provisional'
                          : 'Forecast effort'
                      }
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
                          ? 'Effort variance · provisional'
                          : 'Effort variance'
                      }
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
                      label="Original estimate change"
                      value={
                        history.scopeChange
                          .originalEstimateChangeHours
                      }
                      formatter={formatHours}
                      helper="Net in-sprint revision"
                      tone="warning"
                    />

                    <MetricCard
                      label="Remaining estimate change"
                      value={
                        history.scopeChange
                          .remainingEstimateChangeHours
                      }
                      formatter={formatHours}
                      helper="Net in-sprint revision"
                      tone="warning"
                    />

                    <MetricCard
                      label="Time logged"
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
            <section className={sectionClass('burndown', 'dashboard-card content-card burndown-section executive-section-card')}>
              <div className="section-heading burndown-heading">
                <div>
                  <h3>Burndown</h3>

                  <p>
                    Daily is management-friendly. Live events
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
                      Story points
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
                      Remaining effort
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
                      Live events
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
            <section className={sectionClass('changeLog', 'dashboard-card content-card change-log-section')}>
              <div className="section-heading">
                <div>
                  <h3>Scope, estimate and effort changes</h3>

                  <p>
                    Latest sprint scope, estimate, effort and status changes detected from Jira history.
                  </p>
                </div>
              </div>

              <details className="dashboard-details">
                <summary>
                  View latest Jira history changes
                </summary>
                <HistoryEventsTable
                  events={history.events}
                />
              </details>
            </section>
          ) : null}

          <section className={sectionClass('statusTypes', 'two-column-grid status-type-grid')}>
            <article className="content-card">
              <h3>Status distribution</h3>

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
              <h3>Work-item types</h3>

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

          <section className={sectionClass('sprintReport', 'dashboard-card content-card sprint-report-section executive-section-card')}>
            <div className="section-heading">
              <div>
                <h3>Sprint report</h3>

                <p>
                  Select a value to open the corresponding
                  Jira work items.
                </p>
              </div>
            </div>

            <div className="sprint-report-summary">
              <MetricCard
                label="Completed items"
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
                label="Incomplete items"
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
                    label="Completed points"
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
                    label="Incomplete points"
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
            <section className={sectionClass('velocity', 'dashboard-card content-card velocity-section executive-section-card')}>
              <div className="section-heading">
                <div>
                  <h3>Velocity</h3>

                  <p>
                    Recent closed sprints · Average
                    completed:{' '}
                    <strong>
                      {velocityReport.averageCompleted}
                    </strong>{' '}
                    {velocityReport.usesStoryPoints
                      ? 'story points'
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

          <section className={sectionClass('teamWorkload', 'dashboard-card content-card team-workload-section')}>
            <div className="section-heading">
              <div>
                <h3>Team workload</h3>

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
                    <th>Story points</th>
                    <th>Remaining points</th>
                    <th>Original estimate</th>
                    <th>Time spent</th>
                    <th>Remaining estimate</th>
                    <th>Forecast effort</th>
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

          <section className={sectionClass('workItems', 'dashboard-card content-card work-items-section')}>
            <div className="section-heading">
              <div>
                <h3>Sprint work items</h3>

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
                    <th>Story points</th>
                    <th>Original estimate</th>
                    <th>Time spent</th>
                    <th>Remaining estimate</th>
                    <th>Forecast effort</th>
                    <th>Assignee</th>
                    <th>Due date</th>
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
      ) : (
        <section className="empty-state">
          <h2>
            Your report preview will appear here
          </h2>

          <p>
            Select a project, board and sprint, then choose
            Load report.
          </p>
        </section>
      )}
    </main>
  );
}

export default App;