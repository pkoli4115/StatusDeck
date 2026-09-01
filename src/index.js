import ForgeResolver from '@forge/resolver';
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';

const resolver = new ForgeResolver();

const PUBLIC_RESOLVERS = new Set(['getLicenseStatus']);

function getLicenseState(context) {
  const override = String(process.env.LICENSE_OVERRIDE ?? '')
    .trim()
    .toLowerCase();

  if (override === 'active' || override === 'trial') {
    return {
      active: true,
      state: override,
      source: 'environment-override',
    };
  }

  if (override === 'inactive') {
    return {
      active: false,
      state: 'inactive',
      source: 'environment-override',
    };
  }

  if (context?.license) {
    const active = context.license.active === true;
    const rawType = String(
      context.license.type ??
      context.license.licenseType ??
      context.license.entitlementType ??
      ''
    ).toLowerCase();

    const state = active
      ? rawType.includes('trial') || rawType.includes('evaluation')
        ? 'trial'
        : 'active'
      : 'inactive';

    return {
      active,
      state,
      source: 'forge',
    };
  }

  /*
   * Atlassian does not provide a license object for apps that are not yet
   * listed, free apps, or custom/non-production environments. Allow access in
   * that pre-listing/development situation so the app can still be tested.
   * Once the paid production listing is live, Forge supplies context.license.
   */
  return {
    active: true,
    state: 'unavailable',
    source: 'prelisting-or-development',
  };
}

function createLicenseError() {
  const error = new Error(
    'A valid StatusDeck subscription or trial is required.'
  );
  error.code = 'LICENSE_REQUIRED';
  return error;
}

function requireActiveLicense(context) {
  const license = getLicenseState(context);

  if (!license.active) {
    structuredLog('license_required', {
      installationId: getInstallationIdentity(context),
      userId: getUserIdentity(context),
      state: license.state,
      source: license.source,
    });
    throw createLicenseError();
  }

  return license;
}

function defineLicensedResolver(name, handler) {
  return resolver.define(name, async (request) => {
    if (!PUBLIC_RESOLVERS.has(name)) {
      requireActiveLicense(request?.context);
    }

    return handler(request);
  });
}

resolver.define('getLicenseStatus', ({ context }) => {
  const license = getLicenseState(context);

  return {
    active: license.active,
    state: license.state,
    source: license.source,
  };
});

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_CANDIDATES = 500;
const MAX_ISSUES_PER_REPORT = 500;
const VELOCITY_SPRINT_LIMIT = 7;

const USAGE_LIMITS = {
  reports: {
    hourly: 10,
    daily: 50,
  },
  pptx: {
    hourly: 5,
    daily: 10,
  },
  pdf: {
    hourly: 10,
    daily: 20,
  },
};

const FEATURE_FLAGS = {
  reportsEnabled: true,
  powerPointEnabled: true,
  pdfEnabled: true,
  manualRefreshEnabled: true,
  liveBurndownEnabled: true,
  changeHistoryEnabled: true,
  detailedWorkItemsEnabled: true,
  forceCachedReports: false,
  maximumIssuesPerReport: MAX_ISSUES_PER_REPORT,
  velocitySprintLimit: VELOCITY_SPRINT_LIMIT,
};

const activeOperations = new Set();

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeIdentifier(value) {
  return String(value ?? 'unknown')
    .replace(/[^a-zA-Z0-9:_-]/g, '_')
    .slice(0, 180);
}

function getWindowKeys(now = new Date()) {
  return {
    hour: now.toISOString().slice(0, 13),
    day: now.toISOString().slice(0, 10),
  };
}

function getUserIdentity(context) {
  return safeIdentifier(
    context?.accountId ??
    context?.principal?.accountId ??
    'anonymous'
  );
}

function getInstallationIdentity(context) {
  return safeIdentifier(
    context?.installContext ??
    context?.cloudId ??
    'installation'
  );
}

function structuredLog(event, details = {}) {
  console.log(JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    ...details,
  }));
}

async function requestJiraWithRetry(requestFactory, operationName, maxAttempts = 3) {
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    const response = await requestFactory();

    if (
      response.status !== 429 &&
      response.status !== 502 &&
      response.status !== 503 &&
      response.status !== 504
    ) {
      return response;
    }

    if (attempt >= maxAttempts) {
      return response;
    }

    const retryAfterHeader = response.headers?.get?.('Retry-After');
    const retryAfterSeconds = Number(retryAfterHeader);
    const fallbackMilliseconds = Math.min(
      8000,
      1000 * (2 ** (attempt - 1))
    );

    const delayMilliseconds =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : fallbackMilliseconds;

    structuredLog('jira_retry', {
      operationName,
      attempt,
      status: response.status,
      delayMilliseconds,
    });

    await wait(delayMilliseconds);
  }

  throw new Error(`${operationName} could not be completed.`);
}


async function jiraRequest(routeValue, options = {}, operationName = 'Jira request') {
  return requestJiraWithRetry(
    () => api.asUser().requestJira(routeValue, options),
    operationName
  );
}

async function readUsageRecord(context) {
  const userId = getUserIdentity(context);
  const key = `usage:${userId}`;
  const now = new Date();
  const windows = getWindowKeys(now);
  const existing = await kvs.get(key);

  const record = existing ?? {
    userId,
    hourKey: windows.hour,
    dayKey: windows.day,
    reportsHour: 0,
    reportsDay: 0,
    pptxHour: 0,
    pptxDay: 0,
    pdfHour: 0,
    pdfDay: 0,
  };

  if (record.hourKey !== windows.hour) {
    record.hourKey = windows.hour;
    record.reportsHour = 0;
    record.pptxHour = 0;
    record.pdfHour = 0;
  }

  if (record.dayKey !== windows.day) {
    record.dayKey = windows.day;
    record.reportsDay = 0;
    record.pptxDay = 0;
    record.pdfDay = 0;
  }

  return { key, record };
}

function buildUsageStatus(record) {
  return {
    reports: {
      hourlyUsed: record.reportsHour ?? 0,
      hourlyLimit: USAGE_LIMITS.reports.hourly,
      dailyUsed: record.reportsDay ?? 0,
      dailyLimit: USAGE_LIMITS.reports.daily,
    },
    powerPoints: {
      hourlyUsed: record.pptxHour ?? 0,
      hourlyLimit: USAGE_LIMITS.pptx.hourly,
      dailyUsed: record.pptxDay ?? 0,
      dailyLimit: USAGE_LIMITS.pptx.daily,
    },
    pdfs: {
      hourlyUsed: record.pdfHour ?? 0,
      hourlyLimit: USAGE_LIMITS.pdf.hourly,
      dailyUsed: record.pdfDay ?? 0,
      dailyLimit: USAGE_LIMITS.pdf.daily,
    },
    featureFlags: FEATURE_FLAGS,
  };
}

async function consumeUsage(context, operation) {
  const { key, record } = await readUsageRecord(context);

  const mapping = {
    report: {
      hourField: 'reportsHour',
      dayField: 'reportsDay',
      limits: USAGE_LIMITS.reports,
      label: 'report',
    },
    pptx: {
      hourField: 'pptxHour',
      dayField: 'pptxDay',
      limits: USAGE_LIMITS.pptx,
      label: 'PowerPoint',
    },
    pdf: {
      hourField: 'pdfHour',
      dayField: 'pdfDay',
      limits: USAGE_LIMITS.pdf,
      label: 'PDF',
    },
  };

  const config = mapping[operation];

  if (!config) {
    throw new Error('Unsupported usage operation.');
  }

  if ((record[config.hourField] ?? 0) >= config.limits.hourly) {
    throw new Error(
      `${config.label} hourly limit reached (${config.limits.hourly}).`
    );
  }

  if ((record[config.dayField] ?? 0) >= config.limits.daily) {
    throw new Error(
      `${config.label} daily limit reached (${config.limits.daily}).`
    );
  }

  record[config.hourField] = (record[config.hourField] ?? 0) + 1;
  record[config.dayField] = (record[config.dayField] ?? 0) + 1;

  await kvs.set(key, record);

  return buildUsageStatus(record);
}

async function withUserOperationLock(context, operation, work) {
  const userId = getUserIdentity(context);
  const lockKey = `${userId}:${operation}`;

  if (activeOperations.has(lockKey)) {
    throw new Error(
      `Another ${operation} operation is already running for your account.`
    );
  }

  activeOperations.add(lockKey);

  try {
    return await work();
  } finally {
    activeOperations.delete(lockKey);
  }
}

function getReportCacheKey({
  userId,
  sprintId,
  includeSubtasks,
  boardId = 'none',
  estimationOverride = '',
  acceptanceCriteriaFieldId = '',
}) {
  return `report-cache-v6:${safeIdentifier(userId)}:${sprintId}:${includeSubtasks ? '1' : '0'}:${safeIdentifier(boardId)}:${safeIdentifier(estimationOverride || 'board-default')}:${safeIdentifier(acceptanceCriteriaFieldId || 'ac-auto')}`;
}

function getVelocityCacheKey({
  userId,
  boardId,
  includeSubtasks,
  estimationOverride = '',
}) {
  return `velocity-cache:${safeIdentifier(userId)}:${boardId}:${includeSubtasks ? '1' : '0'}:${safeIdentifier(estimationOverride || 'board-default')}`;
}

function getOutlookCacheKey({
  userId,
  boardId,
  currentSprintId,
  includeSubtasks,
  estimationOverride = '',
  acceptanceCriteriaFieldId = '',
}) {
  return `outlook-cache-v5:${safeIdentifier(userId)}:${boardId}:${currentSprintId}:${includeSubtasks ? '1' : '0'}:${safeIdentifier(estimationOverride || 'board-default')}:${safeIdentifier(acceptanceCriteriaFieldId || 'ac-auto')}`;
}

const KVS_CACHE_SAFE_BYTES = 220 * 1024;

async function getCachedValue(key) {
  try {
    const cached = await kvs.get(key);

    if (!cached?.expiresAt || Date.now() >= cached.expiresAt) {
      if (cached) {
        try {
          await kvs.delete(key);
        } catch (caughtError) {
          structuredLog('kvs_cache_delete_failed', {
            key,
            message: String(caughtError?.message ?? caughtError),
          });
        }
      }

      return null;
    }

    return cached;
  } catch (caughtError) {
    // Report caches are an optimisation only. A temporary KVS problem must not
    // prevent StatusDeck from generating a fresh report from Jira.
    structuredLog('kvs_cache_read_failed', {
      key,
      message: String(caughtError?.message ?? caughtError),
    });
    return null;
  }
}

async function setCachedValue(key, value, ttlMilliseconds) {
  const cacheRecord = {
    value,
    generatedAt: new Date().toISOString(),
    expiresAt: Date.now() + ttlMilliseconds,
  };

  // Forge KVS values are limited to 240 KiB. Sprint reports can legitimately
  // exceed that size on enterprise boards because reportResult contains
  // detailed issue/history data used by drill-down and exports. Keep a safety
  // margin and simply skip caching oversized reports instead of failing the
  // user-visible report operation.
  let rawBytes = 0;
  try {
    rawBytes = Buffer.byteLength(JSON.stringify(cacheRecord), 'utf8');
  } catch (caughtError) {
    structuredLog('kvs_cache_serialization_failed', {
      key,
      message: String(caughtError?.message ?? caughtError),
    });
    return false;
  }

  if (rawBytes > KVS_CACHE_SAFE_BYTES) {
    structuredLog('kvs_cache_skipped_oversize', {
      key,
      rawBytes,
      safeLimitBytes: KVS_CACHE_SAFE_BYTES,
    });
    return false;
  }

  try {
    await kvs.set(key, cacheRecord);
    return true;
  } catch (caughtError) {
    // Caching is non-critical. Jira remains the source of truth and the
    // generated report should still be returned if KVS rejects the cache write.
    structuredLog('kvs_cache_write_failed', {
      key,
      rawBytes,
      code: caughtError?.code ?? null,
      message: String(caughtError?.message ?? caughtError),
    });
    return false;
  }
}


async function readJson(response, operationName) {
  if (!response.ok) {
    const body = await response.text();

    console.error(`${operationName} failed`, {
      status: response.status,
      body,
    });

    if (response.status === 429) {
      const retryAfter = response.headers?.get?.('Retry-After');

      throw new Error(
        retryAfter
          ? `Jira is temporarily rate limiting requests. Retry after ${retryAfter} seconds.`
          : 'Jira is temporarily rate limiting requests. Please try again shortly.'
      );
    }

    throw new Error(
      `${operationName} failed with Jira response ${response.status}.`
    );
  }

  return response.json();
}

function parseDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}


function startOfDay(value) {
  const date = parseDate(value);

  if (!date) {
    return null;
  }

  date.setHours(0, 0, 0, 0);
  return date;
}

function roundNumber(value, decimals = 2) {
  const factor = 10 ** decimals;

  return Math.round((Number(value) || 0) * factor) / factor;
}

function secondsToHours(value) {
  return roundNumber((Number(value) || 0) / 3600, 2);
}

function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase();
}

/*
 * Jira Cloud descriptions are commonly Atlassian Document Format (ADF).
 * Future-sprint readiness only needs a bounded, deterministic signal showing
 * whether Acceptance Criteria are present; StatusDeck does not retain or
 * return the full description solely for this check.
 */
function jiraDescriptionToPlainText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => jiraDescriptionToPlainText(item)).filter(Boolean).join('\n');
  }
  if (typeof value !== 'object') return '';

  const ownText = typeof value.text === 'string' ? value.text : '';
  const contentText = Array.isArray(value.content)
    ? value.content.map((item) => jiraDescriptionToPlainText(item)).filter(Boolean).join(value.type === 'paragraph' ? ' ' : '\n')
    : '';

  if (value.type === 'hardBreak') return '\n';
  return [ownText, contentText].filter(Boolean).join(ownText && contentText ? ' ' : '');
}

function adfNodeText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    return node.map((item) => adfNodeText(item)).filter(Boolean).join(' ');
  }
  if (typeof node !== 'object') return '';

  const ownText = typeof node.text === 'string' ? node.text : '';
  const contentText = Array.isArray(node.content)
    ? node.content.map((item) => adfNodeText(item)).filter(Boolean).join(' ')
    : '';

  return [ownText, contentText].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function isAcceptanceCriteriaHeadingText(value) {
  return /^(?:acceptance\s+criteria|acceptance\s+criterion|acceptance\s+conditions?|ac)\s*[:\-]?\s*$/i.test(String(value ?? '').trim());
}

