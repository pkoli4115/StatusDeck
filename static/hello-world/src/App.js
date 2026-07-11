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
}) {
  return (
    <aside className="section-selector" aria-label="Report sections">
      <div className="section-selector-header">
        <div>
          <p className="eyebrow">Presentation view</p>
          <h2>Report sections</h2>
          <p>
            Show only what your audience needs. The full report is still
            generated in the background.
          </p>
        </div>

        <span className="selection-count">
          {visibleCount} selected
        </span>
      </div>

      <div className="section-selector-actions">
        <button type="button" onClick={onExecutiveView}>
          Executive view
        </button>
        <button type="button" onClick={onSelectAll}>
          Select all
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
  }

  function showExecutiveView() {
    setVisibleSections(DEFAULT_VISIBLE_SECTIONS);
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
      <header className="page-header page-brand-strip">
        <div className="brand-block">
          <p className="eyebrow">Executive sprint reporting</p>

          <div className="brand-meta-row">
            <p className="subtitle">
              Management-ready Jira reporting without JQL or manual filters.
            </p>

            <span className="brand-byline">by QTI Labs</span>
          </div>
        </div>

        <span className="environment-badge">Development</span>
      </header>

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
          <div className="report-layout">
            <SectionSelector
              visibleSections={visibleSections}
              onToggle={toggleSection}
              onExecutiveView={showExecutiveView}
              onSelectAll={showAllSections}
              visibleCount={visibleSectionCount}
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

          <section className={sectionClass('overview', 'metric-grid executive-metric-grid')}>
            <MetricCard
              label="Current scope items"
              tone="neutral"
              value={report.metrics.total}
              helper={
                report.metrics.includedSubtasks
                  ? 'Subtasks included'
                  : `${report.metrics.subtaskCount} subtasks excluded`
              }
              onClick={() =>
                openJiraIssues(issueGroups.all)
              }
            />

            <MetricCard
              label="Completed"
              tone="positive"
              value={report.metrics.completed}
              helper={`${report.metrics.completionPercentage}% complete`}
              onClick={() =>
                openJiraIssues(issueGroups.completed)
              }
            />

            <MetricCard
              label="Open"
              tone="warning"
              value={report.metrics.open}
              onClick={() =>
                openJiraIssues(issueGroups.open)
              }
            />

            <MetricCard
              label="Defects"
              tone="negative"
              value={report.metrics.defects}
              onClick={() =>
                openJiraIssues(issueGroups.defects)
              }
            />

            <MetricCard
              label="Overdue open items"
              tone="negative"
              value={report.metrics.overdue}
              onClick={() =>
                openJiraIssues(issueGroups.overdue)
              }
            />

            {report.storyPointField ? (
              <>
                <MetricCard
                  label="Current scope story points"
              tone="neutral"
                  value={
                    report.metrics.committedStoryPoints
                  }
                  helper={report.storyPointField.name}
                  onClick={() =>
                    openJiraIssues(issueGroups.all)
                  }
                />

                <MetricCard
                  label="Completed story points"
              tone="positive"
                  value={
                    report.metrics.completedStoryPoints
                  }
                  helper={`${report.metrics.storyPointCompletionPercentage}% complete`}
                  onClick={() =>
                    openJiraIssues(
                      issueGroups.completed
                    )
                  }
                />

                <MetricCard
                  label="Remaining story points"
              tone="warning"
                  value={
                    report.metrics.remainingStoryPoints
                  }
                  onClick={() =>
                    openJiraIssues(issueGroups.open)
                  }
                />
              </>
            ) : null}
          </section>
{effort ? (
            <section className={sectionClass('effort', 'content-card effort-section executive-section-card')}>
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
            <section className={sectionClass('scopeHistory', 'content-card history-section executive-section-card')}>
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
            <section className={sectionClass('burndown', 'content-card burndown-section executive-section-card')}>
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
            <section className={sectionClass('changeLog', 'content-card change-log-section')}>
              <div className="section-heading">
                <div>
                  <h3>Scope, estimate and effort changes</h3>

                  <p>
                    Latest sprint scope, estimate, effort and status changes detected from Jira history.
                  </p>
                </div>
              </div>

              <HistoryEventsTable
                events={history.events}
              />
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

          <section className={sectionClass('sprintReport', 'content-card sprint-report-section executive-section-card')}>
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
            <section className={sectionClass('velocity', 'content-card velocity-section executive-section-card')}>
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

          <section className={sectionClass('teamWorkload', 'content-card team-workload-section')}>
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

          <section className={sectionClass('workItems', 'content-card work-items-section')}>
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