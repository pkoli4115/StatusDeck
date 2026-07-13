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
}) {
  return `report-cache:${safeIdentifier(userId)}:${sprintId}:${includeSubtasks ? '1' : '0'}`;
}

function getVelocityCacheKey({
  userId,
  boardId,
  includeSubtasks,
}) {
  return `velocity-cache:${safeIdentifier(userId)}:${boardId}:${includeSubtasks ? '1' : '0'}`;
}

function getOutlookCacheKey({
  userId,
  boardId,
  currentSprintId,
  includeSubtasks,
}) {
  return `outlook-cache:${safeIdentifier(userId)}:${boardId}:${currentSprintId}:${includeSubtasks ? '1' : '0'}`;
}

async function getCachedValue(key) {
  const cached = await kvs.get(key);

  if (!cached?.expiresAt || Date.now() >= cached.expiresAt) {
    if (cached) {
      await kvs.delete(key);
    }

    return null;
  }

  return cached;
}

async function setCachedValue(key, value, ttlMilliseconds) {
  await kvs.set(key, {
    value,
    generatedAt: new Date().toISOString(),
    expiresAt: Date.now() + ttlMilliseconds,
  });
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
  if (!storyPointFieldId) {
    return false;
  }

  const fieldId = String(item?.fieldId ?? '');
  const fieldName = normalizeText(item?.field);

  return (
    fieldId === storyPointFieldId ||
    fieldName === 'story points' ||
    fieldName === 'story point estimate'
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

  const reportingFields = await discoverReportingFields();
  const storyPointFieldId = reportingFields.storyPoints?.id ?? null;
  const sprintFieldId = reportingFields.sprint?.id ?? null;

  const [nextSprintIssues, currentSprintIssues] = await Promise.all([
    getAllSprintIssues(
      Number(nextSprint.id),
      storyPointFieldId,
      sprintFieldId
    ),
    getAllSprintIssues(
      currentSprintId,
      storyPointFieldId,
      sprintFieldId
    ),
  ]);

  const nextMetrics = calculateSprintMetrics(
    nextSprintIssues,
    storyPointFieldId,
    includeSubtasks
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
    defects: nextMetrics.defects,
    overdueItems: nextMetrics.overdue,
    unassignedItems,
    unestimatedItems,
    assigneeCount,
    originalEstimateCoveragePercentage:
      nextMetrics.effort?.coverage?.originalEstimateCoveragePercentage ?? 0,
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
  sprintFieldId
) {
  const allIssues = [];
  let nextPageToken;

  const fields = [
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
    storyPointFieldId,
    sprintFieldId,
  ]
    .filter(Boolean)
    .join(',');

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

  const fields = [
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
    storyPointFieldId,
    sprintFieldId,
  ].filter(Boolean);

  const startDate = toDateOnly(sprintStart, timeZone);

  /*
   * This JQL is entirely internal.
   * Users never create or enter it.
   *
   * Moving an item into or out of a sprint updates the issue,
   * so the issue is included in this candidate set.
   */
  const jql =
    `project = "${projectKey}" ` +
    `AND updated >= "${startDate}" ` +
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

  const fieldIds = [
    sprintFieldId,
    storyPointFieldId,
    'status',
    'timeoriginalestimate',
    'timeestimate',
    'timespent',
  ].filter(Boolean);

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
  storyPointFieldId
) {
  const fields = issue.fields ?? {};

  const rawStoryPoints = storyPointFieldId
    ? fields[storyPointFieldId]
    : null;

  const storyPoints =
    typeof rawStoryPoints === 'number'
      ? rawStoryPoints
      : parseNumericValue(
          rawStoryPoints,
          rawStoryPoints
        );

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

  return {
    id: String(issue.id),
    key: issue.key,
    projectKey:
      fields.project?.key ?? null,
    summary: fields.summary ?? '',
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
  includeSubtasks = false
) {
  const preparedIssues = issues.map((issue) => {
    const prepared = prepareCurrentIssue(
      issue,
      storyPointFieldId
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
          parseNumericValue(
            item.from,
            item.fromString
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
          parseNumericValue(
            item.to,
            item.toString
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
        const includeSubtasks = Boolean(payload?.includeSubtasks);

        if (!Number.isInteger(sprintId) || sprintId <= 0) {
          throw new Error('A valid sprint ID is required.');
        }

        const cacheKey = getReportCacheKey({
          userId: getUserIdentity(context),
          sprintId,
          includeSubtasks,
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

    const reportingFields =
      await discoverReportingFields();

    const storyPointFieldId =
      reportingFields.storyPoints?.id ??
      null;

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

    const issues =
      await getAllSprintIssues(
        sprintId,
        storyPointFieldId,
        sprintFieldId
      );

    const metrics =
      calculateSprintMetrics(
        issues,
        storyPointFieldId,
        includeSubtasks
      );

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

    const velocityCacheKey = getVelocityCacheKey({
      userId: getUserIdentity(context),
      boardId,
      includeSubtasks,
    });

    const cachedVelocity = await getCachedValue(velocityCacheKey);

    if (cachedVelocity) {
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

    const reportingFields =
      await discoverReportingFields();

    const storyPointFieldId =
      reportingFields.storyPoints?.id ??
      null;

    const sprintFieldId =
      reportingFields.sprint?.id ??
      null;

    const closedSprints =
      await getClosedSprints(
        boardId,
        FEATURE_FLAGS.velocitySprintLimit
      );

    const velocity = [];

    for (const sprint of closedSprints) {
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

      /*
       * Jira Velocity defines commitment as the work present when the
       * sprint started, not the final scope visible after the sprint
       * closed. Reuse the same changelog-based reconstruction used by
       * the sprint report so scope additions, removals and estimate
       * changes do not overwrite the original commitment.
       */
      const history =
        await calculateSprintHistory({
          sprint,
          currentSprintIssues: issues,
          reportingFields,
          includeSubtasks,
        });

      const committedStoryPoints =
        history.available
          ? history.originalCommitment.storyPoints
          : metrics.committedStoryPoints;

      const completedStoryPoints =
        history.available
          ? history.currentScope.completedStoryPoints
          : metrics.completedStoryPoints;

      const totalItems =
        history.available
          ? history.originalCommitment.items
          : metrics.total;

      const completedItems =
        history.available
          ? history.currentScope.completedItems
          : metrics.completed;

      velocity.push({
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
          history.available
            ? 'sprint-start-history'
            : 'current-scope-fallback',
      });
    }

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

      usesStoryPoints:
        Boolean(storyPointFieldId),

      averageCompleted,
      velocity,
    };

    await setCachedValue(
      velocityCacheKey,
      velocityResult,
      30 * 60 * 1000
    );

    return {
      ...velocityResult,
      meta: {
        cacheHit: false,
        generatedAt: new Date().toISOString(),
      },
    };
  }
);


export const handler =
  resolver.getDefinitions();