function extractAcceptanceCriteriaBlocks(description) {
  if (!description) return [];

  if (typeof description === 'string') {
    const lines = description.replace(/\r/g, '').split('\n');
    return lines.map((rawLine) => {
      const line = String(rawLine ?? '').trim();
      if (!line) return { kind: 'blank', text: '' };

      const markdownHeading = line.match(/^#{1,6}\s+(.+)$/);
      if (markdownHeading) {
        return { kind: 'heading', text: markdownHeading[1].trim(), level: (line.match(/^#+/) || ['#'])[0].length };
      }

      if (isAcceptanceCriteriaHeadingText(line)) {
        return { kind: 'heading', text: line.replace(/[:\-]\s*$/, '').trim(), level: 2 };
      }

      const inlineHeading = line.match(/^(?:acceptance\s+criteria|acceptance\s+criterion|acceptance\s+conditions?|ac)\s*[:\-]\s*(.+)$/i);
      if (inlineHeading) {
        return { kind: 'acceptance-inline', text: inlineHeading[1].trim() };
      }

      const checkbox = line.match(/^[-*+]\s*\[([xX ])\]\s*(.+)$/);
      if (checkbox) {
        return {
          kind: 'task',
          text: checkbox[2].trim(),
          state: checkbox[1].toLowerCase() === 'x' ? 'done' : 'todo',
        };
      }

      const listItem = line.match(/^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/);
      if (listItem) {
        return { kind: 'list', text: listItem[1].trim() };
      }

      const likelySectionHeading = line.match(/^(definition\s+of\s+done|description|notes?|dependencies|technical\s+notes?|business\s+rules?|out\s+of\s+scope|test\s+cases?|attachments?|implementation)\s*:?$/i);
      if (likelySectionHeading) {
        return { kind: 'heading', text: line.replace(/:\s*$/, '').trim(), level: 2 };
      }

      return { kind: 'paragraph', text: line };
    });
  }

  if (typeof description !== 'object') return [];

  const blocks = [];

  function visit(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (typeof node !== 'object') return;

    const type = String(node.type ?? '');

    if (type === 'heading') {
      const text = adfNodeText(node);
      if (text) blocks.push({ kind: 'heading', text, level: Number(node.attrs?.level ?? 2) || 2 });
      return;
    }

    if (type === 'taskItem') {
      const text = adfNodeText(node);
      const rawState = normalizeText(node.attrs?.state);
      const state = ['done', 'complete', 'completed', 'checked'].includes(rawState)
        ? 'done'
        : ['todo', 'incomplete', 'open', 'unchecked'].includes(rawState)
          ? 'todo'
          : 'unknown';
      if (text) blocks.push({ kind: 'task', text, state });
      return;
    }

    if (type === 'listItem') {
      const directText = (node.content ?? [])
        .filter((child) => !['bulletList', 'orderedList', 'taskList'].includes(String(child?.type ?? '')))
        .map((child) => adfNodeText(child))
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (directText) blocks.push({ kind: 'list', text: directText });
      (node.content ?? [])
        .filter((child) => ['bulletList', 'orderedList', 'taskList'].includes(String(child?.type ?? '')))
        .forEach(visit);
      return;
    }

    if (type === 'paragraph') {
      const text = adfNodeText(node);
      if (text) blocks.push({ kind: 'paragraph', text });
      return;
    }

    (node.content ?? []).forEach(visit);
  }

  visit(description);
  return blocks;
}

function summarizeCriteriaStates(criteria) {
  const metCriteria = criteria.filter((item) => item.state === 'done').length;
  const notMetCriteria = criteria.filter((item) => item.state === 'todo').length;
  const trackableCriteria = metCriteria + notMetCriteria;
  const totalCriteria = criteria.length;
  const unrecordedCriteria = Math.max(0, totalCriteria - trackableCriteria);

  return {
    totalCriteria,
    metCriteria,
    notMetCriteria,
    trackableCriteria,
    unrecordedCriteria,
    completionPercentage: trackableCriteria > 0
      ? roundNumber((metCriteria / trackableCriteria) * 100, 1)
      : null,
  };
}

function detectAcceptanceCriteria(description) {
  const text = jiraDescriptionToPlainText(description)
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!text) {
    return {
      detected: false,
      status: 'no-description',
      method: null,
      totalCriteria: 0,
      metCriteria: 0,
      notMetCriteria: 0,
      trackableCriteria: 0,
      unrecordedCriteria: 0,
      completionPercentage: null,
    };
  }

  const blocks = extractAcceptanceCriteriaBlocks(description);
  const headingPattern = /(?:^|\n)\s*(?:acceptance\s+criteria|acceptance\s+criterion|acceptance\s+conditions?|ac)\s*[:\-]?\s*(?:\n|$)/im;
  const inlineHeadingPattern = /\b(?:acceptance\s+criteria|acceptance\s+criterion|acceptance\s+conditions?)\s*[:\-]/i;
  const hasHeading = headingPattern.test(text) || inlineHeadingPattern.test(text) || blocks.some((block) => block.kind === 'heading' && isAcceptanceCriteriaHeadingText(block.text)) || blocks.some((block) => block.kind === 'acceptance-inline');

  const hasGiven = /(?:^|\n|[.!?]\s+)\s*given\b/i.test(text);
  const hasWhen = /(?:^|\n|[.!?]\s+)\s*when\b/i.test(text);
  const hasThen = /(?:^|\n|[.!?]\s+)\s*then\b/i.test(text);
  const hasGivenWhenThen = hasGiven && hasWhen && hasThen;

  const criteria = [];
  let inAcceptanceSection = false;
  let acceptanceHeadingLevel = null;

  for (const block of blocks) {
    if (block.kind === 'heading') {
      if (isAcceptanceCriteriaHeadingText(block.text)) {
        inAcceptanceSection = true;
        acceptanceHeadingLevel = Number(block.level ?? 2) || 2;
        continue;
      }

      if (inAcceptanceSection && Number(block.level ?? 2) <= acceptanceHeadingLevel) {
        inAcceptanceSection = false;
      }
      continue;
    }

    if (block.kind === 'acceptance-inline') {
      if (block.text) criteria.push({ state: 'unknown' });
      continue;
    }

    if (!inAcceptanceSection) continue;

    if (block.kind === 'task') {
      criteria.push({ state: block.state === 'done' ? 'done' : block.state === 'todo' ? 'todo' : 'unknown' });
      continue;
    }

    if (block.kind === 'list') {
      criteria.push({ state: 'unknown' });
      continue;
    }

    if (block.kind === 'paragraph' && block.text) {
      const checkboxMatches = [...block.text.matchAll(/\[([xX ])\]\s*([^\[]+)/g)];
      if (checkboxMatches.length) {
        checkboxMatches.forEach((match) => criteria.push({ state: match[1].toLowerCase() === 'x' ? 'done' : 'todo' }));
      } else {
        const startsWithGivenOrWhen = /^\s*(?:given|when)\b/i.test(block.text);
        const thenMatches = block.text.match(/\bthen\b/gi) ?? [];
        if (thenMatches.length) {
          thenMatches.forEach(() => criteria.push({ state: 'unknown' }));
        } else if (!startsWithGivenOrWhen) {
          criteria.push({ state: 'unknown' });
        }
      }
    }
  }

  if (!hasHeading && hasGivenWhenThen) {
    const thenMatches = text.match(/(?:^|\n|[.!?]\s+)\s*then\b/gim) ?? [];
    const count = Math.max(1, thenMatches.length);
    for (let index = 0; index < count; index += 1) criteria.push({ state: 'unknown' });
  }

  const stateSummary = summarizeCriteriaStates(criteria);
  const signalDetected = hasHeading || hasGivenWhenThen;
  const detected = signalDetected && stateSummary.totalCriteria > 0;

  return {
    detected,
    status: detected ? 'detected' : signalDetected ? 'empty-criteria' : 'not-detected',
    method: hasHeading ? 'acceptance-criteria-heading' : hasGivenWhenThen ? 'given-when-then' : null,
    ...stateSummary,
  };
}

function isStoryForAcceptanceCriteria(issue) {
  const type = normalizeText(issue?.issueType);
  return type === 'story' || type === 'user story' || type.endsWith(' story');
}

function summarizeAcceptanceCriteria(issues) {
  const stories = (issues ?? []).filter(isStoryForAcceptanceCriteria);
  const detected = stories.filter((issue) => issue.acceptanceCriteria?.detected);
  const noDescription = stories.filter((issue) => issue.acceptanceCriteria?.status === 'no-description');
  const emptyCriteria = stories.filter((issue) => issue.acceptanceCriteria?.status === 'empty-criteria');
  const notDetected = stories.filter((issue) => issue.acceptanceCriteria?.status === 'not-detected');
  const eligibleStories = stories.length;
  const detectedStories = detected.length;
  const totalCriteria = stories.reduce((sum, issue) => sum + Number(issue.acceptanceCriteria?.totalCriteria ?? 0), 0);
  const metCriteria = stories.reduce((sum, issue) => sum + Number(issue.acceptanceCriteria?.metCriteria ?? 0), 0);
  const notMetCriteria = stories.reduce((sum, issue) => sum + Number(issue.acceptanceCriteria?.notMetCriteria ?? 0), 0);
  const trackableCriteria = metCriteria + notMetCriteria;
  const unrecordedCriteria = Math.max(0, totalCriteria - trackableCriteria);

  const issueBreakdown = stories.map((issue) => ({
    key: issue.key,
    criteriaTotal: Number(issue.acceptanceCriteria?.totalCriteria ?? 0),
    metCriteria: Number(issue.acceptanceCriteria?.metCriteria ?? 0),
    notMetCriteria: Number(issue.acceptanceCriteria?.notMetCriteria ?? 0),
    unrecordedCriteria: Number(issue.acceptanceCriteria?.unrecordedCriteria ?? 0),
    trackableCriteria: Number(issue.acceptanceCriteria?.trackableCriteria ?? 0),
    completionPercentage: issue.acceptanceCriteria?.completionPercentage ?? null,
  }));

  return {
    enabled: true,
    eligibleStories,
    detectedStories,
    missingStories: Math.max(0, eligibleStories - detectedStories),
    noDescriptionStories: noDescription.length,
    emptyCriteriaStories: emptyCriteria.length,
    notDetectedStories: notDetected.length,
    coveragePercentage: eligibleStories > 0
      ? roundNumber((detectedStories / eligibleStories) * 100, 1)
      : null,
    totalCriteria,
    metCriteria,
    notMetCriteria,
    trackableCriteria,
    unrecordedCriteria,
    completionPercentage: trackableCriteria > 0
      ? roundNumber((metCriteria / trackableCriteria) * 100, 1)
      : null,
    detectedKeys: detected.map((issue) => issue.key),
    missingKeys: stories.filter((issue) => !issue.acceptanceCriteria?.detected).map((issue) => issue.key),
    noDescriptionKeys: noDescription.map((issue) => issue.key),
    emptyCriteriaKeys: emptyCriteria.map((issue) => issue.key),
    notDetectedKeys: notDetected.map((issue) => issue.key),
    metKeys: stories.filter((issue) => Number(issue.acceptanceCriteria?.metCriteria ?? 0) > 0).map((issue) => issue.key),
    notMetKeys: stories.filter((issue) => Number(issue.acceptanceCriteria?.notMetCriteria ?? 0) > 0).map((issue) => issue.key),
    unrecordedKeys: stories.filter((issue) => Number(issue.acceptanceCriteria?.unrecordedCriteria ?? 0) > 0).map((issue) => issue.key),
    issueBreakdown,
    detectionRule: 'Story descriptions: Acceptance Criteria/AC heading or Given-When-Then structure; checkbox/task state is used only when Jira explicitly records it',
  };
}


function hasMeaningfulJiraFieldValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(hasMeaningfulJiraFieldValue);
  if (typeof value === 'object') return jiraDescriptionToPlainText(value).trim().length > 0 || Object.keys(value).length > 0;
  return false;
}

function detectMappedAcceptanceCriteria(value) {
  const text = jiraDescriptionToPlainText(value).trim();
  if (!text) return detectAcceptanceCriteria(null);
  const detected = detectAcceptanceCriteria(`Acceptance Criteria
${text}`);
  return {
    ...detected,
    detected: true,
    status: 'detected',
    method: 'mapped-field',
  };
}

function resolveAcceptanceCriteriaField(allFields, requestedFieldId = '') {
  const requested = String(requestedFieldId ?? '').trim();
  const fields = Array.isArray(allFields) ? allFields : [];
  if (requested === 'description') return { id: 'description', name: 'Description', source: 'configured' };
  if (requested) {
    const exact = fields.find((field) => String(field?.id ?? '') === requested);
    if (exact) return { id: exact.id, name: exact.name || exact.id, source: 'configured' };
  }
  const likely = fields.find((field) => /acceptance\s*(criteria|criterion|conditions?)|\bAC\b/i.test(String(field?.name ?? '')));
  if (likely) return { id: likely.id, name: likely.name || likely.id, source: 'auto-detected' };
  return { id: 'description', name: 'Description', source: 'description' };
}

function linkedIssueSummary(link) {
  const outward = link?.outwardIssue ?? null;
  const inward = link?.inwardIssue ?? null;
  const linked = outward || inward;
  if (!linked) return null;
  const fields = linked.fields ?? {};
  return {
    key: linked.key ?? null,
    direction: outward ? 'outward' : 'inward',
    relationship: outward ? (link?.type?.outward ?? link?.type?.name ?? 'links to') : (link?.type?.inward ?? link?.type?.name ?? 'linked from'),
    issueType: fields.issuetype?.name ?? 'Unknown',
    status: fields.status?.name ?? 'Unknown',
    statusCategoryKey: fields.status?.statusCategory?.key ?? 'undefined',
    summary: fields.summary ?? '',
  };
}

function isRequirementLikeTraceIssue(issue) {
  const type = normalizeText(issue?.issueType);
  return /^(epic|requirement|feature|capability|initiative)$/.test(type) || type.includes('requirement');
}

function isTestEvidenceTraceIssue(issue) {
  const type = normalizeText(issue?.issueType);
  return type.includes('test') || type === 'qa' || type.includes('quality assurance');
}

function isDefectTraceIssue(issue) {
  const type = normalizeText(issue?.issueType);
  return type === 'bug' || type === 'defect' || type.includes('defect');
}

function summarizeTraceability(issues) {
  const stories = (issues ?? []).filter(isStoryForAcceptanceCriteria);
  const rows = stories.map((issue) => {
    const links = Array.isArray(issue.linkedIssues) ? issue.linkedIssues : [];
    const parentLinked = Boolean(issue.parentKey) || links.some(isRequirementLikeTraceIssue);
    const acceptanceCriteria = Boolean(issue.acceptanceCriteria?.detected);
    const testEvidence = links.some(isTestEvidenceTraceIssue);
    const linkedDefects = links.filter(isDefectTraceIssue);
    const releaseMapped = Array.isArray(issue.fixVersions) && issue.fixVersions.length > 0;
    return {
      key: issue.key,
      parentLinked,
      acceptanceCriteria,
      testEvidence,
      releaseMapped,
      linkedDefectCount: linkedDefects.length,
      openLinkedDefectCount: linkedDefects.filter((linked) => linked.statusCategoryKey !== 'done').length,
    };
  });
  const total = rows.length;
  const count = (field) => rows.filter((row) => Boolean(row[field])).length;
  const pct = (value) => total > 0 ? roundNumber((value / total) * 100, 1) : null;
  const parentLinkedStories = count('parentLinked');
  const acceptanceCriteriaStories = count('acceptanceCriteria');
  const testEvidenceStories = count('testEvidence');
  const releaseMappedStories = count('releaseMapped');
  const storiesWithLinkedDefects = rows.filter((row) => row.linkedDefectCount > 0).length;
  const storiesWithOpenLinkedDefects = rows.filter((row) => row.openLinkedDefectCount > 0).length;
  const criticalGapKeys = rows.filter((row) => !row.parentLinked || !row.acceptanceCriteria).map((row) => row.key);
  const evidenceGapKeys = rows.filter((row) => !row.testEvidence || !row.releaseMapped).map((row) => row.key);
  return {
    enabled: true,
    eligibleStories: total,
    parentLinkedStories,
    parentCoveragePercentage: pct(parentLinkedStories),
    acceptanceCriteriaStories,
    acceptanceCriteriaCoveragePercentage: pct(acceptanceCriteriaStories),
    testEvidenceStories,
    testEvidenceCoveragePercentage: pct(testEvidenceStories),
    releaseMappedStories,
    releaseCoveragePercentage: pct(releaseMappedStories),
    storiesWithLinkedDefects,
    storiesWithOpenLinkedDefects,
    criticalGapKeys,
    evidenceGapKeys,
    issueBreakdown: rows,
    methodology: 'Story-level evidence from Jira parent/issue links, Acceptance Criteria, linked test-type work items, linked defects and Fix Version mapping. StatusDeck does not infer links that Jira does not record.',
  };
}

function parseNumericValue(primaryValue, displayValue) {
  const candidates = [primaryValue, displayValue];

  for (const candidate of candidates) {
    if (
      typeof candidate === 'number' &&
      Number.isFinite(candidate)
    ) {
      return candidate;
    }

    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();

      if (!trimmed) {
        continue;
      }

      const number = Number(trimmed);

      if (Number.isFinite(number)) {
        return number;
      }

      const extracted = trimmed.match(/-?\d+(?:\.\d+)?/);

      if (extracted) {
        const extractedNumber = Number(extracted[0]);

        if (Number.isFinite(extractedNumber)) {
          return extractedNumber;
        }
      }
    }
  }

  return 0;
}

function parseJiraDurationSeconds(primaryValue, displayValue) {
  if (
    typeof primaryValue === 'number' &&
    Number.isFinite(primaryValue)
  ) {
    return primaryValue;
  }

  if (typeof primaryValue === 'string') {
    const trimmed = primaryValue.trim();

    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      return Number(trimmed);
    }
  }

  const text = String(displayValue ?? primaryValue ?? '').trim();

  if (!text) {
    return 0;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(text)) {
    return Number(text);
  }

  const unitSeconds = {
    w: 5 * 8 * 60 * 60,
    d: 8 * 60 * 60,
    h: 60 * 60,
    m: 60,
    s: 1,
  };

  let total = 0;
  let matched = false;
  const pattern = /(-?\d+(?:\.\d+)?)\s*([wdhms])/gi;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    matched = true;
    total += Number(match[1]) * unitSeconds[match[2].toLowerCase()];
  }

  return matched ? total : 0;
}

function getZonedParts(value, timeZone) {
  const date = parseDate(value);

  if (!date) {
    return null;
  }

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  );

  return parts;
}

function toZonedDateKey(value, timeZone) {
  const parts = getZonedParts(value, timeZone);

  if (!parts) {
    return null;
  }

  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0'),
  ].join('-');
}

function addCalendarDays(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));

  return date.toISOString().slice(0, 10);
}

function zonedDateTimeToUtc(
  dateKey,
  timeZone,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0
) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const targetAsUtc = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second,
    millisecond
  );

  let guess = targetAsUtc;

  for (let index = 0; index < 4; index += 1) {
    const parts = getZonedParts(new Date(guess), timeZone);

    if (!parts) {
      break;
    }

    const representedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      0
    );

    guess += targetAsUtc - representedAsUtc;
  }

  return new Date(guess);
}

function startOfZonedDay(value, timeZone) {
  const dateKey = toZonedDateKey(value, timeZone);

  return dateKey
    ? zonedDateTimeToUtc(dateKey, timeZone, 0, 0, 0, 0)
    : null;
}

function endOfZonedDay(value, timeZone) {
  const dateKey = toZonedDateKey(value, timeZone);

  if (!dateKey) {
    return null;
  }

  const nextDateKey = addCalendarDays(dateKey, 1);

  return new Date(
    zonedDateTimeToUtc(nextDateKey, timeZone, 0, 0, 0, 0).getTime() - 1
  );
}

function toDateOnly(value, timeZone = 'UTC') {
  return toZonedDateKey(value, timeZone);
}

