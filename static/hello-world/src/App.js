import React, { useEffect, useMemo, useState } from 'react';
import PptxGenJS from 'pptxgenjs';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
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


const FILTER_DEFAULTS = {
  assignee: 'all',
  status: 'all',
  priority: 'all',
  issueType: 'all',
  onlyOverdue: false,
  onlyDefects: false,
  onlyUnassigned: false,
};

const FULL_EXPORT_SECTIONS = {
  overview: true,
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
    navy: '0F2747',
    blue: '0C66E4',
    blueLight: 'E9F2FF',
    green: '22A06B',
    greenLight: 'E3FCEF',
    amber: 'E2B203',
    amberLight: 'FFF7D6',
    red: 'C9372C',
    redLight: 'FFEBE6',
    purple: '6554C0',
    grey: '626F86',
    greyLight: 'F4F6F8',
    border: 'D9E2EC',
    white: 'FFFFFF',
  };
}

function getManagementNarrative({
  report,
  readiness,
  deliveryStatus,
}) {
  const effort = report.metrics?.effort;
  const history = report.history;
  const summary = [];
  const risks = [];
  const actions = [];

  summary.push(
    `${report.metrics.storyPointCompletionPercentage}% of sprint story points are complete (${formatNumber(
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

    summary.push(
      difference === 0
        ? `Current scope remains aligned to the ${formatNumber(
            original
          )}-point sprint-start commitment.`
        : `Current scope is ${formatNumber(
            Math.abs(difference)
          )} points ${difference > 0 ? 'above' : 'below'} the sprint-start commitment.`
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

      actions.push(
        'Require Remaining Estimate updates for all open items and validate whether the apparent variance reflects genuine efficiency or missing data.'
      );
    }
  }

  if (report.metrics.overdue > 0) {
    risks.push(
      `Schedule risk: ${report.metrics.overdue} overdue open ${
        report.metrics.overdue === 1 ? 'item requires' : 'items require'
      } management attention.`
    );

    actions.push(
      'Replan unfinished overdue work with confirmed owners and revised due dates.'
    );
  }

  if (report.metrics.defects > 0) {
    risks.push(
      `Quality risk: ${report.metrics.defects} defects were included in sprint scope; ${readiness.openDefects ?? 0} remain unresolved.`
    );

    actions.push(
      'Prioritise unresolved high-severity defects and confirm release acceptance criteria before deployment.'
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

  return {
    sprintName: nextSprintOutlook.sprint?.name ?? 'Next sprint',
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

  addPptText(slide, 'Actual remaining', {
    x: x + w - 3.25,
    y: y - 0.05,
    w: 1.35,
    h: 0.18,
    fontSize: 7.5,
    color: 'E34935',
    bold: true,
  });

  addPptText(slide, 'Ideal remaining', {
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

async function createPowerPoint({
  report,
  velocityReport,
  nextSprintOutlook,
  projectKey,
  selectedSections,
  filteredIssues,
  readiness,
  deliveryStatus,
}) {
  const pptx = new PptxGenJS();
  const palette = getExportPalette();
  const pageRef = { value: 1 };
  const narrative = getManagementNarrative({
    report,
    readiness,
    deliveryStatus,
  });
  const outlookSummary = buildNextSprintOutlookSummary(
    nextSprintOutlook,
    velocityReport
  );

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
      label: 'Story points complete',
      value: `${report.metrics.storyPointCompletionPercentage}%`,
      helper: `${report.metrics.completedStoryPoints} of ${report.metrics.committedStoryPoints} points`,
      accent: palette.green,
    });

    addPptMetricCard(pptx, slide, {
      x: 3.75,
      y: 3.45,
      w: 2.8,
      h: 1.3,
      label: 'Delivery health',
      value: `${readiness.score}%`,
      helper: readiness.label,
      accent: palette.blue,
    });

    addPptMetricCard(pptx, slide, {
      x: 6.78,
      y: 3.45,
      w: 2.8,
      h: 1.3,
      label: 'Open work',
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
      'Executive overview',
      'Headline sprint delivery, risk and scope indicators',
      page
    );

    const metrics = [
      {
        label: 'Delivery progress',
        value: `${report.metrics.storyPointCompletionPercentage}%`,
        helper: `${report.metrics.completed} of ${report.metrics.total} items completed`,
        accent: palette.green,
      },
      {
        label: 'Completed points',
        value: report.metrics.completedStoryPoints,
        helper: `${report.metrics.completed} completed items`,
        accent: palette.green,
      },
      {
        label: 'Remaining points',
        value: report.metrics.remainingStoryPoints,
        helper: `${report.metrics.open} open items`,
        accent: palette.amber,
      },
      {
        label: 'Delivery risk',
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

    addPptText(slide, 'Delivery progress', {
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
      `${report.metrics.completedStoryPoints} completed of ${report.metrics.committedStoryPoints} points`,
      {
        x: 0.65,
        y: 3.72,
        w: 4.2,
        h: 0.22,
        fontSize: 10,
        color: palette.grey,
      }
    );

    addPptText(slide, 'Issues by status', {
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
      ['Scope points', report.metrics.committedStoryPoints],
      ['Completed items', report.metrics.completed],
      ['Open items', report.metrics.open],
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

  {
    const slide = pptx.addSlide();
    const page = pageRef.value++;

    addPptHeader(
      slide,
      'Management commentary',
      'Executive interpretation of delivery outcome, risks and actions',
      page
    );

    addPptMetricCard(pptx, slide, {
      x: 0.65,
      y: 1.25,
      w: 2.2,
      h: 1.25,
      label: 'Delivery health',
      value: `${narrative.score}%`,
      helper: narrative.title,
      accent: palette.blue,
    });

    addPptText(slide, readiness.label, {
      x: 3.15,
      y: 1.36,
      w: 4.0,
      h: 0.34,
      fontSize: 19,
      bold: true,
      color: palette.navy,
    });

    addPptText(
      slide,
      'Indicator based on completion, overdue work, unresolved defects and estimate confidence.',
      {
        x: 3.15,
        y: 1.78,
        w: outlookSummary ? 4.7 : 6.5,
        h: 0.42,
        fontSize: 10,
        color: palette.grey,
      }
    );

    if (outlookSummary) {
      slide.addShape(pptx.ShapeType.roundRect, {
        x: 8.25,
        y: 1.22,
        w: 4.25,
        h: 1.48,
        rectRadius: 0.05,
        fill: { color: palette.blueLight },
        line: { color: '85B8FF', pt: 0.8 },
      });

      addPptText(slide, 'NEXT SPRINT OUTLOOK', {
        x: 8.52,
        y: 1.38,
        w: 2.3,
        h: 0.18,
        fontSize: 8,
        bold: true,
        color: palette.blue,
      });

      addPptText(slide, outlookSummary.sprintName, {
        x: 8.52,
        y: 1.62,
        w: 2.8,
        h: 0.22,
        fontSize: 12,
        bold: true,
        color: palette.navy,
      });

      addPptText(
        slide,
        `${outlookSummary.plannedPoints} points / ${outlookSummary.plannedItems} items | ${outlookSummary.carryOverItems} carry-over`,
        {
          x: 8.52,
          y: 1.92,
          w: 3.65,
          h: 0.2,
          fontSize: 8,
          color: palette.grey,
        }
      );

      addPptText(
        slide,
        `Goal: ${outlookSummary.goal}`,
        {
          x: 8.52,
          y: 2.16,
          w: 3.62,
          h: 0.34,
          fontSize: 7.4,
          color: palette.grey,
          valign: 'top',
          breakLine: true,
          fit: 'shrink',
        }
      );
    }

    const addBullets = (title, items, y, color) => {
      addPptText(slide, title, {
        x: 0.75,
        y,
        w: 2.4,
        h: 0.25,
        fontSize: 11,
        bold: true,
        color,
      });

      const runs = [];
      items.forEach((item) => {
        runs.push({
          text: item,
          options: {
            bullet: { indent: 14 },
            breakLine: true,
            hanging: 3,
          },
        });
      });

      slide.addText(runs, {
        x: 0.9,
        y: y + 0.32,
        w: 11.5,
        h: Math.min(1.35, 0.35 * items.length + 0.15),
        fontFace: 'Aptos',
        fontSize: 10,
        color: palette.grey,
        margin: 0.02,
        valign: 'top',
        breakLine: false,
      });
    };

    addBullets('SUMMARY', narrative.summary, 2.75, palette.blue);
    addBullets('KEY RISKS', narrative.risks, 4.15, palette.red);
    addBullets(
      'RECOMMENDED ACTIONS',
      narrative.actions,
      5.45,
      palette.green
    );
  }

  if (selectedSections.effort && report.metrics.effort) {
    const slide = pptx.addSlide();
    const page = pageRef.value++;
    const effort = report.metrics.effort;

    addPptHeader(
      slide,
      'Effort estimate and variance',
      'Jira Original Estimate, Time Spent and Remaining Estimate normalised to hours',
      page
    );

    const cards = [
      ['Original estimate', `${effort.originalEstimateHours}h`, palette.blue],
      ['Time spent', `${effort.timeSpentHours}h`, palette.green],
      ['Remaining estimate', `${effort.remainingEstimateHours}h`, palette.amber],
      ['Forecast effort', `${effort.forecastHours}h`, palette.purple],
      ['Effort variance', `${effort.varianceHours}h`, palette.red],
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
          label === 'Effort variance'
            ? `${effort.variancePercentage}%`
            : undefined,
        accent,
      });
    });

    const coverage = [
      {
        label: 'Original estimate coverage',
        value:
          effort.coverage?.originalEstimateCoveragePercentage ?? 0,
        color: palette.blue,
      },
      {
        label: 'Remaining estimate coverage',
        value:
          effort.coverage?.remainingEstimateCoveragePercentage ?? 0,
        color: palette.amber,
      },
      {
        label: 'Time-spent coverage',
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
        : 'Forecast confidence',
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
      'Sprint scope history',
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
      history.currentScope?.storyPoints ?? 0
    );

    addPptHorizontalBars(
      pptx,
      slide,
      [
        { label: 'Original commitment', value: original, color: palette.blue },
        { label: 'Scope added', value: added, prefix: '+', color: palette.green },
        { label: 'Scope removed', value: removed, prefix: '−', color: palette.red },
        {
          label: 'Estimate revisions',
          value: estimateChange,
          prefix: estimateChange > 0 ? '+' : '',
          color: palette.amber,
        },
        { label: 'Current scope', value: current, color: palette.purple },
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
      `${formatNumber(original)} committed + ${formatNumber(
        added
      )} added − ${formatNumber(removed)} removed ${
        estimateChange >= 0 ? '+' : '−'
      } ${formatNumber(
        Math.abs(estimateChange)
      )} estimate revision = ${formatNumber(current)} current points`,
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
      ['Original items', history.originalCommitment?.items ?? 0],
      ['Current items', history.currentScope?.items ?? 0],
      ['Added items', history.scopeChange?.addedItems ?? 0],
      ['Removed items', history.scopeChange?.removedItems ?? 0],
      ['Completed points', history.currentScope?.completedStoryPoints ?? 0],
      ['Remaining points', history.currentScope?.remainingStoryPoints ?? 0],
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
      'Sprint burndown',
      'Daily story-point burndown compared with the ideal sprint trajectory',
      page
    );

    addPptBurndown(
      pptx,
      slide,
      report.history.burndownDaily ??
        report.history.burndown ??
        [],
      {
        basis: 'points',
      }
    );
  }

  if (selectedSections.statusTypes) {
    const slide = pptx.addSlide();
    const page = pageRef.value++;

    addPptHeader(
      slide,
      'Status and work-item distribution',
      'Current sprint distribution by Jira status, issue type and priority',
      page
    );

    addPptText(slide, 'Issues by status', {
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

    addPptText(slide, 'Work-item types', {
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

    addPptText(slide, 'Priority profile', {
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
      'Sprint report',
      'Completed and incomplete delivery summary',
      page
    );

    const cards = [
      ['Completed items', report.sprintReport.completedCount, palette.green],
      ['Incomplete items', report.sprintReport.incompleteCount, palette.amber],
      ['Completed points', report.sprintReport.completedStoryPoints, palette.green],
      ['Incomplete points', report.sprintReport.incompleteStoryPoints, palette.amber],
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

    const committed =
      report.history?.available
        ? report.history.originalCommitment?.storyPoints
        : report.metrics.committedStoryPoints;

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
      `${formatNumber(
        report.sprintReport.completedStoryPoints
      )} completed of ${formatNumber(committed)} committed points`,
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
      'Velocity',
      `Recent closed sprints · Average completed: ${velocityReport.averageCompleted} story points`,
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
      const trackW = 8.2;

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
          x: 11.4,
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
  }

  if (selectedSections.teamWorkload) {
    const slide = pptx.addSlide();
    const page = pageRef.value++;
    const people = report.metrics.workload ?? [];
    const maxPoints = Math.max(
      1,
      ...people.map((person) => Number(person.storyPoints ?? 0))
    );

    addPptHeader(
      slide,
      'Team workload',
      'Assignee-level story-point load, remaining work and overdue items',
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
      title: 'Scope, estimate and effort changes',
      subtitle: 'Latest Jira history changes detected during the sprint',
      headers: ['Date', 'Key', 'Change'],
      rows: [...report.history.events]
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
      rowsPerSlide: 15,
      pageRef,
    });
  }

  if (selectedSections.workItems && filteredIssues.length) {
    addPptTableSlides({
      pptx,
      title: 'Sprint work items',
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
    pdfSetText(doc, [98, 111, 134], 6.5, 'normal');
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
    : [15, 39, 71];

  doc.setTextColor(...safeColor);
  doc.setFont('helvetica', style);
  doc.setFontSize(Number(size) || 10);
}

function pdfAddPageHeader(doc, title, subtitle, pageNumber) {
  doc.setFillColor(12, 102, 228);
  doc.rect(0, 0, 297, 3, 'F');

  pdfSetText(doc, [15, 39, 71], 18, 'bold');
  doc.text(title, 12, 15);

  if (subtitle) {
    pdfSetText(doc, [98, 111, 134], 8, 'normal');
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
    accent = [12, 102, 228],
  }
) {
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(217, 226, 236);
  doc.roundedRect(x, y, w, h, 2.5, 2.5, 'FD');

  doc.setFillColor(...accent);
  doc.rect(x, y, 1.6, h, 'F');

  pdfSetText(doc, [98, 111, 134], 6.5, 'bold');
  doc.text(String(label), x + 4, y + 6.2);

  pdfSetText(doc, [15, 39, 71], 17, 'bold');
  doc.text(String(value), x + 4, y + 15.5);

  if (helper) {
    pdfSetText(doc, [98, 111, 134], 6.2, 'normal');
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
      [12, 102, 228];

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

    pdfSetText(doc, [15, 39, 71], 7, 'bold');
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
    pdfSetText(doc, [98, 111, 134], 12, 'normal');
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

    pdfSetText(doc, [98, 111, 134], 6, 'normal');
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

    pdfSetText(doc, [98, 111, 134], 6.5, 'normal');
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

async function createPdfReport({
  report,
  velocityReport,
  nextSprintOutlook,
  projectKey,
  selectedSections,
  filteredIssues,
  readiness,
  deliveryStatus,
}) {
  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4',
    compress: true,
  });

  enablePdfSafeText(doc);

  const narrative = getManagementNarrative({
    report,
    readiness,
    deliveryStatus,
  });
  const outlookSummary = buildNextSprintOutlookSummary(
    nextSprintOutlook,
    velocityReport
  );

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
    label: 'Story points complete',
    value: `${report.metrics.storyPointCompletionPercentage}%`,
    helper: `${report.metrics.completedStoryPoints} of ${report.metrics.committedStoryPoints} points`,
    accent: [34, 160, 107],
  });

  pdfMetricCard(doc, {
    x: 78,
    y: 100,
    w: 54,
    h: 32,
    label: 'Delivery health',
    value: `${readiness.score}%`,
    helper: readiness.label,
    accent: [12, 102, 228],
  });

  pdfMetricCard(doc, {
    x: 138,
    y: 100,
    w: 54,
    h: 32,
    label: 'Open work',
    value: report.metrics.open,
    helper: `${report.metrics.overdue} overdue`,
    accent: [226, 178, 3],
  });

  pdfMetricCard(doc, {
    x: 198,
    y: 100,
    w: 54,
    h: 32,
    label: 'Defects',
    value: report.metrics.defects,
    helper: `${readiness.openDefects ?? 0} unresolved`,
    accent: [201, 55, 44],
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
      'Executive overview',
      'Headline sprint delivery, risk and scope indicators',
      page
    );

    [
      ['Delivery progress', `${report.metrics.storyPointCompletionPercentage}%`, `${report.metrics.completed} of ${report.metrics.total} items`, [34, 160, 107]],
      ['Completed points', report.metrics.completedStoryPoints, `${report.metrics.completed} completed items`, [34, 160, 107]],
      ['Remaining points', report.metrics.remainingStoryPoints, `${report.metrics.open} open items`, [226, 178, 3]],
      ['Delivery risk', report.metrics.overdue, `${report.metrics.defects} defects | ${report.metrics.overdue} overdue`, [201, 55, 44]],
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

    pdfSetText(doc, [15, 39, 71], 10, 'bold');
    doc.text('Delivery progress', 14, 75);

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

    pdfSetText(doc, [98, 111, 134], 7.5, 'normal');
    doc.text(
      `${report.metrics.completedStoryPoints} completed of ${report.metrics.committedStoryPoints} points`,
      14,
      95
    );

    pdfSetText(doc, [15, 39, 71], 10, 'bold');
    doc.text('Issues by status', 190, 75);

    pdfHorizontalBars(
      doc,
      Object.entries(report.metrics.statusCounts ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 7)
        .map(([label, value], index) => ({
          label,
          value,
          color: [
            [34, 160, 107],
            [12, 102, 228],
            [226, 178, 3],
            [201, 55, 44],
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
      ['Scope points', report.metrics.committedStoryPoints],
      ['Completed items', report.metrics.completed],
      ['Open items', report.metrics.open],
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
            ? [201, 55, 44]
            : [12, 102, 228],
      });
    });
  }

  // Management commentary
  doc.addPage();
  page += 1;
  pdfAddPageHeader(
    doc,
    'Management commentary',
    'Executive interpretation of delivery outcome, risks and actions',
    page
  );

  pdfMetricCard(doc, {
    x: 14,
    y: 30,
    w: 55,
    h: 34,
    label: 'Delivery health',
    value: `${narrative.score}%`,
    helper: narrative.title,
    accent: [12, 102, 228],
  });

  pdfSetText(doc, [15, 39, 71], 15, 'bold');
  doc.text(readiness.label, 78, 40);

  pdfSetText(doc, [98, 111, 134], 8, 'normal');
  doc.text(
    doc.splitTextToSize(
      'Indicator based on completion, overdue work, unresolved defects and estimate confidence.',
      outlookSummary ? 96 : 185
    ),
    78,
    48
  );

  if (outlookSummary) {
    doc.setFillColor(233, 242, 255);
    doc.setDrawColor(133, 184, 255);
    doc.roundedRect(184, 30, 99, 34, 2.5, 2.5, 'FD');

    pdfSetText(doc, [12, 102, 228], 7, 'bold');
    doc.text('NEXT SPRINT OUTLOOK', 190, 38);

    pdfSetText(doc, [15, 39, 71], 10, 'bold');
    doc.text(outlookSummary.sprintName, 190, 46);

    pdfSetText(doc, [98, 111, 134], 6.8, 'normal');
    doc.text(
      `${outlookSummary.plannedPoints} points / ${outlookSummary.plannedItems} items | ${outlookSummary.carryOverItems} carry-over`,
      190,
      54
    );

    doc.text(
      doc.splitTextToSize(
        `Goal: ${outlookSummary.goal}`,
        84
      ),
      190,
      60
    );
  }

  const addPdfBulletBlock = (
    title,
    items,
    y,
    titleColor,
    fillColor
  ) => {
    doc.setFillColor(...fillColor);
    doc.roundedRect(14, y, 269, 34, 2.5, 2.5, 'F');

    pdfSetText(doc, titleColor, 8, 'bold');
    doc.text(title, 19, y + 7);

    pdfSetText(doc, [68, 84, 111], 7.5, 'normal');
    let currentY = y + 14;

    items.forEach((item) => {
      const lines = doc.splitTextToSize(`- ${item}`, 252);
      doc.text(lines, 20, currentY);
      currentY += lines.length * 4.1 + 1.2;
    });
  };

  addPdfBulletBlock(
    'SUMMARY',
    narrative.summary,
    75,
    [12, 102, 228],
    [244, 248, 255]
  );
  addPdfBulletBlock(
    'KEY RISKS',
    narrative.risks,
    114,
    [201, 55, 44],
    [255, 247, 245]
  );
  addPdfBulletBlock(
    'RECOMMENDED ACTIONS',
    narrative.actions,
    153,
    [34, 160, 107],
    [242, 251, 247]
  );

  if (selectedSections.effort && report.metrics.effort) {
    const effort = report.metrics.effort;

    doc.addPage();
    page += 1;
    pdfAddPageHeader(
      doc,
      'Effort estimate and variance',
      'Original Estimate, Time Spent and Remaining Estimate normalised to hours',
      page
    );

    [
      ['Original estimate', `${effort.originalEstimateHours}h`, [12, 102, 228]],
      ['Time spent', `${effort.timeSpentHours}h`, [34, 160, 107]],
      ['Remaining estimate', `${effort.remainingEstimateHours}h`, [226, 178, 3]],
      ['Forecast effort', `${effort.forecastHours}h`, [101, 84, 192]],
      ['Effort variance', `${effort.varianceHours}h`, [201, 55, 44]],
    ].forEach(([label, value, accent], index) => {
      pdfMetricCard(doc, {
        x: 12 + index * 56,
        y: 31,
        w: 51,
        h: 30,
        label,
        value,
        helper:
          label === 'Effort variance'
            ? `${effort.variancePercentage}%`
            : undefined,
        accent,
      });
    });

    pdfSetText(doc, [15, 39, 71], 10, 'bold');
    doc.text('Coverage', 14, 78);

    pdfHorizontalBars(
      doc,
      [
        {
          label: 'Original estimate coverage',
          value:
            effort.coverage
              ?.originalEstimateCoveragePercentage ?? 0,
          color: [12, 102, 228],
        },
        {
          label: 'Remaining estimate coverage',
          value:
            effort.coverage
              ?.remainingEstimateCoveragePercentage ?? 0,
          color: [226, 178, 3],
        },
        {
          label: 'Time-spent coverage',
          value:
            effort.coverage
              ?.timeSpentCoveragePercentage ?? 0,
          color: [34, 160, 107],
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
        : 'Forecast confidence',
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
      'Sprint scope history',
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
    const current = Number(
      history.currentScope?.storyPoints ?? 0
    );

    pdfHorizontalBars(
      doc,
      [
        { label: 'Original commitment', value: original, color: [12, 102, 228] },
        { label: 'Scope added', value: added, prefix: '+', color: [34, 160, 107] },
        { label: 'Scope removed', value: removed, prefix: '-', color: [201, 55, 44] },
        { label: 'Estimate revisions', value: estimateChange, prefix: estimateChange > 0 ? '+' : '', color: [226, 178, 3] },
        { label: 'Current scope', value: current, color: [101, 84, 192] },
      ],
      {
        x: 16,
        y: 38,
        w: 266,
        rowHeight: 18,
        labelWidth: 62,
      }
    );

    pdfSetText(doc, [15, 39, 71], 11, 'bold');
    doc.text(
      `${formatNumber(original)} committed + ${formatNumber(
        added
      )} added - ${formatNumber(removed)} removed ${
        estimateChange >= 0 ? '+' : '-'
      } ${formatNumber(
        Math.abs(estimateChange)
      )} estimate revision = ${formatNumber(current)} current points`,
      148.5,
      145,
      { align: 'center' }
    );

    [
      ['Original items', history.originalCommitment?.items ?? 0],
      ['Current items', history.currentScope?.items ?? 0],
      ['Added items', history.scopeChange?.addedItems ?? 0],
      ['Removed items', history.scopeChange?.removedItems ?? 0],
      ['Completed points', history.currentScope?.completedStoryPoints ?? 0],
      ['Remaining points', history.currentScope?.remainingStoryPoints ?? 0],
    ].forEach(([label, value], index) => {
      pdfMetricCard(doc, {
        x: 13 + index * 46,
        y: 160,
        w: 42,
        h: 24,
        label,
        value,
        accent: [12, 102, 228],
      });
    });
  }

  if (selectedSections.burndown && report.history?.available) {
    doc.addPage();
    page += 1;
    pdfAddPageHeader(
      doc,
      'Sprint burndown',
      'Daily story-point burndown compared with ideal sprint trajectory',
      page
    );

    pdfBurndown(
      doc,
      report.history.burndownDaily ??
        report.history.burndown ??
        [],
      {
        basis: 'points',
      }
    );
  }

  if (selectedSections.statusTypes) {
    doc.addPage();
    page += 1;
    pdfAddPageHeader(
      doc,
      'Status and work-item distribution',
      'Current sprint distribution by status, issue type and priority',
      page
    );

    pdfSetText(doc, [15, 39, 71], 10, 'bold');
    doc.text('Issues by status', 14, 34);

    pdfHorizontalBars(
      doc,
      Object.entries(report.metrics.statusCounts ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([label, value], index) => ({
          label,
          value,
          color: [
            [34, 160, 107],
            [12, 102, 228],
            [226, 178, 3],
            [201, 55, 44],
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

    pdfSetText(doc, [15, 39, 71], 10, 'bold');
    doc.text('Work-item types', 155, 34);

    pdfHorizontalBars(
      doc,
      Object.entries(report.metrics.typeCounts ?? {})
        .sort((a, b) => b[1] - a[1])
        .map(([label, value], index) => ({
          label,
          value,
          color: [
            [12, 102, 228],
            [226, 178, 3],
            [101, 84, 192],
            [201, 55, 44],
            [34, 160, 107],
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

    pdfSetText(doc, [15, 39, 71], 10, 'bold');
    doc.text('Priority profile', 14, 132);

    pdfHorizontalBars(
      doc,
      Object.entries(getPriorityCounts(filteredIssues))
        .sort((a, b) => b[1] - a[1])
        .map(([label, value], index) => ({
          label,
          value,
          color: [
            [201, 55, 44],
            [227, 73, 53],
            [245, 165, 36],
            [12, 102, 228],
            [34, 160, 107],
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
      'Sprint report',
      'Completed and incomplete delivery summary',
      page
    );

    [
      ['Completed items', report.sprintReport.completedCount, [34, 160, 107]],
      ['Incomplete items', report.sprintReport.incompleteCount, [226, 178, 3]],
      ['Completed points', report.sprintReport.completedStoryPoints, [34, 160, 107]],
      ['Incomplete points', report.sprintReport.incompleteStoryPoints, [226, 178, 3]],
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

    pdfSetText(doc, [15, 39, 71], 11, 'bold');
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

    pdfSetText(doc, [98, 111, 134], 9, 'normal');
    doc.text(
      `${formatNumber(
        report.sprintReport.completedStoryPoints
      )} completed of ${formatNumber(committed)} committed points`,
      18,
      132
    );
  }

  if (selectedSections.velocity && velocityReport?.velocity?.length) {
    doc.addPage();
    page += 1;
    pdfAddPageHeader(
      doc,
      'Velocity',
      `Recent closed sprints | Average completed: ${velocityReport.averageCompleted} story points`,
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

      pdfSetText(doc, [15, 39, 71], 8, 'bold');
      doc.text(item.sprintName, 14, y + 3);

      pdfSetText(doc, [98, 111, 134], 6.5, 'normal');
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

      pdfSetText(doc, [98, 111, 134], 6.5, 'normal');
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

      pdfSetText(doc, [15, 39, 71], 7, 'bold');
      doc.text(
        `${formatNumber(item.committedStoryPoints)} / ${formatNumber(
          item.completedStoryPoints
        )}`,
        275,
        y + 7,
        { align: 'right' }
      );
    });
  }

  if (selectedSections.teamWorkload) {
    doc.addPage();
    page += 1;
    pdfAddPageHeader(
      doc,
      'Team workload',
      'Assignee-level workload, remaining points and overdue work',
      page
    );

    autoTable(doc, {
      startY: 29,
      head: [[
        'Assignee',
        'Total',
        'Open',
        'Completed',
        'Story points',
        'Remaining points',
        'Original estimate',
        'Time spent',
        'Remaining estimate',
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
        textColor: [15, 39, 71],
        lineColor: [217, 226, 236],
        lineWidth: 0.2,
        overflow: 'linebreak',
      },
      headStyles: {
        fillColor: [15, 39, 71],
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
      'Scope, estimate and effort changes',
      'Jira history changes detected during the sprint',
      page
    );

    autoTable(doc, {
      startY: 29,
      head: [['Date', 'Key', 'Change']],
      body: [...report.history.events]
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
        textColor: [15, 39, 71],
        lineColor: [217, 226, 236],
        lineWidth: 0.2,
        overflow: 'linebreak',
      },
      headStyles: {
        fillColor: [15, 39, 71],
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
      'Sprint work items',
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
        textColor: [15, 39, 71],
        lineColor: [217, 226, 236],
        lineWidth: 0.15,
        overflow: 'linebreak',
        valign: 'middle',
      },
      headStyles: {
        fillColor: [15, 39, 71],
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
  nextSprintOutlook,
  velocityReport,
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
  nextSprintOutlook,
  velocityReport,
}) {
  const isFuture = report.sprint.state === 'future';
  const isClosed = report.sprint.state === 'closed';

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

      {outlookSummary ? (
        <div className="next-sprint-outlook-block">
          <div className="next-sprint-outlook-heading">
            <div>
              <span>Next sprint outlook</span>
              <strong>{outlookSummary.sprintName}</strong>
            </div>
            <span className="next-sprint-load-badge">
              {outlookSummary.velocityLoadPercentage > 0
                ? `${outlookSummary.velocityLoadPercentage}% of velocity`
                : 'No velocity baseline'}
            </span>
          </div>

          <p className="next-sprint-goal">
            <strong>Goal:</strong> {outlookSummary.goal}
          </p>

          <div className="next-sprint-outlook-metrics">
            <span>
              <strong>{outlookSummary.plannedPoints}</strong>
              planned points
            </span>
            <span>
              <strong>{outlookSummary.plannedItems}</strong>
              planned items
            </span>
            <span>
              <strong>{outlookSummary.carryOverItems}</strong>
              carry-over items
            </span>
            <span>
              <strong>{outlookSummary.carryOverPoints}</strong>
              carry-over points
            </span>
          </div>

          {outlookSummary.risks.length > 0 ? (
            <p className="next-sprint-risk-line">
              <strong>Planning checks:</strong>{' '}
              {outlookSummary.risks.join(' | ')}
            </p>
          ) : (
            <p className="next-sprint-ready-line">
              No immediate assignment, estimation, overdue, or defect warnings detected.
            </p>
          )}
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

  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [presentationFilters, setPresentationFilters] =
    useState(FILTER_DEFAULTS);
  const [usageStatus, setUsageStatus] = useState(null);
  const [presentationMode, setPresentationMode] = useState(false);
  const [exporting, setExporting] = useState('');
  const [reportMeta, setReportMeta] = useState(null);
  const [nextSprintOutlook, setNextSprintOutlook] = useState(null);


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

        const preferredProject =
          softwareProjects.find(
            (project) => project.key === 'HDP'
          ) ?? softwareProjects[0];

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
    if (!licenseStatus.active) {
      return;
    }

    if (!projectKey) {
      setBoards([]);
      setBoardId('');
      setSprints([]);
      setSprintId('');
      setReport(null);
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

    if (!boardId) {
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

  function handleIncludeSubtasksChange(event) {
    setIncludeSubtasks(event.target.checked);
    setReport(null);
    setVelocityReport(null);
    setNextSprintOutlook(null);
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
      setNextSprintOutlook(null);

      const [sprintResponse, velocityResult, outlookResult] =
        await Promise.all([
          invoke('getSprintReport', {
            sprintId: Number(sprintId),
            includeSubtasks,
          }),

          invoke('getVelocityReport', {
            boardId: Number(boardId),
            includeSubtasks,
          }),

          invoke('getNextSprintOutlook', {
            boardId: Number(boardId),
            currentSprintId: Number(sprintId),
            includeSubtasks,
          }),
        ]);

      const sprintResult =
        sprintResponse?.report ?? sprintResponse;

      setReport(sprintResult);
      setReportMeta(sprintResponse?.meta ?? null);
      setVelocityReport(velocityResult);
      setNextSprintOutlook(outlookResult);
      setPresentationFilters(FILTER_DEFAULTS);

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

    setPresentationMode(true);
  }

  function handleExitPresentation() {
    setPresentationMode(false);
  }

  async function handlePdfExport() {
    if (!report || exporting) {
      return;
    }

    try {
      setExporting('pdf');
      await registerExport('pdf');

      const pdf = await createPdfReport({
        report,
        velocityReport,
        nextSprintOutlook,
        projectKey,
        selectedSections: FULL_EXPORT_SECTIONS,
        filteredIssues: displayedIssues,
        readiness,
        deliveryStatus,
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
    if (!report || exporting) {
      return;
    }

    try {
      setExporting('pptx');
      await registerExport('pptx');

      const pptx = await createPowerPoint({
        report,
        velocityReport,
        nextSprintOutlook,
        projectKey,
        selectedSections: FULL_EXPORT_SECTIONS,
        filteredIssues: displayedIssues,
        readiness,
        deliveryStatus,
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
          <p className="eyebrow">StatusDeck licensing</p>
          <h1 id="licence-title">StatusDeck subscription required</h1>
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
            <button type="button" onClick={handlePdfExport}>
              {exporting === 'pdf' ? 'Generating PDF…' : 'PDF'}
            </button>
            <button type="button" onClick={handlePowerPointExport}>
              {exporting === 'pptx' ? 'Generating PPT…' : 'PowerPoint'}
            </button>
            <button
              type="button"
              className="presentation-exit-button"
              onClick={handleExitPresentation}
            >
              Exit presentation
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

          <div className="report-action-buttons">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setFilterPanelOpen((current) => !current)}
              disabled={!report}
            >
              Add filters
              {activeFilterCount > 0
                ? ` (${activeFilterCount})`
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
              onClick={handlePowerPointExport}
              disabled={!report || Boolean(exporting)}
            >
              {exporting === 'pptx'
                ? 'Generating PPT…'
                : 'Full PowerPoint'}
            </button>

            <button
              type="button"
              className="secondary-button"
              onClick={handlePdfExport}
              disabled={!report || Boolean(exporting)}
            >
              {exporting === 'pdf'
                ? 'Generating PDF…'
                : 'Full PDF'}
            </button>

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
        </div>
      </section>

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
              <p className="eyebrow">Optional presentation filters</p>
              <h3>Refine dashboard and exports</h3>
              <p>
                Headline sprint totals remain the full Jira sprint.
                Distribution charts, issue links, workload and exports use these filters.
              </p>
            </div>
            <button type="button" onClick={resetPresentationFilters}>
              Reset filters
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
                <option value="all">All assignees</option>
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
                <option value="all">All statuses</option>
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
                <option value="all">All priorities</option>
                {filterOptions.priorities.map((value) => (
                  <option value={value} key={value}>{value}</option>
                ))}
              </select>
            </label>

            <label>
              <span>Issue type</span>
              <select
                value={presentationFilters.issueType}
                onChange={(event) =>
                  updatePresentationFilter('issueType', event.target.value)
                }
              >
                <option value="all">All issue types</option>
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
                nextSprintOutlook={nextSprintOutlook}
                velocityReport={velocityReport}
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