function containsSprintReference(
  value,
  displayValue,
  sprintId,
  sprintName
) {
  const idText = String(sprintId);
  const nameText = normalizeText(sprintName);

  const combined = [
    typeof value === 'string'
      ? value
      : JSON.stringify(value ?? ''),
    String(displayValue ?? ''),
  ].join(' ');

  const normalized = normalizeText(combined);

  if (!normalized) {
    return false;
  }

  const idPatterns = [
    new RegExp(`(^|[^0-9])${idText}([^0-9]|$)`),
    new RegExp(`id[=: ]+${idText}([^0-9]|$)`),
  ];

  if (idPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  return Boolean(
    nameText &&
      normalized.includes(nameText)
  );
}

function isSprintChange(item, sprintFieldId) {
  const fieldId = String(item?.fieldId ?? '');
  const fieldName = normalizeText(item?.field);

  return (
    fieldId === sprintFieldId ||
    fieldName === 'sprint'
  );
}

function isStoryPointChange(item, storyPointFieldId) {
  if (!storyPointFieldId || storyPointFieldId === ISSUE_COUNT_ESTIMATION_FIELD_ID) {
    return false;
  }

  if (storyPointFieldId === ORIGINAL_ESTIMATE_FIELD_ID) {
    return isOriginalEstimateChange(item);
  }

  const fieldId = String(item?.fieldId ?? '');
  const fieldName = normalizeText(item?.field);

  return (
    fieldId === storyPointFieldId ||
    (!fieldId && (fieldName === 'story points' || fieldName === 'story point estimate'))
  );
}

function isStatusChange(item) {
  const fieldId = normalizeText(item?.fieldId);
  const fieldName = normalizeText(item?.field);

  return (
    fieldId === 'status' ||
    fieldName === 'status'
  );
}

function isOriginalEstimateChange(item) {
  const fieldId = normalizeText(item?.fieldId);
  const fieldName = normalizeText(item?.field);

  return (
    fieldId === 'timeoriginalestimate' ||
    fieldName === 'original estimate'
  );
}

function isRemainingEstimateChange(item) {
  const fieldId = normalizeText(item?.fieldId);
  const fieldName = normalizeText(item?.field);

  return (
    fieldId === 'timeestimate' ||
    fieldName === 'remaining estimate'
  );
}

function isTimeSpentChange(item) {
  const fieldId = normalizeText(item?.fieldId);
  const fieldName = normalizeText(item?.field);

  return (
    fieldId === 'timespent' ||
    fieldName === 'time spent'
  );
}

async function discoverReportingFields() {
  const response = await jiraRequest(
    route`/rest/api/3/field`,
    {
      headers: {
        Accept: 'application/json',
      },
    }
  );

  const fields = await readJson(
    response,
    'Loading Jira fields'
  );

  const storyPointField =
    fields.find(
      (field) =>
        field.schema?.custom ===
          'com.atlassian.jira.plugin.system.customfieldtypes:float' &&
        /^(story points|story point estimate)$/i.test(
          field.name
        )
    ) ??
    fields.find((field) =>
      /story point/i.test(field.name)
    );

  const sprintField =
    fields.find(
      (field) =>
        field.schema?.custom ===
        'com.pyxis.greenhopper.jira:gh-sprint'
    ) ??
    fields.find(
      (field) =>
        /^sprint$/i.test(field.name)
    );

  return {
    storyPoints: storyPointField
      ? {
          id: storyPointField.id,
          name: storyPointField.name,
        }
      : null,

    sprint: sprintField
      ? {
          id: sprintField.id,
          name: sprintField.name,
        }
      : null,

    allFields: fields,
  };
}

const ISSUE_COUNT_ESTIMATION_FIELD_ID = '__statusdeck_issue_count__';
const ORIGINAL_ESTIMATE_FIELD_ID = 'timeoriginalestimate';

function requestableEstimationFieldId(fieldId) {
  const value = String(fieldId ?? '').trim();
  if (!value || value === ISSUE_COUNT_ESTIMATION_FIELD_ID || value.startsWith('__statusdeck_')) {
    return null;
  }
  return value;
}

function estimationValueFromIssueFields(fields, estimationFieldId, originalEstimateSeconds = 0) {
  if (estimationFieldId === ISSUE_COUNT_ESTIMATION_FIELD_ID) {
    return 1;
  }

  if (estimationFieldId === ORIGINAL_ESTIMATE_FIELD_ID) {
    return secondsToHours(originalEstimateSeconds);
  }

  const raw = estimationFieldId ? fields?.[estimationFieldId] : null;
  return typeof raw === 'number' ? raw : parseNumericValue(raw, raw);
}

function estimationValueFromHistoryItem(item, estimationFieldId) {
  if (estimationFieldId === ORIGINAL_ESTIMATE_FIELD_ID) {
    return secondsToHours(parseJiraDurationSeconds(item?.to, item?.toString));
  }

  return parseNumericValue(item?.to, item?.toString);
}

function estimationPreviousValueFromHistoryItem(item, estimationFieldId) {
  if (estimationFieldId === ORIGINAL_ESTIMATE_FIELD_ID) {
    return secondsToHours(parseJiraDurationSeconds(item?.from, item?.fromString));
  }

  return parseNumericValue(item?.from, item?.fromString);
}

async function resolveReportingEstimationSource({ boardId, estimationOverride, reportingFields }) {
  const override = String(estimationOverride ?? '').trim();
  const fields = Array.isArray(reportingFields?.allFields) ? reportingFields.allFields : [];
  const fieldById = new Map(fields.map((field) => [String(field?.id ?? ''), field]));

  const fromFieldId = (fieldId, source) => {
    if (fieldId === ORIGINAL_ESTIMATE_FIELD_ID) {
      return {
        type: 'originalEstimate',
        fieldId: ORIGINAL_ESTIMATE_FIELD_ID,
        name: 'Original Estimate',
        unit: 'hours',
        source,
      };
    }

    const field = fieldById.get(String(fieldId ?? ''));
    if (!field) return null;
    const schemaType = String(field?.schema?.type ?? '').toLowerCase();
    if (!['number', 'integer'].includes(schemaType)) return null;

    return {
      type: 'field',
      fieldId: field.id,
      name: field.name || field.id,
      unit: /story point/i.test(String(field.name ?? '')) ? 'points' : 'units',
      source,
    };
  };

  if (override) {
    if (override === 'issueCount') {
      return {
        type: 'issueCount',
        fieldId: ISSUE_COUNT_ESTIMATION_FIELD_ID,
        name: 'Issue count',
        unit: 'items',
        source: 'override',
      };
    }

    const selected = fromFieldId(override, 'override');
    if (selected) return selected;

    throw new Error('The selected estimation override is no longer available as a numeric Jira field. Reopen Configuration and choose another estimation source.');
  }

  const numericBoardId = Number(boardId);
  if (Number.isInteger(numericBoardId) && numericBoardId > 0) {
    try {
      const response = await jiraRequest(
        route`/rest/agile/1.0/board/${numericBoardId}/configuration`,
        { headers: { Accept: 'application/json' } },
        'Loading board estimation configuration'
      );
      const configuration = await readJson(response, 'Loading board estimation configuration');
      const estimation = configuration?.estimation ?? {};

      if (estimation?.type === 'issueCount') {
        return {
          type: 'issueCount',
          fieldId: ISSUE_COUNT_ESTIMATION_FIELD_ID,
          name: 'Issue count',
          unit: 'items',
          source: 'jira-board',
        };
      }

      const configuredFieldId = estimation?.field?.fieldId ?? estimation?.field?.id ?? null;
      const configured = fromFieldId(configuredFieldId, 'jira-board');
      if (configured) return configured;
    } catch (caughtError) {
      structuredLog('board_estimation_detection_failed', {
        boardId: numericBoardId,
        message: String(caughtError?.message ?? caughtError),
      });
    }
  }

  if (reportingFields?.storyPoints?.id) {
    return {
      type: 'field',
      fieldId: reportingFields.storyPoints.id,
      name: reportingFields.storyPoints.name || 'Story Points',
      unit: 'points',
      source: 'story-points-fallback',
    };
  }

  return {
    type: 'issueCount',
    fieldId: ISSUE_COUNT_ESTIMATION_FIELD_ID,
    name: 'Issue count',
    unit: 'items',
    source: 'issue-count-fallback',
  };
}

async function getJiraTimeZone() {
  try {
    const response = await jiraRequest(
      route`/rest/api/3/myself`,
      {
        headers: {
          Accept: 'application/json',
        },
      }
    );

    const account = await readJson(
      response,
      'Loading Jira user profile'
    );

    return account.timeZone || 'UTC';
  } catch (error) {
    console.warn(
      'Unable to load Jira timezone. Falling back to UTC.',
      error
    );

    return 'UTC';
  }
}

async function getStatusCategoryMap() {
  const response = await jiraRequest(
    route`/rest/api/3/status`,
    {
      headers: {
        Accept: 'application/json',
      },
    }
  );

  const statuses = await readJson(
    response,
    'Loading Jira statuses'
  );

  const map = {};

  for (const status of statuses ?? []) {
    map[normalizeText(status.name)] =
      status.statusCategory?.key ?? 'undefined';
  }

  return map;
}

/**
 * Returns only projects visible to the current Jira user.
 */
defineLicensedResolver('getProjects', async () => {
  const response = await jiraRequest(
    route`/rest/api/3/project/search?maxResults=100&orderBy=name`,
    {
      headers: {
        Accept: 'application/json',
      },
    }
  );

  const data = await readJson(
    response,
    'Loading projects'
  );

  return (data.values ?? []).map((project) => ({
    id: project.id,
    key: project.key,
    name: project.name,
    projectTypeKey: project.projectTypeKey,
    simplified: project.simplified,
    avatarUrl: project.avatarUrls?.['48x48'] ?? '',
  }));
});

/**
 * Finds boards associated with the selected project.
 */
defineLicensedResolver('getBoards', async ({ payload }) => {
  const projectKey = String(
    payload?.projectKey ?? ''
  ).trim();

  if (!projectKey) {
    throw new Error('A project key is required.');
  }

  const response = await jiraRequest(
    route`/rest/agile/1.0/board?projectKeyOrId=${projectKey}&maxResults=50`,
    {
      headers: {
        Accept: 'application/json',
      },
    }
  );

  const data = await readJson(
    response,
    'Loading boards'
  );

  return (data.values ?? []).map((board) => ({
    id: board.id,
    name: board.name,
    type: board.type,
    locationName:
      board.location?.displayName ?? '',
  }));
});


/**
 * Lightweight project/program context used only when the user explicitly loads
 * the Project / Program report. It intentionally avoids issue-history scans.
 * Epics and versions are management context, while team delivery data continues
 * to come from the selected boards' sprint reports.
 */
defineLicensedResolver('getProjectPortfolioContext', async ({ payload }) => {
  const projectKey = String(payload?.projectKey ?? '').trim();
  if (!projectKey) {
    throw new Error('A project key is required.');
  }

  const [versionsOutcome, epicsOutcome] = await Promise.allSettled([
    (async () => {
      const response = await jiraRequest(
        route`/rest/api/3/project/${projectKey}/versions`,
        { headers: { Accept: 'application/json' } },
        'Loading project versions'
      );
      const data = await readJson(response, 'Loading project versions');
      return (Array.isArray(data) ? data : []).map((version) => ({
        id: String(version.id ?? ''),
        name: version.name ?? 'Unnamed version',
        description: version.description ?? '',
        archived: Boolean(version.archived),
        released: Boolean(version.released),
        releaseDate: version.releaseDate ?? null,
        startDate: version.startDate ?? null,
        overdue: Boolean(version.overdue),
      }));
    })(),
    (async () => {
      const response = await jiraRequest(
        route`/rest/api/3/search/jql`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            jql: `project = "${projectKey}" AND issuetype = Epic ORDER BY updated DESC`,
            maxResults: 50,
            fields: ['summary', 'status', 'priority', 'duedate', 'updated'],
          }),
        },
        'Loading project epics'
      );
      const data = await readJson(response, 'Loading project epics');
      return (data.issues ?? []).map((issue) => ({
        id: String(issue.id ?? ''),
        key: issue.key,
        summary: issue.fields?.summary ?? '',
        status: issue.fields?.status?.name ?? 'Unknown',
        statusCategoryKey: issue.fields?.status?.statusCategory?.key ?? 'undefined',
        priority: issue.fields?.priority?.name ?? 'None',
        dueDate: issue.fields?.duedate ?? null,
        updated: issue.fields?.updated ?? null,
      }));
    })(),
  ]);

  const versions = versionsOutcome.status === 'fulfilled' ? versionsOutcome.value : [];
  const epics = epicsOutcome.status === 'fulfilled' ? epicsOutcome.value : [];

  return {
    projectKey,
    versions,
    epics,
    warnings: [
      versionsOutcome.status === 'rejected' ? 'Project versions could not be loaded.' : '',
      epicsOutcome.status === 'rejected' ? 'Project epics could not be loaded.' : '',
    ].filter(Boolean),
  };
});


/**
 * Returns every sprint visible on the selected board.
 *
 * Display labels are derived server-side so the UI can show:
 * - Active Sprint
 * - Future Sprint
 * - Last Sprint (most recently completed)
 * - Closed Sprint (older completed sprints)
 */
defineLicensedResolver('getSprints', async ({ payload }) => {
  const boardId = Number(payload?.boardId);

  if (!Number.isInteger(boardId) || boardId <= 0) {
    throw new Error('A valid board ID is required.');
  }

  const allSprints = [];
  let startAt = 0;
  let isLast = false;

  while (!isLast) {
    const response = await jiraRequest(
      route`/rest/agile/1.0/board/${boardId}/sprint?startAt=${startAt}&maxResults=50`,
      {
        headers: {
          Accept: 'application/json',
        },
      }
    );

    const data = await readJson(
      response,
      'Loading sprints'
    );

    const pageValues = data.values ?? [];
    allSprints.push(...pageValues);

    isLast = Boolean(data.isLast);

    if (isLast || pageValues.length === 0) {
      break;
    }

    startAt += data.maxResults ?? pageValues.length;
  }

  const mappedSprints = allSprints.map((sprint) => ({
    id: sprint.id,
    name: sprint.name,
    state: sprint.state,
    goal: sprint.goal ?? '',
    startDate: sprint.startDate ?? null,
    endDate: sprint.endDate ?? null,
    completeDate: sprint.completeDate ?? null,
  }));

  const closedSprintsNewestFirst = mappedSprints
    .filter((sprint) => sprint.state === 'closed')
    .sort((a, b) => {
      const aDate = new Date(
        a.completeDate ?? a.endDate ?? 0
      ).getTime();

      const bDate = new Date(
        b.completeDate ?? b.endDate ?? 0
      ).getTime();

      return bDate - aDate;
    });

  const lastClosedSprintId =
    closedSprintsNewestFirst[0]?.id ?? null;

  function getSprintDisplayLabel(sprint) {
    if (sprint.state === 'active') {
      return 'Active Sprint';
    }

    if (sprint.state === 'future') {
      return 'Future Sprint';
    }

    if (
      sprint.state === 'closed' &&
      sprint.id === lastClosedSprintId
    ) {
      return 'Last Sprint';
    }

    if (sprint.state === 'closed') {
      return 'Closed Sprint';
    }

    return sprint.state || 'Sprint';
  }

  return mappedSprints
    .map((sprint) => ({
      ...sprint,
      displayLabel: getSprintDisplayLabel(sprint),
      isLastSprint:
        sprint.state === 'closed' &&
        sprint.id === lastClosedSprintId,
    }))
    .sort((a, b) => {
      const stateOrder = {
        active: 0,
        future: 1,
        closed: 2,
      };

      const orderDifference =
        (stateOrder[a.state] ?? 9) -
        (stateOrder[b.state] ?? 9);

      if (orderDifference !== 0) {
        return orderDifference;
      }

      if (a.state === 'future') {
        const aDate = new Date(
          a.startDate ?? a.endDate ?? 0
        ).getTime();

        const bDate = new Date(
          b.startDate ?? b.endDate ?? 0
        ).getTime();

        return aDate - bDate || a.id - b.id;
      }

      if (a.state === 'closed') {
        const aDate = new Date(
          a.completeDate ?? a.endDate ?? 0
        ).getTime();

        const bDate = new Date(
          b.completeDate ?? b.endDate ?? 0
        ).getTime();

        return bDate - aDate || b.id - a.id;
      }

      return a.id - b.id;
    });
});


defineLicensedResolver('getNextSprintOutlook', async ({ payload, context }) => {
  const boardId = Number(payload?.boardId);
  const currentSprintId = Number(payload?.currentSprintId);
  const includeSubtasks = Boolean(payload?.includeSubtasks);
  const estimationOverride = String(payload?.estimationOverride ?? '').trim();
  const acceptanceCriteriaFieldId = String(payload?.acceptanceCriteriaFieldId ?? '').trim();

  if (!Number.isInteger(boardId) || boardId <= 0) {
    throw new Error('A valid board ID is required.');
  }

  if (!Number.isInteger(currentSprintId) || currentSprintId <= 0) {
    throw new Error('A valid current sprint ID is required.');
  }

  const cacheKey = getOutlookCacheKey({
    userId: getUserIdentity(context),
    boardId,
    currentSprintId,
    includeSubtasks,
    estimationOverride,
    acceptanceCriteriaFieldId,
  });

  const cached = await getCachedValue(cacheKey);

  if (cached) {
    return {
      ...cached.value,
      meta: {
        cacheHit: true,
        generatedAt: cached.generatedAt,
      },
    };
  }

  const allSprints = [];
  let startAt = 0;
  let isLast = false;

  while (!isLast) {
    const response = await jiraRequest(
      route`/rest/agile/1.0/board/${boardId}/sprint?startAt=${startAt}&maxResults=50`,
      {
        headers: {
          Accept: 'application/json',
        },
      },
      'Loading next-sprint outlook sprints'
    );

    const data = await readJson(
      response,
      'Loading next-sprint outlook sprints'
    );

    const pageValues = data.values ?? [];
    allSprints.push(...pageValues);
    isLast = Boolean(data.isLast);

    if (isLast || pageValues.length === 0) {
      break;
    }

    startAt += data.maxResults ?? pageValues.length;
  }

  const currentSprint = allSprints.find(
    (sprint) => Number(sprint.id) === currentSprintId
  );

  if (!currentSprint || currentSprint.state === 'future') {
    const result = {
      available: false,
      reason: currentSprint?.state === 'future'
        ? 'selected-sprint-is-future'
        : 'current-sprint-not-found',
    };

    await setCachedValue(cacheKey, result, 5 * 60 * 1000);
    return result;
  }

  const futureSprints = allSprints
    .filter(
      (sprint) =>
        sprint.state === 'future' &&
        Number(sprint.id) !== currentSprintId
    )
    .sort((left, right) => {
      const leftDate = parseDate(left.startDate)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const rightDate = parseDate(right.startDate)?.getTime() ?? Number.MAX_SAFE_INTEGER;

      return leftDate - rightDate || Number(left.id) - Number(right.id);
    });

  const nextSprint = futureSprints[0];

  if (!nextSprint) {
    const result = {
      available: false,
      reason: 'no-future-sprint',
    };

    await setCachedValue(cacheKey, result, 5 * 60 * 1000);
    return result;
  }

  const discoveredReportingFields = await discoverReportingFields();
  const estimationSource = await resolveReportingEstimationSource({
    boardId,
    estimationOverride,
    reportingFields: discoveredReportingFields,
  });
  const acceptanceCriteriaField = resolveAcceptanceCriteriaField(
    discoveredReportingFields.allFields,
    acceptanceCriteriaFieldId
  );
  const storyPointFieldId = estimationSource.fieldId;
  const reportingFields = {
    ...discoveredReportingFields,
    storyPoints: {
      id: estimationSource.fieldId,
      name: estimationSource.name,
      unit: estimationSource.unit,
      type: estimationSource.type,
      source: estimationSource.source,
    },
  };
  const sprintFieldId = reportingFields.sprint?.id ?? null;

  let [nextSprintIssues, currentSprintIssues] = await Promise.all([
    getAllSprintIssues(
      Number(nextSprint.id),
      storyPointFieldId,
      sprintFieldId,
      { includeDescription: true, acceptanceCriteriaFieldId: acceptanceCriteriaField.id }
    ),
    getAllSprintIssues(
      currentSprintId,
      storyPointFieldId,
      sprintFieldId
    ),
  ]);

  nextSprintIssues = await hydrateAcceptanceCriteriaIssueFields({
    sprintId: Number(nextSprint.id),
    issues: nextSprintIssues,
    acceptanceCriteriaFieldId: acceptanceCriteriaField.id,
    context,
  });

  const nextMetrics = calculateSprintMetrics(
    nextSprintIssues,
    storyPointFieldId,
    includeSubtasks,
    acceptanceCriteriaField
  );

  const currentMetrics = calculateSprintMetrics(
    currentSprintIssues,
    storyPointFieldId,
    includeSubtasks
  );

  const currentIssueIds = new Set(
    (currentMetrics.reportingIssues ?? []).map((issue) => issue.id)
  );

  const carryOverIssues = (nextMetrics.reportingIssues ?? []).filter(
    (issue) => currentIssueIds.has(issue.id)
  );

  const unassignedItems = (nextMetrics.reportingIssues ?? []).filter(
    (issue) => issue.assignee === 'Unassigned'
  ).length;

  const unestimatedItems = (nextMetrics.reportingIssues ?? []).filter(
    (issue) => Number(issue.storyPoints ?? 0) <= 0
  ).length;

  const assigneeCount = new Set(
    (nextMetrics.reportingIssues ?? [])
      .map((issue) => issue.assignee)
      .filter((name) => name && name !== 'Unassigned')
  ).size;

  const acceptanceCriteria = summarizeAcceptanceCriteria(nextMetrics.reportingIssues ?? []);

  const result = {
    available: true,
    sprint: {
      id: nextSprint.id,
      name: nextSprint.name,
      state: nextSprint.state,
      goal: nextSprint.goal ?? '',
      startDate: nextSprint.startDate ?? null,
      endDate: nextSprint.endDate ?? null,
    },
    plannedItems: nextMetrics.total,
    plannedPoints: nextMetrics.committedStoryPoints,
    estimationSource,
    defects: nextMetrics.defects,
    overdueItems: nextMetrics.overdue,
    unassignedItems,
    unestimatedItems,
    assigneeCount,
    originalEstimateCoveragePercentage:
      nextMetrics.effort?.coverage?.originalEstimateCoveragePercentage ?? 0,
    acceptanceCriteria,
    carryOverItems: carryOverIssues.length,
    carryOverPoints: roundNumber(
      carryOverIssues.reduce(
        (sum, issue) => sum + Number(issue.storyPoints ?? 0),
        0
      )
    ),
    carryOverKeys: carryOverIssues.map((issue) => issue.key),
  };

  await setCachedValue(cacheKey, result, 5 * 60 * 1000);

  structuredLog('next_sprint_outlook_generated', {
    installationId: getInstallationIdentity(context),
    userId: getUserIdentity(context),
    boardId,
    currentSprintId,
    nextSprintId: nextSprint.id,
    plannedItems: result.plannedItems,
    carryOverItems: result.carryOverItems,
  });

  return {
    ...result,
    meta: {
      cacheHit: false,
      generatedAt: new Date().toISOString(),
    },
  };
});

async function getAllSprintIssues(
  sprintId,
  storyPointFieldId,
  sprintFieldId,
  { includeDescription = false, acceptanceCriteriaFieldId = '' } = {}
) {
  const allIssues = [];
  let nextPageToken;

  const fields = [...new Set([
    'summary',
    includeDescription ? 'description' : null,
    'status',
    'issuetype',
    'priority',
    'assignee',
    'duedate',
    'created',
    'updated',
    'resolutiondate',
    'parent',
    'issuelinks',
    'fixVersions',
    acceptanceCriteriaFieldId && acceptanceCriteriaFieldId !== 'description' ? acceptanceCriteriaFieldId : null,
    'project',
    'timetracking',
    'timeoriginalestimate',
    'timeestimate',
    'timespent',
    requestableEstimationFieldId(storyPointFieldId),
    sprintFieldId,
  ].filter(Boolean))].join(',');

  do {
    let response;

    if (nextPageToken) {
      response = await jiraRequest(
        route`/rest/agile/1.0/sprint/${sprintId}/issue?maxResults=100&fields=${fields}&nextPageToken=${nextPageToken}`,
        {
          headers: {
            Accept: 'application/json',
          },
        }
      );
    } else {
      response = await jiraRequest(
        route`/rest/agile/1.0/sprint/${sprintId}/issue?maxResults=100&fields=${fields}`,
        {
          headers: {
            Accept: 'application/json',
          },
        }
      );
    }

    const data = await readJson(
      response,
      'Loading sprint work items'
    );

    allIssues.push(...(data.issues ?? []));

    if (allIssues.length > FEATURE_FLAGS.maximumIssuesPerReport) {
      throw new Error(
        `This report exceeds the maximum of ${FEATURE_FLAGS.maximumIssuesPerReport} issues. Refine the report scope.`
      );
    }

    nextPageToken = data.nextPageToken;
  } while (nextPageToken);

  return allIssues;
}

async function searchProjectHistoryCandidates({
  projectKey,
  sprintStart,
  historyEnd = null,
  storyPointFieldId,
  sprintFieldId,
  timeZone = 'UTC',
}) {
  if (!projectKey || !sprintStart) {
    return {
      issues: [],
      truncated: false,
    };
  }

  const fields = [...new Set([
    'summary',
    'status',
    'issuetype',
    'priority',
    'assignee',
    'duedate',
    'created',
    'updated',
    'resolutiondate',
    'parent',
    'project',
    'timetracking',
    'timeoriginalestimate',
    'timeestimate',
    'timespent',
    requestableEstimationFieldId(storyPointFieldId),
    sprintFieldId,
  ].filter(Boolean))];

  const startDate = toDateOnly(sprintStart, timeZone);
  const endDate = historyEnd
    ? toDateOnly(new Date(historyEnd.getTime() + DAY_MS), timeZone)
    : null;

  /*
   * This JQL is entirely internal.
   * Users never create or enter it.
   *
   * Moving an item into or out of a sprint updates the issue,
   * so removed scope can be recovered from issues changed during
   * the sprint. For closed sprints, bound the candidate search to
   * the sprint window. The previous unbounded query (updated >= start)
   * caused old velocity calculations to scan months of later project
   * activity and could exceed Forge's 25-second resolver limit.
   */
  const jql =
    `project = "${projectKey}" ` +
    `AND updated >= "${startDate}" ` +
    (endDate ? `AND updated < "${endDate}" ` : '') +
    'ORDER BY updated ASC';

  const allIssues = [];
  let nextPageToken;
  let truncated = false;

  do {
    const requestBody = {
      jql,
      maxResults: 100,
      fields,
    };

    if (nextPageToken) {
      requestBody.nextPageToken = nextPageToken;
    }

    const response = await jiraRequest(
      route`/rest/api/3/search/jql`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      }
    );

    const data = await readJson(
      response,
      'Searching sprint-history candidates'
    );

    allIssues.push(...(data.issues ?? []));
    nextPageToken = data.nextPageToken;

    if (
      allIssues.length >=
      MAX_HISTORY_CANDIDATES
    ) {
      truncated = Boolean(nextPageToken);
      break;
    }
  } while (nextPageToken);

  return {
    issues: allIssues.slice(
      0,
      MAX_HISTORY_CANDIDATES
    ),
    truncated,
  };
}

async function bulkFetchChangelogs({
  issues,
  sprintFieldId,
  storyPointFieldId,
}) {
  if (!issues.length) {
    return new Map();
  }

  const issueIdsOrKeys = issues.map(
    (issue) => issue.id ?? issue.key
  );

  const fieldIds = [...new Set([
    sprintFieldId,
    requestableEstimationFieldId(storyPointFieldId),
    'status',
    'timeoriginalestimate',
    'timeestimate',
    'timespent',
  ].filter(Boolean))];

  const changelogMap = new Map();
  let nextPageToken;

  do {
    const requestBody = {
      issueIdsOrKeys,
      fieldIds,
      maxResults: 1000,
    };

    if (nextPageToken) {
      requestBody.nextPageToken = nextPageToken;
    }

    const response = await jiraRequest(
      route`/rest/api/3/changelog/bulkfetch`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      }
    );

    const data = await readJson(
      response,
      'Loading issue changelogs'
    );

    for (
      const issueLog of
      data.issueChangeLogs ?? []
    ) {
      const issueId = String(issueLog.issueId);
      const existing =
        changelogMap.get(issueId) ?? [];

      existing.push(
        ...(issueLog.changeHistories ?? [])
      );

      changelogMap.set(issueId, existing);
    }

    nextPageToken = data.nextPageToken;
  } while (nextPageToken);

  for (const [issueId, histories] of changelogMap) {
    histories.sort(
      (a, b) =>
        (parseDate(a.created)?.getTime() ?? 0) -
        (parseDate(b.created)?.getTime() ?? 0)
    );

    changelogMap.set(issueId, histories);
  }

  return changelogMap;
}


function isRawStoryIssue(issue) {
  const type = normalizeText(issue?.fields?.issuetype?.name);
  return type === 'story' || type === 'user story' || type.endsWith(' story');
}

function acceptanceCriteriaDetectedInRawIssue(issue, acceptanceCriteriaFieldId = '') {
  if (!isRawStoryIssue(issue)) return false;
  const fields = issue?.fields ?? {};
  const mappedFieldId = acceptanceCriteriaFieldId && acceptanceCriteriaFieldId !== 'description'
    ? acceptanceCriteriaFieldId
    : '';
  const mappedValue = mappedFieldId ? fields[mappedFieldId] : null;
  if (hasMeaningfulJiraFieldValue(mappedValue)) {
    return Boolean(detectMappedAcceptanceCriteria(mappedValue)?.detected);
  }
  return Boolean(detectAcceptanceCriteria(fields.description)?.detected);
}

async function hydrateAcceptanceCriteriaIssueFields({
  sprintId,
  issues,
  acceptanceCriteriaFieldId = '',
  context = null,
}) {
  const sourceIssues = Array.isArray(issues) ? issues : [];
  const storyIssues = sourceIssues.filter(isRawStoryIssue);
  if (!storyIssues.length) return sourceIssues;

  const mappedFieldId = acceptanceCriteriaFieldId && acceptanceCriteriaFieldId !== 'description'
    ? acceptanceCriteriaFieldId
    : '';
  const targetFieldId = mappedFieldId || 'description';
  const detectedBefore = storyIssues.filter((issue) =>
    acceptanceCriteriaDetectedInRawIssue(issue, acceptanceCriteriaFieldId)
  ).length;
  const missingKeys = storyIssues
    .filter((issue) => !hasMeaningfulJiraFieldValue(issue?.fields?.[targetFieldId]))
    .map((issue) => String(issue?.key ?? '').trim())
    .filter(Boolean);

  // Jira Software's sprint issue endpoint can omit or thin large rich-text fields
  // even when they are requested. If every Story appears to have zero AC, hydrate
  // the source field once from Jira Platform's enhanced JQL search. This remains
  // bounded to the selected sprint and avoids one REST call per Story.
  const hydrateAllStories = detectedBefore === 0;
  const keysToHydrate = hydrateAllStories
    ? storyIssues.map((issue) => String(issue?.key ?? '').trim()).filter(Boolean)
    : missingKeys;

  if (!keysToHydrate.length) return sourceIssues;

  try {
    const hydratedByKey = new Map();
    for (let offset = 0; offset < keysToHydrate.length; offset += 100) {
      const chunk = keysToHydrate.slice(offset, offset + 100);
      const requestBody = {
        jql: `key in (${chunk.join(',')})`,
        maxResults: Math.min(100, chunk.length),
        fields: [...new Set(['description', mappedFieldId].filter(Boolean))],
      };

      const response = await jiraRequest(route`/rest/api/3/search/jql`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      });
      const data = await readJson(response, 'Hydrating Acceptance Criteria source fields');
      (data.issues ?? []).forEach((issue) => {
        if (issue?.key) hydratedByKey.set(String(issue.key), issue);
      });
    }

    const hydrated = sourceIssues.map((issue) => {
      const fresh = hydratedByKey.get(String(issue?.key ?? ''));
      if (!fresh) return issue;
      return {
        ...issue,
        fields: {
          ...(issue?.fields ?? {}),
          ...(fresh?.fields ?? {}),
        },
      };
    });

    const hydratedStories = hydrated.filter(isRawStoryIssue);
    const detectedAfter = hydratedStories.filter((issue) =>
      acceptanceCriteriaDetectedInRawIssue(issue, acceptanceCriteriaFieldId)
    ).length;

    structuredLog('acceptance_criteria_fields_hydrated', {
      installationId: getInstallationIdentity(context),
      userId: getUserIdentity(context),
      sprintId,
      sourceField: targetFieldId,
      stories: storyIssues.length,
      requested: keysToHydrate.length,
      detectedBefore,
      detectedAfter,
    });

    return hydrated;
  } catch (caughtError) {
    structuredLog('acceptance_criteria_hydration_fallback', {
      installationId: getInstallationIdentity(context),
      userId: getUserIdentity(context),
      sprintId,
      sourceField: targetFieldId,
      error: String(caughtError?.message ?? caughtError),
    });
    return sourceIssues;
  }
}

function mergeIssues(...issueCollections) {
  const map = new Map();

  for (const collection of issueCollections) {
    for (const issue of collection ?? []) {
      if (!issue?.id) {
        continue;
      }

      map.set(String(issue.id), issue);
    }
  }

  return [...map.values()];
}

function prepareCurrentIssue(
  issue,
  storyPointFieldId,
  acceptanceCriteriaField = null
) {
  const fields = issue.fields ?? {};

  const timeTracking =
    fields.timetracking ?? {};

  const originalEstimateSeconds =
    Number(
      timeTracking.originalEstimateSeconds ??
        fields.timeoriginalestimate ??
        0
    ) || 0;

  const remainingEstimateSeconds =
    Number(
      timeTracking.remainingEstimateSeconds ??
        fields.timeestimate ??
        0
    ) || 0;

  const timeSpentSeconds =
    Number(
      timeTracking.timeSpentSeconds ??
        fields.timespent ??
        0
    ) || 0;

  const storyPoints = estimationValueFromIssueFields(
    fields,
    storyPointFieldId,
    originalEstimateSeconds
  );

  const mappedAcceptanceValue = acceptanceCriteriaField?.id && acceptanceCriteriaField.id !== 'description'
    ? fields[acceptanceCriteriaField.id]
    : null;
  const acceptanceCriteria = hasMeaningfulJiraFieldValue(mappedAcceptanceValue)
    ? detectMappedAcceptanceCriteria(mappedAcceptanceValue)
    : detectAcceptanceCriteria(fields.description);
  const linkedIssues = (fields.issuelinks ?? []).map(linkedIssueSummary).filter(Boolean);
  const fixVersions = (fields.fixVersions ?? []).map((version) => ({
    id: version.id ?? null,
    name: version.name ?? '',
    released: Boolean(version.released),
    releaseDate: version.releaseDate ?? null,
  }));

  return {
    id: String(issue.id),
    key: issue.key,
    projectKey:
      fields.project?.key ?? null,
    summary: fields.summary ?? '',
    acceptanceCriteria,
    acceptanceCriteriaSource: hasMeaningfulJiraFieldValue(mappedAcceptanceValue)
      ? (acceptanceCriteriaField?.name || acceptanceCriteriaField?.id || 'Mapped field')
      : 'Description',
    linkedIssues,
    fixVersions,
    status:
      fields.status?.name ?? 'Unknown',
    statusCategoryKey:
      fields.status?.statusCategory?.key ??
      'undefined',
    issueType:
      fields.issuetype?.name ?? 'Unknown',
    isSubtask: Boolean(
      fields.issuetype?.subtask
    ),
    priority:
      fields.priority?.name ?? 'None',
    assignee:
      fields.assignee?.displayName ??
      'Unassigned',
    dueDate: fields.duedate ?? null,
    created: fields.created ?? null,
    updated: fields.updated ?? null,
    resolutionDate:
      fields.resolutiondate ?? null,
    storyPoints,
    originalEstimateSeconds,
    remainingEstimateSeconds,
    timeSpentSeconds,
    originalEstimateHours:
      secondsToHours(
        originalEstimateSeconds
      ),
    remainingEstimateHours:
      secondsToHours(
        remainingEstimateSeconds
      ),
    timeSpentHours:
      secondsToHours(
        timeSpentSeconds
      ),
    forecastHours:
      secondsToHours(
        timeSpentSeconds +
          remainingEstimateSeconds
      ),
    parentKey:
      fields.parent?.key ?? null,
  };
}

function calculateDaysOverdue(issue) {
  if (
    !issue.dueDate ||
    issue.statusCategoryKey === 'done'
  ) {
    return 0;
  }

  const dueDate = startOfDay(
    `${issue.dueDate}T00:00:00`
  );
  const today = startOfDay(new Date());

  if (
    !dueDate ||
    !today ||
    dueDate >= today
  ) {
    return 0;
  }

  return Math.floor(
    (today.getTime() - dueDate.getTime()) /
      DAY_MS
  );
}

function calculateSprintMetrics(
  issues,
  storyPointFieldId,
  includeSubtasks = false,
  acceptanceCriteriaField = null
) {
  const preparedIssues = issues.map((issue) => {
    const prepared = prepareCurrentIssue(
      issue,
      storyPointFieldId,
      acceptanceCriteriaField
    );

    return {
      ...prepared,
      daysOverdue:
        calculateDaysOverdue(prepared),
    };
  });

  const reportingIssues = includeSubtasks
    ? preparedIssues
    : preparedIssues.filter(
        (issue) => !issue.isSubtask
      );

  const statusCounts = {};
  const typeCounts = {};
  const assigneeMap = {};

  let completed = 0;
  let defects = 0;
  let overdue = 0;
  let committedStoryPoints = 0;
  let completedStoryPoints = 0;
  let originalEstimateSeconds = 0;
  let remainingEstimateSeconds = 0;
  let timeSpentSeconds = 0;

  let originalEstimateCoveredItems = 0;
  let remainingEstimateEligibleItems = 0;
  let remainingEstimateCoveredItems = 0;
  let timeSpentCoveredItems = 0;

  reportingIssues.forEach((issue) => {
    statusCounts[issue.status] =
      (statusCounts[issue.status] ?? 0) + 1;

    typeCounts[issue.issueType] =
      (typeCounts[issue.issueType] ?? 0) + 1;

    if (!assigneeMap[issue.assignee]) {
      assigneeMap[issue.assignee] = {
        name: issue.assignee,
        total: 0,
        completed: 0,
        open: 0,
        overdue: 0,
        storyPoints: 0,
        remainingStoryPoints: 0,
        originalEstimateSeconds: 0,
        remainingEstimateSeconds: 0,
        timeSpentSeconds: 0,
      };
    }

    const person = assigneeMap[issue.assignee];

    person.total += 1;
    person.storyPoints += issue.storyPoints;
    person.originalEstimateSeconds +=
      issue.originalEstimateSeconds;
    person.remainingEstimateSeconds +=
      issue.remainingEstimateSeconds;
    person.timeSpentSeconds +=
      issue.timeSpentSeconds;

    committedStoryPoints += issue.storyPoints;
    originalEstimateSeconds +=
      issue.originalEstimateSeconds;
    remainingEstimateSeconds +=
      issue.remainingEstimateSeconds;
    timeSpentSeconds +=
      issue.timeSpentSeconds;

    if (issue.originalEstimateSeconds > 0) {
      originalEstimateCoveredItems += 1;
    }

    if (issue.timeSpentSeconds > 0) {
      timeSpentCoveredItems += 1;
    }

    const isDone =
      issue.statusCategoryKey === 'done';

    if (isDone) {
      completed += 1;
      completedStoryPoints +=
        issue.storyPoints;
      person.completed += 1;
    } else {
      person.open += 1;
      person.remainingStoryPoints +=
        issue.storyPoints;

      if (issue.originalEstimateSeconds > 0) {
        remainingEstimateEligibleItems += 1;

        if (issue.remainingEstimateSeconds > 0) {
          remainingEstimateCoveredItems += 1;
        }
      }
    }

    if (issue.daysOverdue > 0) {
      overdue += 1;
      person.overdue += 1;
    }

    const type =
      normalizeText(issue.issueType);

    if (
      type === 'bug' ||
      type === 'defect' ||
      type.includes('defect')
    ) {
      defects += 1;
    }
  });

  const total = reportingIssues.length;
  const open = total - completed;

  const completionPercentage =
    total === 0
      ? 0
      : Math.round((completed / total) * 100);

  const remainingStoryPoints =
    committedStoryPoints -
    completedStoryPoints;

  const storyPointCompletionPercentage =
    committedStoryPoints === 0
      ? 0
      : Math.round(
          (completedStoryPoints /
            committedStoryPoints) *
            100
        );

  const forecastSeconds =
    timeSpentSeconds +
    remainingEstimateSeconds;

  const varianceSeconds =
    forecastSeconds -
    originalEstimateSeconds;

  const originalEstimateCoveragePercentage =
    total === 0
      ? 0
      : roundNumber(
          (originalEstimateCoveredItems / total) * 100,
          1
        );

  const remainingEstimateCoveragePercentage =
    remainingEstimateEligibleItems === 0
      ? 100
      : roundNumber(
          (remainingEstimateCoveredItems /
            remainingEstimateEligibleItems) *
            100,
          1
        );

  const timeSpentCoveragePercentage =
    total === 0
      ? 0
      : roundNumber(
          (timeSpentCoveredItems / total) * 100,
          1
        );

  const forecastProvisional =
    remainingEstimateCoveragePercentage < 80;

  const workload = Object.values(
    assigneeMap
  )
    .map((person) => ({
      ...person,
      originalEstimateHours:
        secondsToHours(
          person.originalEstimateSeconds
        ),
      remainingEstimateHours:
        secondsToHours(
          person.remainingEstimateSeconds
        ),
      timeSpentHours:
        secondsToHours(
          person.timeSpentSeconds
        ),
      forecastHours:
        secondsToHours(
          person.timeSpentSeconds +
            person.remainingEstimateSeconds
        ),
    }))
    .sort(
      (a, b) =>
        b.total - a.total ||
        a.name.localeCompare(b.name)
    );

  return {
    total,
    completed,
    open,
    completionPercentage,
    defects,
    overdue,

    committedStoryPoints:
      roundNumber(committedStoryPoints),

    completedStoryPoints:
      roundNumber(completedStoryPoints),

    remainingStoryPoints:
      roundNumber(remainingStoryPoints),

    storyPointCompletionPercentage,

    effort: {
      originalEstimateSeconds,
      remainingEstimateSeconds,
      timeSpentSeconds,
      forecastSeconds,
      varianceSeconds,

      originalEstimateHours:
        secondsToHours(
          originalEstimateSeconds
        ),

      remainingEstimateHours:
        secondsToHours(
          remainingEstimateSeconds
        ),

      timeSpentHours:
        secondsToHours(
          timeSpentSeconds
        ),

      forecastHours:
        secondsToHours(
          forecastSeconds
        ),

      varianceHours:
        secondsToHours(
          varianceSeconds
        ),

      variancePercentage:
        originalEstimateSeconds === 0
          ? 0
          : roundNumber(
              (varianceSeconds /
                originalEstimateSeconds) *
                100,
              1
            ),

      burnedPercentage:
        originalEstimateSeconds === 0
          ? 0
          : roundNumber(
              (timeSpentSeconds /
                originalEstimateSeconds) *
                100,
              1
            ),

      remainingPercentage:
        originalEstimateSeconds === 0
          ? 0
          : roundNumber(
              (remainingEstimateSeconds /
                originalEstimateSeconds) *
                100,
              1
            ),

      coverage: {
        totalItems: total,
        openItems: open,
        originalEstimateCoveredItems,
        originalEstimateCoveragePercentage,
        remainingEstimateEligibleItems,
        remainingEstimateCoveredItems,
        remainingEstimateCoveragePercentage,
        timeSpentCoveredItems,
        timeSpentCoveragePercentage,
      },

      forecastProvisional,
    },

    includedSubtasks: includeSubtasks,

    subtaskCount:
      preparedIssues.filter(
        (issue) => issue.isSubtask
      ).length,

    statusCounts,
    typeCounts,
    workload,
    issues: preparedIssues,
    reportingIssues,
  };
}

function buildInitialHistoricalState({
  issue,
  histories,
  sprintStart,
  sprintId,
  sprintName,
  sprintFieldId,
  storyPointFieldId,
  currentSprintIssueIds,
}) {
  const current = prepareCurrentIssue(
    issue,
    storyPointFieldId
  );

  const createdDate =
    parseDate(current.created);

  const afterStart = histories
    .filter((history) => {
      const created = parseDate(
        history.created
      );

      return (
        created &&
        created >= sprintStart
      );
    })
    .sort(
      (a, b) =>
        (parseDate(b.created)?.getTime() ??
          0) -
        (parseDate(a.created)?.getTime() ??
          0)
    );

  const hasRemainingEstimateHistory =
    afterStart.some((history) =>
      (history.items ?? []).some(
        isRemainingEstimateChange
      )
    );

  let state = {
    issueId: current.id,
    key: current.key,
    summary: current.summary,
    issueType: current.issueType,
    isSubtask: current.isSubtask,
    inSprint:
      currentSprintIssueIds.has(current.id),
    storyPoints: current.storyPoints,
    status: current.status,
    originalEstimateSeconds:
      current.originalEstimateSeconds,
    remainingEstimateSeconds:
      current.remainingEstimateSeconds,
    timeSpentSeconds:
      current.timeSpentSeconds,
    remainingEstimateFallback: false,
    remainingEstimateHistoryAvailable:
      hasRemainingEstimateHistory,
  };

  /*
   * Roll the current issue backwards through every
   * change made after sprint start.
   */
  for (const history of afterStart) {
    for (const item of history.items ?? []) {
      if (
        isSprintChange(
          item,
          sprintFieldId
        )
      ) {
        state.inSprint =
          containsSprintReference(
            item.from,
            item.fromString,
            sprintId,
            sprintName
          );
      }

      if (
        isStoryPointChange(
          item,
          storyPointFieldId
        )
      ) {
        state.storyPoints =
          estimationPreviousValueFromHistoryItem(
            item,
            storyPointFieldId
          );
      }

      if (isStatusChange(item)) {
        state.status =
          item.fromString ??
          state.status;
      }

      if (isOriginalEstimateChange(item)) {
        state.originalEstimateSeconds =
          parseJiraDurationSeconds(
            item.from,
            item.fromString
          );
      }

      if (isRemainingEstimateChange(item)) {
        state.remainingEstimateSeconds =
          parseJiraDurationSeconds(
            item.from,
            item.fromString
          );
      }

      if (isTimeSpentChange(item)) {
        state.timeSpentSeconds =
          parseJiraDurationSeconds(
            item.from,
            item.fromString
          );
      }
    }
  }

  /*
   * Jira does not always expose a historical Remaining Estimate.
   * At sprint start, the safest fallback is the Original Estimate.
   * A synthetic current-state reconciliation event later returns
   * the timeline to Jira's actual current Remaining Estimate.
   */
  if (
    !hasRemainingEstimateHistory &&
    state.remainingEstimateSeconds === 0 &&
    state.originalEstimateSeconds > 0
  ) {
    state.remainingEstimateSeconds =
      state.originalEstimateSeconds;
    state.remainingEstimateFallback = true;
  }

  /*
   * An issue created after sprint start cannot have
   * been part of the original commitment.
   */
  if (
    createdDate &&
    createdDate > sprintStart
  ) {
    state.inSprint = false;
  }

  return state;
}

function buildHistoricalIssueEvents({
  issue,
  histories,
  initialState,
  sprintStart,
  historyEnd,
  sprintId,
  sprintName,
  sprintFieldId,
  storyPointFieldId,
}) {
  const workingState = {
    ...initialState,
  };

  const events = [];
  let sawSprintEvent = false;

  const orderedHistories = histories
    .filter((history) => {
      const created = parseDate(
        history.created
      );

      return (
        created &&
        created >= sprintStart &&
        created <= historyEnd
      );
    })
    .sort(
      (a, b) =>
        (parseDate(a.created)?.getTime() ??
          0) -
        (parseDate(b.created)?.getTime() ??
          0)
    );

  for (const history of orderedHistories) {
    const time = parseDate(history.created);

    if (!time) {
      continue;
    }

    for (const item of history.items ?? []) {
      if (
        isSprintChange(
          item,
          sprintFieldId
        )
      ) {
        sawSprintEvent = true;

        const before =
          workingState.inSprint;

        const after =
          containsSprintReference(
            item.to,
            item.toString,
            sprintId,
            sprintName
          );

        if (before !== after) {
          events.push({
            time,
            issueId: workingState.issueId,
            key: workingState.key,
            type: after
              ? 'scope-added'
              : 'scope-removed',
            beforeInSprint: before,
            afterInSprint: after,
            storyPoints:
              workingState.storyPoints,
            originalEstimateSeconds:
              workingState.originalEstimateSeconds,
            remainingEstimateSeconds:
              workingState.remainingEstimateSeconds,
          });
        }

        workingState.inSprint = after;
      }

      if (
        isStoryPointChange(
          item,
          storyPointFieldId
        )
      ) {
        const before =
          workingState.storyPoints;

        const after =
          estimationValueFromHistoryItem(
            item,
            storyPointFieldId
          );

        if (before !== after) {
          events.push({
            time,
            issueId: workingState.issueId,
            key: workingState.key,
            type: 'estimate-changed',
            beforeEstimate: before,
            afterEstimate: after,
            delta: after - before,
            inSprint:
              workingState.inSprint,
          });
        }

        workingState.storyPoints = after;
      }

      if (isStatusChange(item)) {
        const before =
          workingState.status;

        const after =
          item.toString ??
          workingState.status;

        if (before !== after) {
          events.push({
            time,
            issueId: workingState.issueId,
            key: workingState.key,
            type: 'status-changed',
            beforeStatus: before,
            afterStatus: after,
          });
        }

        workingState.status = after;
      }

      if (isOriginalEstimateChange(item)) {
        const before =
          workingState.originalEstimateSeconds;

        const after =
          parseJiraDurationSeconds(
            item.to,
            item.toString
          );

        if (before !== after) {
          events.push({
            time,
            issueId: workingState.issueId,
            key: workingState.key,
            type: 'original-estimate-changed',
            beforeSeconds: before,
            afterSeconds: after,
            deltaSeconds: after - before,
            inSprint:
              workingState.inSprint,
          });
        }

        workingState.originalEstimateSeconds =
          after;
      }

      if (isRemainingEstimateChange(item)) {
        const before =
          workingState.remainingEstimateSeconds;

        const after =
          parseJiraDurationSeconds(
            item.to,
            item.toString
          );

        if (before !== after) {
          events.push({
            time,
            issueId: workingState.issueId,
            key: workingState.key,
            type: 'remaining-estimate-changed',
            beforeSeconds: before,
            afterSeconds: after,
            deltaSeconds: after - before,
            inSprint:
              workingState.inSprint,
          });
        }

        workingState.remainingEstimateSeconds =
          after;
        workingState.remainingEstimateFallback =
          false;
      }

      if (isTimeSpentChange(item)) {
        const before =
          workingState.timeSpentSeconds;

        const after =
          parseJiraDurationSeconds(
            item.to,
            item.toString
          );

        if (before !== after) {
          events.push({
            time,
            issueId: workingState.issueId,
            key: workingState.key,
            type: 'time-spent-changed',
            beforeSeconds: before,
            afterSeconds: after,
            deltaSeconds: after - before,
            inSprint:
              workingState.inSprint,
          });
        }

        workingState.timeSpentSeconds =
          after;
      }
    }
  }

  const currentIssue =
    prepareCurrentIssue(
      issue,
      storyPointFieldId
    );

  /*
   * Jira normally records sprint assignment in the
   * changelog. This fallback handles imported or older
   * issues where that event may not be present.
   */
  if (
    !sawSprintEvent &&
    !initialState.inSprint &&
    currentIssue.created &&
    parseDate(currentIssue.created) >=
      sprintStart
  ) {
    events.push({
      time:
        parseDate(currentIssue.created) ??
        sprintStart,
      issueId: currentIssue.id,
      key: currentIssue.key,
      type: 'scope-added',
      beforeInSprint: false,
      afterInSprint: true,
      storyPoints:
        currentIssue.storyPoints,
      originalEstimateSeconds:
        currentIssue.originalEstimateSeconds,
      remainingEstimateSeconds:
        currentIssue.remainingEstimateSeconds,
      synthetic: true,
    });

    workingState.inSprint = true;
  }

  /*
   * When Jira does not provide enough historical Remaining Estimate
   * detail, reconcile the reconstructed timeline to the current issue
   * values at the report timestamp. This preserves a useful sprint-start
   * baseline while guaranteeing the last chart point matches Jira now.
   */
  const currentComparisons = [
    {
      type: 'original-estimate-changed',
      stateKey: 'originalEstimateSeconds',
      currentValue:
        currentIssue.originalEstimateSeconds,
    },
    {
      type: 'remaining-estimate-changed',
      stateKey: 'remainingEstimateSeconds',
      currentValue:
        currentIssue.remainingEstimateSeconds,
    },
    {
      type: 'time-spent-changed',
      stateKey: 'timeSpentSeconds',
      currentValue:
        currentIssue.timeSpentSeconds,
    },
  ];

  for (const comparison of currentComparisons) {
    const before =
      Number(
        workingState[comparison.stateKey]
      ) || 0;

    const after =
      Number(comparison.currentValue) || 0;

    if (before !== after) {
      events.push({
        time: historyEnd,
        issueId: workingState.issueId,
        key: workingState.key,
        type: comparison.type,
        beforeSeconds: before,
        afterSeconds: after,
        deltaSeconds: after - before,
        inSprint: workingState.inSprint,
        synthetic: true,
        reconciliation: true,
      });

      workingState[comparison.stateKey] =
        after;
    }
  }

  return events.sort(
    (a, b) =>
      a.time.getTime() -
      b.time.getTime()
  );
}

function applyHistoricalEvent(state, event) {
  if (!state) {
    return;
  }

  if (event.type === 'scope-added') {
    state.inSprint = true;
  }

  if (event.type === 'scope-removed') {
    state.inSprint = false;
  }

  if (event.type === 'estimate-changed') {
    state.storyPoints =
      event.afterEstimate;
  }

  if (event.type === 'status-changed') {
    state.status =
      event.afterStatus;
  }

  if (
    event.type ===
    'original-estimate-changed'
  ) {
    state.originalEstimateSeconds =
      event.afterSeconds;
  }

  if (
    event.type ===
    'remaining-estimate-changed'
  ) {
    state.remainingEstimateSeconds =
      event.afterSeconds;
  }

  if (
    event.type ===
    'time-spent-changed'
  ) {
    state.timeSpentSeconds =
      event.afterSeconds;
  }
}

function isHistoricalDone(
  statusName,
  statusCategoryMap
) {
  return (
    statusCategoryMap[
      normalizeText(statusName)
    ] === 'done'
  );
}

function calculateHistoricalTotals({
  states,
  includeSubtasks,
  statusCategoryMap,
}) {
  let scopeItems = 0;
  let scopePoints = 0;
  let completedItems = 0;
  let completedPoints = 0;
  let originalEstimateSeconds = 0;
  let remainingEstimateSeconds = 0;
  let timeSpentSeconds = 0;

  for (const state of states.values()) {
    if (
      !includeSubtasks &&
      state.isSubtask
    ) {
      continue;
    }

    if (!state.inSprint) {
      continue;
    }

    scopeItems += 1;
    scopePoints += state.storyPoints;
    originalEstimateSeconds +=
      state.originalEstimateSeconds;
    remainingEstimateSeconds +=
      state.remainingEstimateSeconds;
    timeSpentSeconds +=
      state.timeSpentSeconds;

    if (
      isHistoricalDone(
        state.status,
        statusCategoryMap
      )
    ) {
      completedItems += 1;
      completedPoints +=
        state.storyPoints;
    }
  }

  const forecastSeconds =
    timeSpentSeconds +
    remainingEstimateSeconds;

  const varianceSeconds =
    forecastSeconds -
    originalEstimateSeconds;

  return {
    scopeItems,

    scopePoints:
      roundNumber(scopePoints),

    completedItems,

    completedPoints:
      roundNumber(completedPoints),

    remainingItems:
      scopeItems - completedItems,

    remainingPoints:
      roundNumber(
        scopePoints - completedPoints
      ),

    originalEstimateSeconds,
    remainingEstimateSeconds,
    timeSpentSeconds,
    forecastSeconds,
    varianceSeconds,

    originalEstimateHours:
      secondsToHours(
        originalEstimateSeconds
      ),

    remainingEstimateHours:
      secondsToHours(
        remainingEstimateSeconds
      ),

    timeSpentHours:
      secondsToHours(
        timeSpentSeconds
      ),

    forecastHours:
      secondsToHours(
        forecastSeconds
      ),

    varianceHours:
      secondsToHours(
        varianceSeconds
      ),
  };
}

function buildDailyBurndown({
  initialStates,
  events,
  sprintStart,
  historyEnd,
  plannedSprintEnd,
  timeZone,
  includeSubtasks,
  statusCategoryMap,
  originalCommittedPoints,
  originalRemainingEstimateSeconds,
}) {
  const firstDateKey =
    toZonedDateKey(sprintStart, timeZone);

  const lastDateKey =
    toZonedDateKey(historyEnd, timeZone);

  const plannedEnd =
    plannedSprintEnd &&
    plannedSprintEnd > sprintStart
      ? plannedSprintEnd
      : historyEnd;

  if (!firstDateKey || !lastDateKey) {
    return [];
  }

  const states = new Map(
    [...initialStates.entries()].map(
      ([issueId, state]) => [
        issueId,
        { ...state },
      ]
    )
  );

  const orderedEvents = [...events].sort(
    (a, b) =>
      a.time.getTime() -
      b.time.getTime()
  );

  const plannedDuration = Math.max(
    1,
    plannedEnd.getTime() -
      sprintStart.getTime()
  );

  const points = [];

  function createPoint({
    timestamp,
    date,
    label,
    totals,
  }) {
    const progress = Math.min(
      1,
      Math.max(
        0,
        (timestamp.getTime() -
          sprintStart.getTime()) /
          plannedDuration
      )
    );

    return {
      date,
      timestamp: timestamp.toISOString(),
      label,

      scopePoints:
        totals.scopePoints,

      remainingPoints:
        totals.remainingPoints,

      completedPoints:
        totals.completedPoints,

      scopeItems:
        totals.scopeItems,

      remainingItems:
        totals.remainingItems,

      completedItems:
        totals.completedItems,

      remainingEffortHours:
        totals.remainingEstimateHours,

      timeSpentHours:
        totals.timeSpentHours,

      forecastHours:
        totals.forecastHours,

      idealRemainingPoints:
        roundNumber(
          Math.max(
            0,
            originalCommittedPoints *
              (1 - progress)
          )
        ),

      idealRemainingEffortHours:
        roundNumber(
          Math.max(
            0,
            secondsToHours(
              originalRemainingEstimateSeconds
            ) *
              (1 - progress)
          )
        ),
    };
  }

  /*
   * Preserve a true sprint-start snapshot before any event
   * occurring on the first calendar day is applied.
   * This prevents the first daily point from starting at the
   * end-of-day balance instead of the original commitment.
   */
  const startTotals =
    calculateHistoricalTotals({
      states,
      includeSubtasks,
      statusCategoryMap,
    });

  points.push(
    createPoint({
      timestamp: sprintStart,
      date: firstDateKey,
      label: `${firstDateKey} start`,
      totals: startTotals,
    })
  );

  let eventIndex = 0;
  let dateKey = firstDateKey;

  while (dateKey <= lastDateKey) {
    const dayEnd =
      dateKey === lastDateKey
        ? historyEnd
        : new Date(
            zonedDateTimeToUtc(
              addCalendarDays(dateKey, 1),
              timeZone,
              0,
              0,
              0,
              0
            ).getTime() - 1
          );

    while (
      eventIndex <
        orderedEvents.length &&
      orderedEvents[eventIndex].time <=
        dayEnd
    ) {
      const event =
        orderedEvents[eventIndex];

      applyHistoricalEvent(
        states.get(event.issueId),
        event
      );

      eventIndex += 1;
    }

    const totals =
      calculateHistoricalTotals({
        states,
        includeSubtasks,
        statusCategoryMap,
      });

    const isExactStartSnapshot =
      dayEnd.getTime() ===
      sprintStart.getTime();

    if (!isExactStartSnapshot) {
      points.push(
        createPoint({
          timestamp: dayEnd,
          date: dateKey,
          label:
            dateKey === lastDateKey
              ? `${dateKey} current`
              : `${dateKey} close`,
          totals,
        })
      );
    }

    if (dateKey === lastDateKey) {
      break;
    }

    dateKey =
      addCalendarDays(dateKey, 1);
  }

  return points;
}

function buildLiveBurndown({
  initialStates,
  events,
  sprintStart,
  historyEnd,
  plannedSprintEnd,
  includeSubtasks,
  statusCategoryMap,
  originalCommittedPoints,
  originalRemainingEstimateSeconds,
}) {
  const states = new Map(
    [...initialStates.entries()].map(
      ([issueId, state]) => [
        issueId,
        { ...state },
      ]
    )
  );

  const orderedEvents = [...events].sort(
    (a, b) =>
      a.time.getTime() -
      b.time.getTime()
  );

  const idealEnd =
    plannedSprintEnd &&
    plannedSprintEnd > sprintStart
      ? plannedSprintEnd
      : historyEnd;

  const plannedDuration = Math.max(
    1,
    idealEnd.getTime() -
      sprintStart.getTime()
  );

  const points = [];

  function addSnapshot(
    time,
    label,
    eventType
  ) {
    const totals =
      calculateHistoricalTotals({
        states,
        includeSubtasks,
        statusCategoryMap,
      });

    const progress = Math.min(
      1,
      Math.max(
        0,
        (time.getTime() -
          sprintStart.getTime()) /
          plannedDuration
      )
    );

    points.push({
      date:
        toDateOnly(time),

      timestamp:
        time.toISOString(),

      label,
      eventType,

      scopePoints:
        totals.scopePoints,

      remainingPoints:
        totals.remainingPoints,

      completedPoints:
        totals.completedPoints,

      scopeItems:
        totals.scopeItems,

      remainingItems:
        totals.remainingItems,

      completedItems:
        totals.completedItems,

      remainingEffortHours:
        totals.remainingEstimateHours,

      timeSpentHours:
        totals.timeSpentHours,

      forecastHours:
        totals.forecastHours,

      idealRemainingPoints:
        roundNumber(
          Math.max(
            0,
            originalCommittedPoints *
              (1 - progress)
          )
        ),

      idealRemainingEffortHours:
        roundNumber(
          Math.max(
            0,
            secondsToHours(
              originalRemainingEstimateSeconds
            ) *
              (1 - progress)
          )
        ),
    });
  }

  addSnapshot(
    sprintStart,
    'Sprint start',
    'sprint-start'
  );

  for (const event of orderedEvents) {
    applyHistoricalEvent(
      states.get(event.issueId),
      event
    );

    addSnapshot(
      event.time,
      `${event.key}: ${event.type}`,
      event.type
    );
  }

  const lastTimestamp =
    points.at(-1)?.timestamp;

  if (
    lastTimestamp !==
    historyEnd.toISOString()
  ) {
    addSnapshot(
      historyEnd,
      'Current',
      'current'
    );
  }

  return points;
}

async function calculateSprintHistory({
  sprint,
  currentSprintIssues,
  reportingFields,
  includeSubtasks,
}) {
  const sprintStart =
    parseDate(sprint.startDate);

  if (!sprintStart) {
    return {
      available: false,
      reason:
        'The sprint has no start date, so original commitment cannot be reconstructed.',
      warnings: [],
      events: [],
      burndown: [],
      burndownDaily: [],
      burndownLive: [],
    };
  }

  if (!reportingFields.sprint?.id) {
    return {
      available: false,
      reason:
        'The Jira Sprint field could not be detected.',
      warnings: [],
      events: [],
      burndown: [],
      burndownDaily: [],
      burndownLive: [],
    };
  }

  const now = new Date();

  const configuredEnd =
    parseDate(
      sprint.completeDate ??
        sprint.endDate
    );

  const historyEnd =
    configuredEnd &&
    configuredEnd < now
      ? configuredEnd
      : now;

  const plannedSprintEnd =
    parseDate(sprint.endDate) ??
    configuredEnd ??
    historyEnd;

  const timeZone =
    await getJiraTimeZone();

  const projectKey =
    currentSprintIssues.find(
      (issue) =>
        issue.fields?.project?.key
    )?.fields?.project?.key ?? null;

  if (!projectKey) {
    return {
      available: false,
      reason:
        'The project key could not be determined from the sprint.',
      warnings: [],
      events: [],
      burndown: [],
      burndownDaily: [],
      burndownLive: [],
    };
  }

  const candidateSearch =
    await searchProjectHistoryCandidates({
      projectKey,
      sprintStart,
      historyEnd,
      storyPointFieldId:
        reportingFields.storyPoints?.id ??
        null,
      sprintFieldId:
        reportingFields.sprint.id,
      timeZone,
    });

  const candidateIssues = mergeIssues(
    currentSprintIssues,
    candidateSearch.issues
  );

  const currentSprintIssueIds =
    new Set(
      currentSprintIssues.map(
        (issue) => String(issue.id)
      )
    );

  const changelogMap =
    await bulkFetchChangelogs({
      issues: candidateIssues,
      sprintFieldId:
        reportingFields.sprint.id,
      storyPointFieldId:
        reportingFields.storyPoints?.id ??
        null,
    });

  const initialStates = new Map();
  const allEvents = [];

  for (const issue of candidateIssues) {
    const issueId = String(issue.id);

    const histories =
      changelogMap.get(issueId) ?? [];

    const initialState =
      buildInitialHistoricalState({
        issue,
        histories,
        sprintStart,
        sprintId: sprint.id,
        sprintName: sprint.name,
        sprintFieldId:
          reportingFields.sprint.id,
        storyPointFieldId:
          reportingFields.storyPoints?.id ??
          null,
        currentSprintIssueIds,
      });

    initialStates.set(
      issueId,
      initialState
    );

    const issueEvents =
      buildHistoricalIssueEvents({
        issue,
        histories,
        initialState,
        sprintStart,
        historyEnd,
        sprintId: sprint.id,
        sprintName: sprint.name,
        sprintFieldId:
          reportingFields.sprint.id,
        storyPointFieldId:
          reportingFields.storyPoints?.id ??
          null,
      });

    allEvents.push(...issueEvents);
  }

  allEvents.sort(
    (a, b) =>
      a.time.getTime() -
      b.time.getTime()
  );

  const statusCategoryMap =
    await getStatusCategoryMap();

  const originalTotals =
    calculateHistoricalTotals({
      states: initialStates,
      includeSubtasks,
      statusCategoryMap,
    });

  const finalStates = new Map(
    [...initialStates.entries()].map(
      ([issueId, state]) => [
        issueId,
        { ...state },
      ]
    )
  );

  for (const event of allEvents) {
    applyHistoricalEvent(
      finalStates.get(event.issueId),
      event
    );
  }

  const currentTotals =
    calculateHistoricalTotals({
      states: finalStates,
      includeSubtasks,
      statusCategoryMap,
    });

  const addedEvents =
    allEvents.filter(
      (event) =>
        event.type === 'scope-added'
    );

  const removedEvents =
    allEvents.filter(
      (event) =>
        event.type === 'scope-removed'
    );

  const estimateEvents =
    allEvents.filter(
      (event) =>
        event.type ===
          'estimate-changed' &&
        event.inSprint
    );

  const originalEstimateEvents =
    allEvents.filter(
      (event) =>
        event.type ===
          'original-estimate-changed' &&
        event.inSprint
    );

  const remainingEstimateEvents =
    allEvents.filter(
      (event) =>
        event.type ===
          'remaining-estimate-changed' &&
        event.inSprint
    );

  const timeSpentEvents =
    allEvents.filter(
      (event) =>
        event.type ===
          'time-spent-changed' &&
        event.inSprint
    );

  const uniqueAddedKeys = [
    ...new Set(
      addedEvents.map(
        (event) => event.key
      )
    ),
  ];

  const uniqueRemovedKeys = [
    ...new Set(
      removedEvents.map(
        (event) => event.key
      )
    ),
  ];

  const pointsAdded =
    addedEvents.reduce(
      (sum, event) =>
        sum +
        (Number(event.storyPoints) ||
          0),
      0
    );

  const pointsRemoved =
    removedEvents.reduce(
      (sum, event) =>
        sum +
        (Number(event.storyPoints) ||
          0),
      0
    );

  const estimateDelta =
    estimateEvents.reduce(
      (sum, event) =>
        sum +
        (Number(event.delta) || 0),
      0
    );

  const burndownEnd =
    historyEnd < sprintStart
      ? sprintStart
      : historyEnd;

  const burndownDaily =
    buildDailyBurndown({
      initialStates,
      events: allEvents,
      sprintStart,
      historyEnd: burndownEnd,
      plannedSprintEnd,
      timeZone,
      includeSubtasks,
      statusCategoryMap,
      originalCommittedPoints:
        originalTotals.scopePoints,
      originalRemainingEstimateSeconds:
        originalTotals
          .remainingEstimateSeconds,
    });

  const burndownLive =
    buildLiveBurndown({
      initialStates,
      events: allEvents,
      sprintStart,
      historyEnd: burndownEnd,
      plannedSprintEnd,
      includeSubtasks,
      statusCategoryMap,
      originalCommittedPoints:
        originalTotals.scopePoints,
      originalRemainingEstimateSeconds:
        originalTotals
          .remainingEstimateSeconds,
    });

  const warnings = [];

  if (candidateSearch.truncated) {
    warnings.push(
      `History candidate search was limited to ${MAX_HISTORY_CANDIDATES} issues.`
    );
  }

  return {
    available: true,
    reason: null,
    projectKey,
    timeZone,
    calculatedAt:
      new Date().toISOString(),

    originalCommitment: {
      items:
        originalTotals.scopeItems,

      storyPoints:
        originalTotals.scopePoints,

      originalEstimateSeconds:
        originalTotals
          .originalEstimateSeconds,

      originalEstimateHours:
        originalTotals
          .originalEstimateHours,

      remainingEstimateSeconds:
        originalTotals
          .remainingEstimateSeconds,

      remainingEstimateHours:
        originalTotals
          .remainingEstimateHours,
    },

    currentScope: {
      items:
        currentTotals.scopeItems,
      storyPoints:
        currentTotals.scopePoints,
      completedItems:
        currentTotals.completedItems,
      completedStoryPoints:
        currentTotals.completedPoints,
      remainingItems:
        currentTotals.remainingItems,
      remainingStoryPoints:
        currentTotals.remainingPoints,

      originalEstimateSeconds:
        currentTotals
          .originalEstimateSeconds,

      originalEstimateHours:
        currentTotals
          .originalEstimateHours,

      remainingEstimateSeconds:
        currentTotals
          .remainingEstimateSeconds,

      remainingEstimateHours:
        currentTotals
          .remainingEstimateHours,

      timeSpentSeconds:
        currentTotals.timeSpentSeconds,

      timeSpentHours:
        currentTotals.timeSpentHours,

      forecastSeconds:
        currentTotals.forecastSeconds,

      forecastHours:
        currentTotals.forecastHours,

      varianceSeconds:
        currentTotals.varianceSeconds,

      varianceHours:
        currentTotals.varianceHours,

      variancePercentage:
        currentTotals
          .originalEstimateSeconds === 0
          ? 0
          : roundNumber(
              (currentTotals.varianceSeconds /
                currentTotals
                  .originalEstimateSeconds) *
                100,
              1
            ),
    },

    scopeChange: {
      addedItems:
        uniqueAddedKeys.length,
      addedStoryPoints:
        roundNumber(pointsAdded),
      addedIssueKeys:
        uniqueAddedKeys,

      removedItems:
        uniqueRemovedKeys.length,
      removedStoryPoints:
        roundNumber(pointsRemoved),
      removedIssueKeys:
        uniqueRemovedKeys,

      estimateChangeStoryPoints:
        roundNumber(estimateDelta),

      addedOriginalEstimateHours:
        secondsToHours(
          addedEvents.reduce(
            (sum, event) =>
              sum +
              (Number(
                event.originalEstimateSeconds
              ) || 0),
            0
          )
        ),

      removedOriginalEstimateHours:
        secondsToHours(
          removedEvents.reduce(
            (sum, event) =>
              sum +
              (Number(
                event.originalEstimateSeconds
              ) || 0),
            0
          )
        ),

      originalEstimateChangeHours:
        secondsToHours(
          originalEstimateEvents.reduce(
            (sum, event) =>
              sum +
              (Number(
                event.deltaSeconds
              ) || 0),
            0
          )
        ),

      remainingEstimateChangeHours:
        secondsToHours(
          remainingEstimateEvents.reduce(
            (sum, event) =>
              sum +
              (Number(
                event.deltaSeconds
              ) || 0),
            0
          )
        ),

      timeLoggedHours:
        secondsToHours(
          timeSpentEvents.reduce(
            (sum, event) =>
              sum +
              Math.max(
                0,
                Number(
                  event.deltaSeconds
                ) || 0
              ),
            0
          )
        ),
    },

    events: allEvents.map(
      (event) => ({
        ...event,

        time:
          event.time.toISOString(),

        originalEstimateHours:
          event
            .originalEstimateSeconds !==
          undefined
            ? secondsToHours(
                event
                  .originalEstimateSeconds
              )
            : undefined,

        remainingEstimateHours:
          event
            .remainingEstimateSeconds !==
          undefined
            ? secondsToHours(
                event
                  .remainingEstimateSeconds
              )
            : undefined,

        beforeHours:
          event.beforeSeconds !==
          undefined
            ? secondsToHours(
                event.beforeSeconds
              )
            : undefined,

        afterHours:
          event.afterSeconds !==
          undefined
            ? secondsToHours(
                event.afterSeconds
              )
            : undefined,

        deltaHours:
          event.deltaSeconds !==
          undefined
            ? secondsToHours(
                event.deltaSeconds
              )
            : undefined,
      })
    ),

    burndown:
      burndownDaily,

    burndownDaily,
    burndownLive,
    warnings,
  };
}

async function getClosedSprints(
  boardId,
  limit = 7
) {
  const allSprints = [];
  let startAt = 0;
  let isLast = false;

  while (
    !isLast &&
    allSprints.length < 100
  ) {
    const response =
      await jiraRequest(
        route`/rest/agile/1.0/board/${boardId}/sprint?state=closed&startAt=${startAt}&maxResults=50`,
        {
          headers: {
            Accept:
              'application/json',
          },
        }
      );

    const data = await readJson(
      response,
      'Loading closed sprints'
    );

    allSprints.push(
      ...(data.values ?? [])
    );

    isLast = Boolean(data.isLast);

    if (!isLast) {
      startAt +=
        data.maxResults ?? 50;
    }
  }

  return allSprints
    .sort((a, b) => {
      const aDate = new Date(
        a.completeDate ??
          a.endDate ??
          0
      ).getTime();

      const bDate = new Date(
        b.completeDate ??
          b.endDate ??
          0
      ).getTime();

      return bDate - aDate;
    })
    .slice(0, limit)
    .reverse();
}


defineLicensedResolver('getUsageStatus', async ({ context }) => {
  const { record } = await readUsageRecord(context);
  return buildUsageStatus(record);
});

defineLicensedResolver('registerExport', async ({ payload, context }) => {
  const exportType = String(payload?.exportType ?? '');

  if (exportType === 'pptx' && !FEATURE_FLAGS.powerPointEnabled) {
    throw new Error('PowerPoint generation is temporarily disabled.');
  }

  if (exportType === 'pdf' && !FEATURE_FLAGS.pdfEnabled) {
    throw new Error('PDF generation is temporarily disabled.');
  }

  if (!['pptx', 'pdf'].includes(exportType)) {
    throw new Error('A valid export type is required.');
  }

  return withUserOperationLock(
    context,
    exportType,
    async () => {
      const usage = await consumeUsage(context, exportType);

      structuredLog('export_authorized', {
        installationId: getInstallationIdentity(context),
        userId: getUserIdentity(context),
        exportType,
      });

      return {
        allowed: true,
        usage,
        featureFlags: FEATURE_FLAGS,
      };
    }
  );
});

defineLicensedResolver(
  'getSprintReport',
  async ({ payload, context }) =>
    withUserOperationLock(
      context,
      'report',
      async () => {
        if (!FEATURE_FLAGS.reportsEnabled) {
          throw new Error('Report generation is temporarily disabled.');
        }

        const startedAt = Date.now();
        const sprintId = Number(payload?.sprintId);
        const boardId = Number(payload?.boardId);
        const includeSubtasks = Boolean(payload?.includeSubtasks);
        const estimationOverride = String(payload?.estimationOverride ?? '').trim();
        const acceptanceCriteriaFieldId = String(payload?.acceptanceCriteriaFieldId ?? '').trim();

        if (!Number.isInteger(sprintId) || sprintId <= 0) {
          throw new Error('A valid sprint ID is required.');
        }

        const cacheKey = getReportCacheKey({
          userId: getUserIdentity(context),
          sprintId,
          includeSubtasks,
          boardId: Number.isInteger(boardId) && boardId > 0 ? boardId : 'none',
          estimationOverride,
          acceptanceCriteriaFieldId,
        });

        const cached = await getCachedValue(cacheKey);

        if (cached) {
          structuredLog('report_served', {
            installationId: getInstallationIdentity(context),
            userId: getUserIdentity(context),
            sprintId,
            cacheHit: true,
            durationMs: Date.now() - startedAt,
          });

          return {
            report: cached.value,
            meta: {
              cacheHit: true,
              generatedAt: cached.generatedAt,
              issueCount: cached.value?.metrics?.total ?? 0,
              featureFlags: FEATURE_FLAGS,
            },
          };
        }

        if (FEATURE_FLAGS.forceCachedReports) {
          throw new Error(
            'Fresh report generation is temporarily disabled. No cached report is available.'
          );
        }

        await consumeUsage(context, 'report');

    const discoveredReportingFields =
      await discoverReportingFields();

    const estimationSource =
      await resolveReportingEstimationSource({
        boardId,
        estimationOverride,
        reportingFields: discoveredReportingFields,
      });

    const acceptanceCriteriaField = resolveAcceptanceCriteriaField(
      discoveredReportingFields.allFields,
      acceptanceCriteriaFieldId
    );

    const storyPointFieldId = estimationSource.fieldId;

    const reportingFields = {
      ...discoveredReportingFields,
      storyPoints: {
        id: estimationSource.fieldId,
        name: estimationSource.name,
        unit: estimationSource.unit,
        type: estimationSource.type,
        source: estimationSource.source,
      },
    };

    const sprintFieldId =
      reportingFields.sprint?.id ??
      null;

    const sprintResponse =
      await jiraRequest(
        route`/rest/agile/1.0/sprint/${sprintId}`,
        {
          headers: {
            Accept:
              'application/json',
          },
        }
      );

    const sprint = await readJson(
      sprintResponse,
      'Loading sprint'
    );

    let issues =
      await getAllSprintIssues(
        sprintId,
        storyPointFieldId,
        sprintFieldId,
        { includeDescription: true, acceptanceCriteriaFieldId: acceptanceCriteriaField.id }
      );

    issues = await hydrateAcceptanceCriteriaIssueFields({
      sprintId,
      issues,
      acceptanceCriteriaFieldId: acceptanceCriteriaField.id,
      context,
    });

    const metrics =
      calculateSprintMetrics(
        issues,
        storyPointFieldId,
        includeSubtasks,
        acceptanceCriteriaField
      );

    metrics.acceptanceCriteria = summarizeAcceptanceCriteria(metrics.reportingIssues ?? []);
    metrics.traceability = summarizeTraceability(metrics.reportingIssues ?? []);

    const completedIssues =
      metrics.reportingIssues.filter(
        (issue) =>
          issue.statusCategoryKey ===
          'done'
      );

    const incompleteIssues =
      metrics.reportingIssues.filter(
        (issue) =>
          issue.statusCategoryKey !==
          'done'
      );

    const history =
      await calculateSprintHistory({
        sprint,
        currentSprintIssues: issues,
        reportingFields,
        includeSubtasks,
      });

    const reportResult = {
      sprint: {
        id: sprint.id,
        name: sprint.name,
        state: sprint.state,
        goal: sprint.goal ?? '',
        startDate:
          sprint.startDate ?? null,
        endDate:
          sprint.endDate ?? null,
        completeDate:
          sprint.completeDate ?? null,
      },

      storyPointField:
        reportingFields.storyPoints,

      estimationSource,

      acceptanceCriteriaSource: acceptanceCriteriaField,

      sprintField:
        reportingFields.sprint,

      metrics,

      sprintReport: {
        completedIssues,
        incompleteIssues,

        completedCount:
          completedIssues.length,

        incompleteCount:
          incompleteIssues.length,

        completedStoryPoints:
          metrics.completedStoryPoints,

        incompleteStoryPoints:
          metrics.remainingStoryPoints,
      },

      history,
    };

    const cacheTtlMilliseconds =
      reportResult.sprint.state === 'closed'
        ? 60 * 60 * 1000
        : 5 * 60 * 1000;

    await setCachedValue(
      cacheKey,
      reportResult,
      cacheTtlMilliseconds
    );

    structuredLog('report_generated', {
      installationId: getInstallationIdentity(context),
      userId: getUserIdentity(context),
      sprintId,
      issueCount: reportResult.metrics.total,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
    });

    return {
      report: reportResult,
      meta: {
        cacheHit: false,
        generatedAt: new Date().toISOString(),
        issueCount: reportResult.metrics.total,
        featureFlags: FEATURE_FLAGS,
      },
    };
      }
    )
);

defineLicensedResolver(
  'getVelocityReport',
  async ({ payload, context }) => {
    const boardId = Number(
      payload?.boardId
    );

    const includeSubtasks =
      Boolean(
        payload?.includeSubtasks
      );

    const estimationOverride = String(payload?.estimationOverride ?? '').trim();

    const velocityCacheKey = getVelocityCacheKey({
      userId: getUserIdentity(context),
      boardId,
      includeSubtasks,
      estimationOverride,
    });

    const cachedVelocity = await getCachedValue(velocityCacheKey);

    if (cachedVelocity) {
      structuredLog('velocity_cache_hit', {
        installationId: getInstallationIdentity(context),
        userId: getUserIdentity(context),
        boardId,
      });

      return {
        ...cachedVelocity.value,
        meta: {
          cacheHit: true,
          generatedAt: cachedVelocity.generatedAt,
        },
      };
    }

    if (
      !Number.isInteger(boardId) ||
      boardId <= 0
    ) {
      throw new Error(
        'A valid board ID is required.'
      );
    }

    const discoveredReportingFields =
      await discoverReportingFields();

    const estimationSource =
      await resolveReportingEstimationSource({
        boardId,
        estimationOverride,
        reportingFields: discoveredReportingFields,
      });

    const storyPointFieldId = estimationSource.fieldId;

    const reportingFields = {
      ...discoveredReportingFields,
      storyPoints: {
        id: estimationSource.fieldId,
        name: estimationSource.name,
        unit: estimationSource.unit,
        type: estimationSource.type,
        source: estimationSource.source,
      },
    };

    const sprintFieldId =
      reportingFields.sprint?.id ??
      null;

    const closedSprints =
      await getClosedSprints(
        boardId,
        FEATURE_FLAGS.velocitySprintLimit
      );

    const velocityStartedAt = Date.now();

    /*
     * Velocity is a required StatusDeck feature, but it should not perform
     * five full historical reconstructions serially. Each closed sprint is
     * independent, so process the configured recent sprint window in
     * parallel. Combined with the bounded history-candidate query above,
     * this keeps accurate sprint-start commitment reconstruction while
     * remaining within the Forge resolver budget for enterprise boards.
     */
    const velocityRows = await Promise.all(
      closedSprints.map(async (sprint) => {
        const sprintStartedAt = Date.now();

        const issues =
          await getAllSprintIssues(
            sprint.id,
            storyPointFieldId,
            sprintFieldId
          );

        const metrics =
          calculateSprintMetrics(
            issues,
            storyPointFieldId,
            includeSubtasks
          );

        let history = null;
        let historyError = null;

        try {
          history =
            await calculateSprintHistory({
              sprint,
              currentSprintIssues: issues,
              reportingFields,
              includeSubtasks,
            });
        } catch (caughtError) {
          historyError = String(
            caughtError?.message ?? caughtError
          );

          structuredLog('velocity_history_fallback', {
            installationId: getInstallationIdentity(context),
            userId: getUserIdentity(context),
            boardId,
            sprintId: sprint.id,
            reason: historyError,
          });
        }

        const historyAvailable =
          Boolean(history?.available);

        const committedStoryPoints =
          historyAvailable
            ? history.originalCommitment.storyPoints
            : metrics.committedStoryPoints;

        const completedStoryPoints =
          historyAvailable
            ? history.currentScope.completedStoryPoints
            : metrics.completedStoryPoints;

        const totalItems =
          historyAvailable
            ? history.originalCommitment.items
            : metrics.total;

        const completedItems =
          historyAvailable
            ? history.currentScope.completedItems
            : metrics.completed;

        structuredLog('velocity_sprint_calculated', {
          installationId: getInstallationIdentity(context),
          userId: getUserIdentity(context),
          boardId,
          sprintId: sprint.id,
          issueCount: metrics.total,
          commitmentSource: historyAvailable
            ? 'sprint-start-history'
            : 'current-scope-fallback',
          durationMs: Date.now() - sprintStartedAt,
        });

        return {
          sprintId: sprint.id,
          sprintName: sprint.name,
          startDate:
            sprint.startDate ?? null,
          endDate:
            sprint.endDate ?? null,
          completeDate:
            sprint.completeDate ?? null,

          committedStoryPoints,
          completedStoryPoints,
          totalItems,
          completedItems,

          commitmentSource:
            historyAvailable
              ? 'sprint-start-history'
              : 'current-scope-fallback',

          historyWarning:
            historyAvailable
              ? null
              : historyError ?? history?.reason ??
                'Sprint-start commitment history was unavailable.',
        };
      })
    );

    const velocity = velocityRows.sort((a, b) => {
      const aTime = Date.parse(a.completeDate ?? a.endDate ?? a.startDate ?? 0);
      const bTime = Date.parse(b.completeDate ?? b.endDate ?? b.startDate ?? 0);
      return aTime - bTime;
    });


    const completedValues =
      velocity.map((item) =>
        storyPointFieldId
          ? item.completedStoryPoints
          : item.completedItems
      );

    const averageCompleted =
      completedValues.length === 0
        ? 0
        : Math.round(
            (completedValues.reduce(
              (sum, value) =>
                sum + value,
              0
            ) /
              completedValues.length) *
              10
          ) / 10;

    const velocityResult = {
      storyPointField:
        reportingFields.storyPoints,

      estimationSource,

      usesStoryPoints:
        estimationSource.type !== 'issueCount',

      averageCompleted,
      velocity,
    };

    await setCachedValue(
      velocityCacheKey,
      velocityResult,
      30 * 60 * 1000
    );

    structuredLog('velocity_generated', {
      installationId: getInstallationIdentity(context),
      userId: getUserIdentity(context),
      boardId,
      sprintCount: velocity.length,
      fallbackCount: velocity.filter(
        (item) => item.commitmentSource !== 'sprint-start-history'
      ).length,
      durationMs: Date.now() - velocityStartedAt,
    });

    return {
      ...velocityResult,
      meta: {
        cacheHit: false,
        generatedAt: new Date().toISOString(),
      },
    };
  }
);


// =========================================================
// StatusDeck configuration, commentary and board discovery
// =========================================================

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
    native: { completion: true, completed: true, remaining: true, overdue: true, defects: true, velocity: true, workload: true, acceptanceCriteria: true },
    custom: [],
  },
};

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function normaliseReportingSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  const rag = source.rag && typeof source.rag === 'object' ? source.rag : {};
  const readiness = source.readiness && typeof source.readiness === 'object' ? source.readiness : {};
  const accessibility = source.accessibility && typeof source.accessibility === 'object' ? source.accessibility : {};
  const kpiProfile = source.kpiProfile && typeof source.kpiProfile === 'object' ? source.kpiProfile : {};
  const nativeKpis = kpiProfile.native && typeof kpiProfile.native === 'object' ? kpiProfile.native : {};
  const customKpis = Array.isArray(kpiProfile.custom) ? kpiProfile.custom.slice(0, 12) : [];

  return {
    version: 1,
    estimationOverride: String(source.estimationOverride ?? '').slice(0, 120),
    rag: {
      greenCompletion: clampNumber(rag.greenCompletion, 0, 100, DEFAULT_REPORTING_SETTINGS.rag.greenCompletion),
      amberCompletion: clampNumber(rag.amberCompletion, 0, 100, DEFAULT_REPORTING_SETTINGS.rag.amberCompletion),
      amberOpenDefects: clampNumber(rag.amberOpenDefects, 0, 999, DEFAULT_REPORTING_SETTINGS.rag.amberOpenDefects),
      redOpenDefects: clampNumber(rag.redOpenDefects, 0, 999, DEFAULT_REPORTING_SETTINGS.rag.redOpenDefects),
      amberOverdue: clampNumber(rag.amberOverdue, 0, 999, DEFAULT_REPORTING_SETTINGS.rag.amberOverdue),
      redOverdue: clampNumber(rag.redOverdue, 0, 999, DEFAULT_REPORTING_SETTINGS.rag.redOverdue),
      minimumRemainingEstimateCoverage: clampNumber(rag.minimumRemainingEstimateCoverage, 0, 100, DEFAULT_REPORTING_SETTINGS.rag.minimumRemainingEstimateCoverage),
    },
    readiness: {
      requireEstimate: readiness.requireEstimate !== false,
      requireAssignee: readiness.requireAssignee !== false,
      requireSprintGoal: readiness.requireSprintGoal !== false,
      requireDueDate: readiness.requireDueDate === true,
      maximumVelocityLoad: clampNumber(readiness.maximumVelocityLoad, 25, 300, DEFAULT_REPORTING_SETTINGS.readiness.maximumVelocityLoad),
      minimumAcceptanceCriteriaCoverage: clampNumber(readiness.minimumAcceptanceCriteriaCoverage, 0, 100, DEFAULT_REPORTING_SETTINGS.readiness.minimumAcceptanceCriteriaCoverage),
      acceptanceCriteriaFieldId: String(readiness.acceptanceCriteriaFieldId ?? '').slice(0, 120),
    },
    accessibility: {
      showStatusText: accessibility.showStatusText !== false,
      usePatternsWithColour: accessibility.usePatternsWithColour !== false,
    },
    kpiProfile: {
      native: {
        completion: nativeKpis.completion !== false,
        completed: nativeKpis.completed !== false,
        remaining: nativeKpis.remaining !== false,
        overdue: nativeKpis.overdue !== false,
        defects: nativeKpis.defects !== false,
        velocity: nativeKpis.velocity !== false,
        workload: nativeKpis.workload !== false,
        acceptanceCriteria: nativeKpis.acceptanceCriteria !== false,
        daysRemaining: nativeKpis.daysRemaining !== false,
      },
      custom: customKpis.map((item, index) => ({
        id: String(item?.id || `custom-${index + 1}`).slice(0, 80),
        name: String(item?.name || 'Custom KPI').slice(0, 120),
        sourceType: ['savedFilter', 'dashboard', 'customJql'].includes(String(item?.sourceType)) ? String(item.sourceType) : 'customJql',
        filterId: String(item?.filterId || '').slice(0, 80),
        dashboardId: String(item?.dashboardId || '').slice(0, 80),
        gadgetId: String(item?.gadgetId || '').slice(0, 80),
        gadgetTitle: String(item?.gadgetTitle || '').slice(0, 160),
        gadgetType: String(item?.gadgetType || '').slice(0, 80),
        moduleKey: String(item?.moduleKey || '').slice(0, 240),
        statisticType: String(item?.statisticType || '').slice(0, 120),
        xStatistic: String(item?.xStatistic || '').slice(0, 120),
        yStatistic: String(item?.yStatistic || '').slice(0, 120),
        period: String(item?.period || '').slice(0, 40),
        daysPreviously: clampNumber(item?.daysPreviously, 0, 5000, 0),
        insightBoardId: String(item?.insightBoardId || '').slice(0, 80),
        insightSprintId: String(item?.insightSprintId || '').slice(0, 80),
        jql: String(item?.jql || '').slice(0, 2000),
        aggregation: ['count', 'sumStoryPoints', 'sumOriginalEstimate', 'sumRemainingEstimate'].includes(String(item?.aggregation)) ? String(item.aggregation) : 'count',
        target: String(item?.target || 'both') === 'project' ? 'project' : String(item?.target || 'both') === 'sprint' ? 'sprint' : 'both',
        greenMax: Number.isFinite(Number(item?.greenMax)) ? Number(item.greenMax) : null,
        amberMax: Number.isFinite(Number(item?.amberMax)) ? Number(item.amberMax) : null,
        enabled: item?.enabled !== false,
      })),
    },
  };
}

function validateReportingSettings(settings) {
  const value = normaliseReportingSettings(settings);
  const errors = [];

  if (value.rag.amberCompletion > value.rag.greenCompletion) {
    errors.push('Amber completion must be less than or equal to Green completion.');
  }
  if (value.rag.amberOpenDefects > value.rag.redOpenDefects) {
    errors.push('Amber unresolved defects must be less than or equal to Red unresolved defects.');
  }
  if (value.rag.amberOverdue > value.rag.redOverdue) {
    errors.push('Amber overdue items must be less than or equal to Red overdue items.');
  }

  if (errors.length) {
    throw new Error(errors.join(' '));
  }

  return value;
}

function getSettingsKey(context, projectKey, boardId) {
  return `settings:${getInstallationIdentity(context)}:${safeIdentifier(projectKey || 'global')}:${safeIdentifier(boardId || 'all')}`;
}

function getCommentaryKey(context, projectKey, boardId, sprintId) {
  return `commentary:${getInstallationIdentity(context)}:${safeIdentifier(projectKey || 'project')}:${safeIdentifier(boardId || 'board')}:${safeIdentifier(sprintId || 'sprint')}`;
}

function getScheduleKey(context, projectKey, boardId) {
  return `schedule:${getInstallationIdentity(context)}:${safeIdentifier(projectKey || 'project')}:${safeIdentifier(boardId || 'all')}`;
}

function getLastPublicationKey(context, projectKey, boardId, sprintId) {
  return `publication:${getInstallationIdentity(context)}:${safeIdentifier(projectKey || 'project')}:${safeIdentifier(boardId || 'board')}:${safeIdentifier(sprintId || 'sprint')}`;
}

defineLicensedResolver('getBoardReportingConfiguration', async ({ payload }) => {
  const boardId = Number(payload?.boardId);
  if (!Number.isInteger(boardId) || boardId <= 0) {
    throw new Error('A valid board ID is required.');
  }

  const [configurationResponse, fieldsResponse] = await Promise.all([
    jiraRequest(route`/rest/agile/1.0/board/${boardId}/configuration`, { headers: { Accept: 'application/json' } }, 'Loading board configuration'),
    jiraRequest(route`/rest/api/3/field`, { headers: { Accept: 'application/json' } }, 'Loading Jira fields'),
  ]);

  const configuration = await readJson(configurationResponse, 'Loading board configuration');
  const fields = await readJson(fieldsResponse, 'Loading Jira fields');
  const estimation = configuration?.estimation ?? { type: 'none' };
  const fieldId = estimation?.field?.fieldId ?? estimation?.field?.id ?? null;
  const field = fieldId ? fields.find((candidate) => candidate.id === fieldId) ?? null : null;

  const numericFields = fields
    .filter((candidate) => ['number', 'integer'].includes(String(candidate?.schema?.type ?? '').toLowerCase()))
    .map((candidate) => ({ id: candidate.id, name: candidate.name, custom: Boolean(candidate.custom) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const acceptanceCriteriaFields = [
    { id: 'description', name: 'Description', custom: false, likely: true },
    ...fields
      .filter((candidate) => {
        const schemaType = String(candidate?.schema?.type ?? '').toLowerCase();
        const customType = String(candidate?.schema?.custom ?? '').toLowerCase();
        return Boolean(candidate?.custom) && (['string', 'array'].includes(schemaType) || customType.includes('textarea') || customType.includes('textfield'));
      })
      .map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        custom: true,
        likely: /acceptance\s*(criteria|criterion|conditions?)|\bAC\b/i.test(String(candidate.name ?? '')),
      }))
      .sort((a, b) => Number(b.likely) - Number(a.likely) || a.name.localeCompare(b.name)),
  ].slice(0, 160);

  return {
    boardId,
    estimation: {
      type: estimation?.type ?? 'none',
      fieldId,
      fieldName: field?.name ?? estimation?.field?.displayName ?? null,
    },
    numericFields,
    acceptanceCriteriaFields,
    columnConfig: (configuration?.columnConfig?.columns ?? []).map((column) => ({
      name: column.name,
      statuses: (column.statuses ?? []).map((status) => ({ id: status.id, self: status.self })),
    })),
  };
});

defineLicensedResolver('getReportingSettings', async ({ payload, context }) => {
  const projectKey = String(payload?.projectKey ?? '').trim();
  const boardId = String(payload?.boardId ?? '').trim();
  const key = getSettingsKey(context, projectKey, boardId);
  const stored = await kvs.get(key);
  return normaliseReportingSettings(stored ?? DEFAULT_REPORTING_SETTINGS);
});

defineLicensedResolver('saveReportingSettings', async ({ payload, context }) => {
  const projectKey = String(payload?.projectKey ?? '').trim();
  const boardId = String(payload?.boardId ?? '').trim();
  const settings = validateReportingSettings(payload?.settings);
  const key = getSettingsKey(context, projectKey, boardId);
  await kvs.set(key, settings);
  return settings;
});


function normaliseDashboardStatistic(value) {
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

function findDashboardConfigValue(value, patterns) {
  let found = '';
  const visit = (node) => {
    if (found || node == null) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node !== 'object') return;
    for (const [key, item] of Object.entries(node)) {
      if (found) break;
      if (patterns.some((pattern) => pattern.test(key))) {
        const candidate = normaliseDashboardStatistic(item);
        if (candidate) { found = candidate; break; }
      }
      visit(item);
    }
  };
  visit(value);
  return found;
}

function detectDashboardGadgetType(gadget) {
  const text = `${gadget?.moduleKey ?? ''} ${gadget?.uri ?? ''} ${gadget?.title ?? ''}`.toLowerCase();
  if (text.includes('created vs resolved') || text.includes('created vs. resolved') || text.includes('created-vs-resolved') || text.includes('createdvsresolved')) return 'createdResolved';
  if (text.includes('days remaining') || text.includes('sprint-days-remaining') || text.includes('daysremaining')) return 'daysRemaining';
  if (text.includes('two-dimensional') || text.includes('twodimensional') || text.includes('two dimensional')) return 'twoDimensional';
  if (text.includes('pie')) return 'pie';
  if (text.includes('filter result') || text.includes('filter-results') || text.includes('filterresults')) return 'filterResults';
  return 'count';
}

function findDashboardScalarValue(value, patterns) {
  let found = null;
  const visit = (node) => {
    if (found != null || node == null) return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (typeof node !== 'object') return;
    for (const [key, item] of Object.entries(node)) {
      if (found != null) break;
      if (patterns.some((pattern) => pattern.test(key)) && ['string', 'number', 'boolean'].includes(typeof item)) {
        found = item;
        break;
      }
      visit(item);
    }
  };
  visit(value);
  return found;
}

defineLicensedResolver('getJiraKpiSources', async () => {
  const safeRead = async (path, label) => {
    try {
      const response = await jiraRequest(path, { headers: { Accept: 'application/json' } }, label);
      return await readJson(response, label);
    } catch (caughtError) {
      structuredLog('kpi_source_catalogue_warning', { label, message: String(caughtError?.message ?? caughtError) });
      return null;
    }
  };
  const [filtersData, dashboardsData] = await Promise.all([
    safeRead(route`/rest/api/3/filter/search?maxResults=100&expand=jql,owner,sharePermissions`, 'Loading saved Jira filters'),
    safeRead(route`/rest/api/3/dashboard/search?maxResults=50`, 'Loading Jira dashboards'),
  ]);
  const filters = (filtersData?.values ?? []).map((filter) => ({ id: String(filter.id ?? ''), name: filter.name ?? 'Unnamed filter', jql: filter.jql ?? '', favourite: Boolean(filter.favourite), owner: filter.owner?.displayName ?? '' }));
  const dashboards = (dashboardsData?.values ?? []).map((dashboard) => ({ id: String(dashboard.id ?? ''), name: dashboard.name ?? 'Unnamed dashboard', owner: dashboard.owner?.displayName ?? '' }));
  const filterIds = new Set(filters.map((filter) => String(filter.id)));
  const findFilterId = (value) => {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value);
      if (filterIds.has(text)) return text;
      const match = text.match(/(?:filter(?:Id)?[=: ]+|filter-)(\d+)/i);
      return match && filterIds.has(match[1]) ? match[1] : '';
    }
    if (Array.isArray(value)) { for (const item of value) { const found = findFilterId(item); if (found) return found; } return ''; }
    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (/filter.?id/i.test(key) && filterIds.has(String(item))) return String(item);
        const found = findFilterId(item); if (found) return found;
      }
    }
    return '';
  };
  const dashboardSources = [];
  await Promise.all(dashboards.slice(0, 12).map(async (dashboard) => {
    const gadgetData = await safeRead(route`/rest/api/3/dashboard/${dashboard.id}/gadget`, `Loading dashboard ${dashboard.name}`);
    for (const gadget of (gadgetData?.gadgets ?? []).slice(0, 20)) {
      const keysData = await safeRead(route`/rest/api/3/dashboard/${dashboard.id}/items/${gadget.id}/properties`, `Loading dashboard gadget properties`);
      const keys = (keysData?.keys ?? []).map((item) => item?.key ?? item).filter(Boolean).slice(0, 12);
      const properties = [];
      for (const key of keys) {
        const property = await safeRead(route`/rest/api/3/dashboard/${dashboard.id}/items/${gadget.id}/properties/${String(key)}`, 'Loading dashboard gadget property');
        if (property != null) properties.push(property?.value ?? property);
      }
      const filterId = findFilterId(properties);
      const gadgetType = detectDashboardGadgetType(gadget);
      // Most reusable Jira gadgets are filter-backed. Days Remaining is board/sprint-backed,
      // so keep it in the catalogue even when there is no saved-filter reference.
      if (!filterId && gadgetType !== 'daysRemaining') continue;
      const statisticType = findDashboardConfigValue(properties, [/stat(?:istic)?type/i, /group(?:by)?/i]);
      const xStatistic = findDashboardConfigValue(properties, [/^xstat/i, /xaxis/i, /rowstat/i]);
      const yStatistic = findDashboardConfigValue(properties, [/^ystat/i, /yaxis/i, /columnstat/i]);
      const period = String(findDashboardScalarValue(properties, [/period(?:name)?/i, /interval/i]) ?? '').slice(0, 40);
      const daysPreviously = Number(findDashboardScalarValue(properties, [/days.?previous/i, /previous.?days/i, /num.?days/i]) ?? 0) || 0;
      const boardId = String(findDashboardScalarValue(properties, [/rapid.?view.?id/i, /^board.?id$/i, /boardId/i]) ?? '').slice(0, 80);
      const sprintId = String(findDashboardScalarValue(properties, [/^sprint.?id$/i, /sprintId/i]) ?? '').slice(0, 80);
      dashboardSources.push({
        dashboardId: dashboard.id,
        dashboardName: dashboard.name,
        gadgetId: String(gadget.id ?? ''),
        gadgetTitle: gadget.title ?? 'Jira dashboard gadget',
        gadgetType,
        filterId,
        statisticType,
        xStatistic,
        yStatistic,
        period,
        daysPreviously,
        boardId,
        sprintId,
        moduleKey: String(gadget.moduleKey ?? ''),
      });
    }
  }));
  return {
    filters,
    dashboards,
    dashboardSources,
    dashboardNote: dashboardSources.length
      ? `${dashboardSources.length} filter-backed dashboard gadget source(s) can be reproduced from their Jira filter and gadget configuration.`
      : 'Dashboards are visible, but Jira did not expose a reusable saved-filter reference for their gadgets. StatusDeck will not guess a gadget calculation.',
  };
});

function splitCustomKpiOrderBy(jql) {
  const value = String(jql ?? '').trim();
  if (!value) return { query: '', orderBy: '' };

  // ORDER BY is only valid at the end of a Jira JQL statement. Keep it outside
  // StatusDeck's report-context wrapper instead of producing `(… ORDER BY …) AND …`.
  const match = value.match(/\s+ORDER\s+BY\s+/i);
  if (!match || match.index == null) return { query: value, orderBy: '' };
  return {
    query: value.slice(0, match.index).trim(),
    orderBy: value.slice(match.index).trim(),
  };
}

function buildCustomInsightJql(definition) {
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

async function getJqlExactCount(jql) {
  // Atlassian removed POST /rest/api/3/search (CHANGE-2046). For a KPI count,
  // use the supported count endpoint rather than calling the removed search API.
  // Jira labels this resource approximate-count, so preserve that provenance in
  // the result instead of claiming an exact count we did not calculate ourselves.
  const response = await jiraRequest(route`/rest/api/3/search/approximate-count`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql }),
  }, 'Counting Jira insight');
  if (!response.ok) {
    const body = await response.text();
    return { error: getCustomKpiJiraError(body, response.status) };
  }
  const data = await response.json();
  return { count: Number(data?.count ?? 0), approximate: true };
}

function getInsightFieldValue(issue, fieldKey) {
  const value = issue?.fields?.[fieldKey];
  if (value == null) return { key: '__none__', label: 'None' };
  if (Array.isArray(value)) {
    if (!value.length) return { key: '__none__', label: 'None' };
    const first = value[0];
    return { key: String(first?.id ?? first?.accountId ?? first?.value ?? first?.name ?? first), label: String(first?.displayName ?? first?.name ?? first?.value ?? first) };
  }
  if (typeof value === 'object') return { key: String(value.id ?? value.accountId ?? value.value ?? value.name ?? value.displayName ?? '__value__'), label: String(value.displayName ?? value.name ?? value.value ?? value.id ?? 'Value') };
  return { key: String(value), label: String(value) };
}

async function fetchAllInsightIssues(jql, fields, hardCap = 12500) {
  // Enhanced JQL search is token-paginated. Do not use startAt here: Jira's
  // replacement for the removed /rest/api/3/search endpoint returns a
  // nextPageToken which must be sent back on the following request.
  const issues = [];
  let nextPageToken;

  do {
    const requestBody = {
      jql,
      maxResults: 100,
      fields,
    };
    if (nextPageToken) requestBody.nextPageToken = nextPageToken;

    const response = await jiraRequest(route`/rest/api/3/search/jql`, {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    }, 'Loading Jira dashboard insight data');

    if (!response.ok) {
      const body = await response.text();
      return { error: getCustomKpiJiraError(body, response.status), issues: [] };
    }

    const data = await response.json();
    const page = Array.isArray(data?.issues) ? data.issues : [];
    issues.push(...page);
    nextPageToken = data?.nextPageToken || null;

    if (issues.length >= hardCap && nextPageToken) {
      return {
        error: `This dashboard contains more than ${hardCap} issues, above StatusDeck's ${hardCap}-issue dashboard reproduction limit.`,
        issues: [],
        total: issues.length,
      };
    }
  } while (nextPageToken);

  return { issues, total: issues.length };
}

function aggregatePieInsight(issues, statisticType) {
  const map = new Map();
  issues.forEach((issue) => {
    const item = getInsightFieldValue(issue, statisticType);
    const current = map.get(item.key) ?? { key: item.key, label: item.label, value: 0 };
    current.value += 1; map.set(item.key, current);
  });
  return [...map.values()].sort((a,b) => b.value - a.value || a.label.localeCompare(b.label));
}

function aggregateTwoDimensionalInsight(issues, rowField, columnField) {
  const rows = new Map(); const columns = new Map(); const cells = new Map();
  issues.forEach((issue) => {
    const row = getInsightFieldValue(issue, rowField); const col = getInsightFieldValue(issue, columnField);
    rows.set(row.key, row.label); columns.set(col.key, col.label);
    const key = `${row.key}|||${col.key}`; cells.set(key, (cells.get(key) ?? 0) + 1);
  });
  const rowList = [...rows.entries()].map(([key,label]) => ({ key,label }));
  const columnList = [...columns.entries()].map(([key,label]) => ({ key,label }));
  const matrix = rowList.map((row) => ({ rowKey: row.key, rowLabel: row.label, values: columnList.map((col) => cells.get(`${row.key}|||${col.key}`) ?? 0) }));
  return { rows: matrix, columns: columnList };
}

function getCustomKpiJiraError(body, status) {
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
  return `Jira rejected this KPI query (HTTP ${status}).`;
}

defineLicensedResolver('evaluateCustomKpis', async ({ payload }) => {
  const definitions = Array.isArray(payload?.definitions) ? payload.definitions.slice(0, 12) : [];
  const results = [];
  const issueCache = new Map();

  for (const definition of definitions) {
    if (definition?.enabled === false) continue;
    const id = String(definition?.id ?? '');
    const name = String(definition?.name ?? definition?.gadgetTitle ?? 'Custom Jira insight');
    try {
      const built = buildCustomInsightJql(definition);
      if (built.error) { results.push({ id, name, error: built.error }); continue; }
      const jql = built.jql;
      const countResult = await getJqlExactCount(jql);
      if (countResult.error) { results.push({ id, name, error: countResult.error, jql }); continue; }

      if (String(definition?.sourceType) === 'dashboard') {
        const explicitGadgetType = String(definition?.gadgetType || '').trim();
        const gadgetType = explicitGadgetType && explicitGadgetType !== 'count'
          ? explicitGadgetType
          : detectDashboardGadgetType({
              moduleKey: definition?.moduleKey,
              title: definition?.gadgetTitle || definition?.name,
            });
        const statisticType = normaliseDashboardStatistic(definition?.statisticType);
        const xStatistic = normaliseDashboardStatistic(definition?.xStatistic);
        const yStatistic = normaliseDashboardStatistic(definition?.yStatistic);
        if (gadgetType === 'pie' && statisticType) {
          const cacheKey = `${jql}::${statisticType}`;
          if (!issueCache.has(cacheKey)) issueCache.set(cacheKey, await fetchAllInsightIssues(jql, [statisticType]));
          const fetched = issueCache.get(cacheKey);
          if (fetched.error) { results.push({ id, name, error: fetched.error, jql }); continue; }
          results.push({ id, name, sourceType: 'dashboard', viewType: 'pie', value: countResult.count, matchedIssues: countResult.count, approximate: countResult.approximate, statisticType, series: aggregatePieInsight(fetched.issues, statisticType), jql });
          continue;
        }
        if (gadgetType === 'twoDimensional' && xStatistic && yStatistic) {
          const fields = [...new Set([xStatistic, yStatistic])];
          const cacheKey = `${jql}::${fields.sort().join(',')}`;
          if (!issueCache.has(cacheKey)) issueCache.set(cacheKey, await fetchAllInsightIssues(jql, fields));
          const fetched = issueCache.get(cacheKey);
          if (fetched.error) { results.push({ id, name, error: fetched.error, jql }); continue; }
          results.push({ id, name, sourceType: 'dashboard', viewType: 'twoDimensional', value: countResult.count, matchedIssues: countResult.count, approximate: countResult.approximate, xStatistic, yStatistic, table: aggregateTwoDimensionalInsight(fetched.issues, xStatistic, yStatistic), jql });
          continue;
        }
        results.push({ id, name, sourceType: 'dashboard', viewType: 'count', value: countResult.count, matchedIssues: countResult.count, approximate: countResult.approximate, warning: gadgetType !== 'count' ? 'Jira exposed the filter but not enough portable gadget configuration to reproduce this visual exactly.' : '', jql });
        continue;
      }

      results.push({ id, name, sourceType: String(definition?.sourceType ?? 'savedFilter'), viewType: 'count', value: countResult.count, matchedIssues: countResult.count, approximate: countResult.approximate, jql });
    } catch (caughtError) {
      console.error('Custom Jira insight evaluation failed unexpectedly', { id, name, message: String(caughtError?.message ?? caughtError) });
      results.push({ id, name, error: String(caughtError?.message ?? caughtError ?? 'Unable to evaluate this Jira insight.') });
    }
  }
  return results;
});

defineLicensedResolver('getCommentaryOverlay', async ({ payload, context }) => {
  const key = getCommentaryKey(context, payload?.projectKey, payload?.boardId, payload?.sprintId);
  return (await kvs.get(key)) ?? { draft: '', published: '', state: 'generated', updatedAt: null, updatedBy: null, reportFingerprint: '' };
});

defineLicensedResolver('saveCommentaryOverlay', async ({ payload, context }) => {
  const state = payload?.state === 'published' ? 'published' : 'draft';
  const text = String(payload?.text ?? '').slice(0, 12000);
  const key = getCommentaryKey(context, payload?.projectKey, payload?.boardId, payload?.sprintId);
  const existing = (await kvs.get(key)) ?? {};
  const next = {
    draft: state === 'draft' ? text : String(existing.draft ?? text),
    published: state === 'published' ? text : String(existing.published ?? ''),
    state,
    updatedAt: new Date().toISOString(),
    updatedBy: getUserIdentity(context),
    reportFingerprint: String(payload?.reportFingerprint ?? '').slice(0, 500),
  };
  await kvs.set(key, next);
  return next;
});

defineLicensedResolver('clearCommentaryOverlay', async ({ payload, context }) => {
  const key = getCommentaryKey(context, payload?.projectKey, payload?.boardId, payload?.sprintId);
  await kvs.delete(key);
  return { cleared: true };
});

defineLicensedResolver('getAssistantSprintSnapshot', async ({ payload, context }) => {
  const sprintId = Number(payload?.sprintId);
  const boardId = Number(payload?.boardId);
  const includeSubtasks = Boolean(payload?.includeSubtasks);
  const estimationOverride = String(payload?.estimationOverride ?? '').trim();

  if (!Number.isInteger(sprintId) || sprintId <= 0) {
    throw new Error('A valid sprint ID is required for the StatusDeck Assistant.');
  }
  if (!Number.isInteger(boardId) || boardId <= 0) {
    throw new Error('A valid board ID is required for the StatusDeck Assistant.');
  }

  const discoveredReportingFields = await discoverReportingFields();
  const estimationSource = await resolveReportingEstimationSource({
    boardId,
    estimationOverride,
    reportingFields: discoveredReportingFields,
  });
  const storyPointFieldId = estimationSource.fieldId;
  const reportingFields = {
    ...discoveredReportingFields,
    storyPoints: {
      id: estimationSource.fieldId,
      name: estimationSource.name,
      unit: estimationSource.unit,
      type: estimationSource.type,
      source: estimationSource.source,
    },
  };
  const sprintFieldId = reportingFields.sprint?.id ?? null;

  const sprintResponse = await jiraRequest(
    route`/rest/agile/1.0/sprint/${sprintId}`,
    { headers: { Accept: 'application/json' } }
  );
  const sprint = await readJson(sprintResponse, 'Loading sprint for StatusDeck Assistant');
  const issues = await getAllSprintIssues(sprintId, storyPointFieldId, sprintFieldId);
  const metrics = calculateSprintMetrics(issues, storyPointFieldId, includeSubtasks);
  const history = await calculateSprintHistory({
    sprint,
    currentSprintIssues: issues,
    reportingFields,
    includeSubtasks,
  });

  structuredLog('assistant_sprint_query', {
    installationId: getInstallationIdentity(context),
    userId: getUserIdentity(context),
    sprintId,
    boardId,
    issueCount: metrics.total,
  });

  return {
    sprint: {
      id: sprint.id,
      name: sprint.name,
      state: sprint.state,
      goal: sprint.goal ?? '',
      startDate: sprint.startDate ?? null,
      endDate: sprint.endDate ?? null,
      completeDate: sprint.completeDate ?? null,
    },
    storyPointField: reportingFields.storyPoints,
    estimationSource,
    sprintField: reportingFields.sprint,
    metrics,
    sprintReport: {
      completedIssues: metrics.reportingIssues.filter((issue) => issue.statusCategoryKey === 'done'),
      incompleteIssues: metrics.reportingIssues.filter((issue) => issue.statusCategoryKey !== 'done'),
      completedCount: metrics.reportingIssues.filter((issue) => issue.statusCategoryKey === 'done').length,
      incompleteCount: metrics.reportingIssues.filter((issue) => issue.statusCategoryKey !== 'done').length,
      completedStoryPoints: metrics.completedStoryPoints,
      incompleteStoryPoints: metrics.remainingStoryPoints,
    },
    history,
  };
});

defineLicensedResolver('getLastPublication', async ({ payload, context }) => {
  const key = getLastPublicationKey(context, payload?.projectKey, payload?.boardId, payload?.sprintId);
  return (await kvs.get(key)) ?? null;
});

defineLicensedResolver('saveLastPublication', async ({ payload, context }) => {
  const publication = {
    destination: payload?.destination === 'confluence' ? 'confluence' : 'confluence',
    pageId: String(payload?.pageId ?? '').slice(0, 80),
    pageTitle: String(payload?.pageTitle ?? '').slice(0, 300),
    pageUrl: String(payload?.pageUrl ?? '').slice(0, 1000),
    spaceId: String(payload?.spaceId ?? '').slice(0, 80),
    spaceKey: String(payload?.spaceKey ?? '').slice(0, 80),
    spaceName: String(payload?.spaceName ?? '').slice(0, 300),
    parentPageId: String(payload?.parentPageId ?? '').slice(0, 80),
    parentPageTitle: String(payload?.parentPageTitle ?? '').slice(0, 300),
    reportName: String(payload?.reportName ?? '').slice(0, 300),
    projectKey: String(payload?.projectKey ?? '').slice(0, 80),
    boardId: String(payload?.boardId ?? '').slice(0, 80),
    sprintId: String(payload?.sprintId ?? '').slice(0, 80),
    pdfFileName: String(payload?.pdfFileName ?? '').slice(0, 300),
    pptxFileName: String(payload?.pptxFileName ?? '').slice(0, 300),
    status: 'success',
    publishedAt: new Date().toISOString(),
    publishedBy: getUserIdentity(context),
  };
  const key = getLastPublicationKey(context, publication.projectKey, publication.boardId, publication.sprintId);
  await kvs.set(key, publication);
  return publication;
});

defineLicensedResolver('getReportSchedule', async ({ payload, context }) => {
  const key = getScheduleKey(context, payload?.projectKey, payload?.boardId);
  return (await kvs.get(key)) ?? {
    enabled: false,
    cadence: 'weekly',
    dayOfWeek: 5,
    time: '15:00',
    timeZone: 'UTC',
    recipients: '',
    message: 'StatusDeck reporting is due. Please review the current sprint report.',
    reminderMinutes: 15,
  };
});

defineLicensedResolver('saveReportSchedule', async ({ payload, context }) => {
  const requestedTime = String(payload?.schedule?.time ?? '').trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(requestedTime)) {
    throw new Error('Reporting schedule time must use HH:mm, for example 15:15.');
  }
  const timeZone = String(payload?.schedule?.timeZone ?? 'UTC').trim().slice(0, 80);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
  } catch {
    throw new Error(`Reporting schedule time zone “${timeZone}” is not valid.`);
  }
  const schedule = {
    enabled: payload?.schedule?.enabled === true,
    cadence: ['daily', 'weekly'].includes(payload?.schedule?.cadence) ? payload.schedule.cadence : 'weekly',
    dayOfWeek: clampNumber(payload?.schedule?.dayOfWeek, 0, 6, 5),
    time: requestedTime,
    timeZone,
    recipients: String(payload?.schedule?.recipients ?? '').slice(0, 4000),
    message: String(payload?.schedule?.message ?? '').slice(0, 4000),
    reminderMinutes: clampNumber(payload?.schedule?.reminderMinutes, 0, 1440, 15),
    updatedAt: new Date().toISOString(),
  };
  const key = getScheduleKey(context, payload?.projectKey, payload?.boardId);
  await kvs.set(key, schedule);
  return schedule;
});


export const handler =
  resolver.getDefinitions();