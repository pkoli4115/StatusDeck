import { normalizeAssistantInput } from '../static/hello-world/src/assistant/normalize.mjs';
import { classifySmallTalk, buildSmallTalkResponse } from '../static/hello-world/src/assistant/smallTalk.mjs';
import { resolveConversationalReferences, getAssistantTemporalRequest } from '../static/hello-world/src/assistant/contextResolver.mjs';
import { buildAssistantProjectCatalogue, resolveAssistantProject } from '../static/hello-world/src/assistant/entityResolver.mjs';
import { resolveAssistantIntent, getAssistantAnalysisPlan } from '../static/hello-world/src/assistant/intentResolver.mjs';
import { buildAssistantAnswer, buildCarryOverAnswer, buildUnsupportedAgileAnswer } from '../static/hello-world/src/assistant/responseBuilder.mjs';
import { detectAgileConcept, getAgileKnowledgeSummary } from '../static/hello-world/src/assistant/agileKnowledge.mjs';
import { assistantFollowUps } from '../static/hello-world/src/assistant/actions.mjs';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); }
  else { failed += 1; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const projects = [
  { id: '1001', key: 'SD01', name: 'Retail Banking Benchmark 01' },
  { id: '1002', key: 'SD02', name: 'Insurance Platform Benchmark 02' },
  { id: '1003', key: 'SD03', name: 'Customer Experience Benchmark 03' },
];
const catalogue = buildAssistantProjectCatalogue(projects);
const context = { projectKey: 'SD01', projectName: projects[0].name, boardId: '41', boardName: 'SD01 Team 4 Board', sprintId: '6006', sprintName: 'SD01 Team 4 Sprint 6' };

const normalizationCases = [
  ['thnx', 'thanks'], ['THX!', 'thanks'], ['tnx', 'thanks'], ['thanx', 'thanks'], ['thks', 'thanks'], ['tks', 'thanks'], ['ty', 'thanks'],
  ['pls show risks', 'please show risks'], ['plz show risks', 'please show risks'],
  ['u show me', 'you show me'], ['ur project', 'your project'], ['abt insurance', 'about insurance'],
  ['prev sprint', 'previous sprint'], ['  Hello  ', 'hello'], ['"Insurance"', 'insurance'],
  ['GOOD!!!', 'good'], ['Can u generate report?', 'can you generate report'], ['bcoz red', 'because red'],
  ['w/ insurance', 'with insurance'], ['w/o report', 'without report'], ['  sprint   5  ', 'sprint 5'],
  ['thank you.', 'thank you'], ['got it!', 'got it'],
];
for (const [input, expected] of normalizationCases) check(`normalize: ${input}`, normalizeAssistantInput(input).normalized === expected, normalizeAssistantInput(input).normalized);

const smallTalkCases = [
  'thanks', 'thnx', 'thx', 'tnx', 'thanx', 'thks', 'ty', 'good', 'great', 'nice', 'perfect', 'cool', 'awesome', 'excellent',
  'ok', 'okay', 'got it', 'understood', 'fine', 'super', 'makes sense', 'hi', 'hello', 'hey',
  'good morning', 'good afternoon', 'good evening', 'bye', 'goodbye', 'see you', 'no', 'wrong', 'not this',
];
for (const input of smallTalkCases) {
  const normalized = normalizeAssistantInput(input).normalized;
  const classification = classifySmallTalk(normalized);
  check(`small-talk intercept: ${input}`, Boolean(classification));
  if (classification) check(`small-talk response: ${input}`, Boolean(buildSmallTalkResponse(classification)?.text));
}
['show risks', 'good sprint?', 'thanks show risks', 'insurance', 'sprint 5', 'generate report'].forEach((input) => check(`not small-talk: ${input}`, !classifySmallTalk(normalizeAssistantInput(input).normalized)));

const contextCases = [
  ['generate report for this', 'context'], ['generate report of it', 'context'], ['show risks for that sprint', 'context'],
  ['what about this sprint', 'context'], ['same sprint', 'context'], ['previous sprint', 'previous'],
  ['last sprint', 'previous'], ['the one before that', 'previous'], ['next sprint', 'next'], ['current sprint', 'active'],
  ['active sprint', 'active'], ['compare it with previous sprint', 'previous'], ['publish this', 'context'],
];
for (const [input, expected] of contextCases) {
  const r = resolveConversationalReferences(normalizeAssistantInput(input).normalized, context);
  check(`context sprint: ${input}`, r.sprintReference === expected || r.relativeSprint === expected, JSON.stringify(r));
}
['who owns those?', 'show those issues', 'what about these items', 'open them'].forEach((input) => {
  const r = resolveConversationalReferences(normalizeAssistantInput(input).normalized, { ...context, lastIssueKeys: ['SD01-1'] });
  check(`issue-set anaphora: ${input}`, r.referencesIssueSet);
});

const entityCases = [
  ['insurance', 'SD02'], ['give me summary of insurance', 'SD02'], ['how is insurance doing', 'SD02'],
  ['insurance project', 'SD02'], ['about insurance project', 'SD02'], ['SD02', 'SD02'],
  ['insurence', 'SD02'], ['retail banking', 'SD01'], ['summary of retail banking', 'SD01'],
  ['Retail Banking Benchmark 01', 'SD01'], ['SD01', 'SD01'], ['customer experience', 'SD03'],
  ['customer experiance', 'SD03'], ['summary of customer experience', 'SD03'], ['SD03', 'SD03'],
];
for (const [input, expectedKey] of entityCases) {
  const normalized = normalizeAssistantInput(input).normalized;
  const references = resolveConversationalReferences(normalized, context);
  const result = resolveAssistantProject({ question: normalized, catalogue, fallbackKey: context.projectKey, references });
  check(`project resolve: ${input}`, result.project?.key === expectedKey, result.project?.key ?? result.phrase);
}
const contextualQueries = ['why is this red', 'show remaining work', 'generate report for this', 'compare it with previous sprint'];
for (const input of contextualQueries) {
  const normalized = normalizeAssistantInput(input).normalized;
  const references = resolveConversationalReferences(normalized, context);
  const result = resolveAssistantProject({ question: normalized, catalogue, fallbackKey: context.projectKey, references });
  check(`context project fallback: ${input}`, result.project?.key === 'SD01' && result.explicit === false, JSON.stringify(result));
}
const noMatch = resolveAssistantProject({ question: 'summary of abc bank', catalogue, fallbackKey: 'SD01', references: resolveConversationalReferences('summary of abc bank', context) });
check('explicit unknown project never falls back', noMatch.project === null && noMatch.explicit === true);

const ambiguousCatalogue = buildAssistantProjectCatalogue([
  { id: '2001', key: 'INSA', name: 'Insurance Platform Alpha' },
  { id: '2002', key: 'INSB', name: 'Insurance Platform Beta' },
]);
const ambiguous = resolveAssistantProject({ question: 'insurance platform', catalogue: ambiguousCatalogue, fallbackKey: '', references: {} });
check('ambiguous project asks instead of guesses', ambiguous.project === null && ambiguous.candidates.length === 2);

const intentCases = [
  ['generate sprint report for this', 'GENERATE_REPORT'], ['create executive report', 'GENERATE_REPORT'],
  ['publish this to confluence', 'PUBLISH'], ['publish this', 'PUBLISH'], ['load sprint 5', 'LOAD_SPRINT'],
  ['take me to sprint 5', 'LOAD_SPRINT'], ['compare sprint 5 and sprint 6', 'COMPARE'], ['compare it with insurance', 'COMPARE'],
  ['why is this red', 'RAG_EXPLANATION'], ['why amber', 'RAG_EXPLANATION'], ['delivery health', 'RAG_EXPLANATION'],
  ['what are the risks', 'RISKS'], ['anything critical', 'RISKS'], ['show blockers', 'BLOCKERS'],
  ['show overdue items', 'OVERDUE'], ['what is late', 'OVERDUE'], ['show bugs', 'DEFECTS'], ['unresolved defects', 'DEFECTS'],
  ['who has the most work', 'WORKLOAD'], ['show workload', 'WORKLOAD'], ['who owns these', 'WORKLOAD'],
  ['show scope changes', 'SCOPE_CHANGES'], ['did scope increase', 'SCOPE_CHANGES'], ['show scope creep', 'SCOPE_CHANGES'],
  ['are estimates reliable', 'ESTIMATES'], ['show forecast variance', 'ESTIMATES'], ['remaining estimate', 'ESTIMATES'],
  ['show velocity', 'VELOCITY'], ['how are we trending', 'VELOCITY'], ['last 5 sprints trend', 'VELOCITY'],
  ['show those', 'REFERENCED_ITEMS'], ['open them', 'REFERENCED_ITEMS'], ['show remaining work', 'REMAINING_WORK'], ['what is unfinished', 'REMAINING_WORK'], ['open items', 'REMAINING_WORK'],
  ['give me a sprint summary', 'SPRINT_SUMMARY'], ['summary of insurance', 'SPRINT_SUMMARY'], ['how is insurance doing', 'SPRINT_SUMMARY'],
  ['what happened in sprint 5', 'SPRINT_SUMMARY'], ['help', 'HELP'], ['what can you do', 'HELP'],
];
for (const [input, expected] of intentCases) check(`intent: ${input}`, resolveAssistantIntent(normalizeAssistantInput(input).normalized).type === expected, resolveAssistantIntent(normalizeAssistantInput(input).normalized).type);
['banana', 'maybe', 'hmm', 'whatever'].forEach((input) => check(`unknown intent: ${input}`, resolveAssistantIntent(input).type === 'UNKNOWN'));

for (const mode of ['instant', 'medium', 'high']) {
  const summaryPlan = getAssistantAnalysisPlan(mode, 'SPRINT_SUMMARY');
  check(`${mode} summary is targeted`, summaryPlan.maxHistoricalSprints === 1 && summaryPlan.fetchVelocity === false);
  const velocityPlan = getAssistantAnalysisPlan(mode, 'VELOCITY');
  check(`${mode} velocity fetch only when requested`, velocityPlan.fetchVelocity === true);
}
check('Instant is bounded to 100 sprint metadata', getAssistantAnalysisPlan('instant', 'SPRINT_SUMMARY').maxSprintMetadata === 100);
check('Medium is bounded to 200 sprint metadata', getAssistantAnalysisPlan('medium', 'SPRINT_SUMMARY').maxSprintMetadata === 200);
check('High is bounded to 350 sprint metadata', getAssistantAnalysisPlan('high', 'SPRINT_SUMMARY').maxSprintMetadata === 350);
check('High history window stays bounded', getAssistantAnalysisPlan('high', 'VELOCITY').maxHistoricalSprints === 6);
check('Unknown mode falls back to Instant', getAssistantAnalysisPlan('anything', 'SPRINT_SUMMARY').mode === 'instant');

const fakeReport = {
  sprint: { id: 6, name: 'Sprint 6', goal: 'Deliver safely' },
  estimationSource: { type: 'storyPoints', name: 'Story Points' },
  metrics: {
    storyPointCompletionPercentage: 82, completionPercentage: 79, completedStoryPoints: 585, committedStoryPoints: 716,
    remainingStoryPoints: 131, total: 100, completed: 79, open: 21, overdue: 1, defects: 2,
    statusCounts: { Done: 79, 'In Progress': 14, 'To Do': 7 },
    typeCounts: { Story: 86, Bug: 8, Task: 6 },
    workload: [
      { name: 'Alice', open: 12, remainingStoryPoints: 80 },
      { name: 'Bob', open: 9, remainingStoryPoints: 51 },
    ],
    reportingIssues: [
      { key: 'SD01-1', summary: 'Open item', status: 'Blocked', statusCategoryKey: 'indeterminate', isOverdue: true, daysOverdue: 2, assignee: 'Alice', storyPoints: 8, issueType: 'Story', priority: 'High', created: '2026-07-01T00:00:00.000Z' },
      { key: 'SD01-2', summary: 'Bug item', status: 'In Progress', statusCategoryKey: 'indeterminate', isOverdue: false, assignee: 'Bob', storyPoints: 0, issueType: 'Bug', priority: 'Highest', created: '2026-08-01T00:00:00.000Z' },
    ],
    effort: { forecastProvisional: true, originalEstimateHours: 716, timeSpentHours: 585, remainingEstimateHours: 131, forecastHours: 716, coverage: { remainingEstimateCoveragePercentage: 50 } },
  },
  history: {
    available: true,
    originalCommitment: { storyPoints: 700 },
    currentScope: { storyPoints: 716 },
    scopeChange: { addedStoryPoints: 20, removedStoryPoints: 4, addedItems: 3, removedItems: 1, addedIssueKeys: ['SD01-9'], removedIssueKeys: ['SD01-10'] },
    burndownDaily: [
      { scopePoints: 700, remainingPoints: 700, completedPoints: 0, idealRemainingPoints: 700 },
      { scopePoints: 716, remainingPoints: 131, completedPoints: 585, idealRemainingPoints: 90 },
    ],
    burndownLive: [{}, {}, {}, {}],
  },
};
const fakeData = { report: fakeReport, readiness: { score: 72, openDefects: 1 }, returnToGreen: [{ priority: 'High', text: 'Close overdue work.' }], rag: { label: 'AMBER' }, mode: 'instant', velocityReport: { averageCompleted: 550 }, boardConfiguration: { estimation: { name: 'Story Points' } } };
for (const intent of ['SPRINT_SUMMARY', 'RISKS', 'COMPLETION', 'COMMITMENT_DELIVERY', 'BURNDOWN', 'THROUGHPUT', 'STATUS_DISTRIBUTION', 'ISSUE_TYPES', 'PRIORITY_DISTRIBUTION', 'UNESTIMATED_WORK', 'AGING_WORK', 'SPRINT_GOAL', 'BLOCKERS', 'CAPACITY', 'PREDICTABILITY', 'OVERDUE', 'DEFECTS', 'WORKLOAD', 'REMAINING_WORK', 'SCOPE_CHANGES', 'ESTIMATES', 'VELOCITY', 'RETURN_TO_GREEN', 'RAG_EXPLANATION']) {
  const answer = buildAssistantAnswer(intent, fakeData);
  check(`response builder: ${intent}`, Boolean(answer.text) && Array.isArray(answer.issueKeys));
}

const velocityVisualData = { ...fakeData, velocityReport: { averageCompleted: 550, usesStoryPoints: true, velocity: [
  { sprintId: 1, sprintName: 'Sprint 1', committedStoryPoints: 500, completedStoryPoints: 480 },
  { sprintId: 2, sprintName: 'Sprint 2', committedStoryPoints: 560, completedStoryPoints: 550 },
] } };
const velocityAnswer = buildAssistantAnswer('VELOCITY', velocityVisualData);
check('Velocity answer hides analysis mode', !velocityAnswer.text.includes('Analysis mode'));
check('Velocity answer hides generic productivity disclaimer', !velocityAnswer.text.includes('individual productivity'));
check('Velocity answer carries compact chart data', velocityAnswer.visual?.type === 'velocity' && velocityAnswer.visual.rows.length === 2 && velocityAnswer.visual.averageCompleted === 550);

const combinedCases = [
  ['thnx', 'SMALL'], ['Can u generate sprint report of this', 'GENERATE_REPORT'], ['why is it red', 'RAG_EXPLANATION'],
  ['summary of insurance', 'SD02'], ['compare it with previous sprint', 'COMPARE'], ['pls show overdue items', 'OVERDUE'],
  ['give me retail banking overview', 'SD01'], ['what about customer experience', 'SD03'], ['publish this', 'PUBLISH'],
];
for (const [input, expected] of combinedCases) {
  const normalized = normalizeAssistantInput(input).normalized;
  const small = classifySmallTalk(normalized);
  if (expected === 'SMALL') { check(`combined pipeline: ${input}`, Boolean(small)); continue; }
  const intent = resolveAssistantIntent(normalized).type;
  if (/^SD\d+/.test(expected)) {
    const refs = resolveConversationalReferences(normalized, context);
    const result = resolveAssistantProject({ question: normalized, catalogue, fallbackKey: context.projectKey, references: refs });
    check(`combined project: ${input}`, result.project?.key === expected, result.project?.key ?? 'none');
  } else check(`combined intent: ${input}`, intent === expected, intent);
}


// Production-language coverage: paraphrases, typos, temporal language and adaptive follow-ups.
const conversationalNormalizations = [
  ['nxt sprint', 'next sprint'], ['futre sprints', 'future sprints'], ['upcomming sprint', 'upcoming sprint'],
  ['summry next sprint', 'summary next sprint'], ["what's next", 'what is next'], ['whts next', 'what is next'],
  ['pls show futre sprints', 'please show future sprints'], ['can u show upcomming', 'can you show upcoming'],
];
for (const [input, expected] of conversationalNormalizations) check(`production normalize: ${input}`, normalizeAssistantInput(input).normalized === expected, normalizeAssistantInput(input).normalized);

const futureIntentCases = [
  'show future sprints', 'give future sprints', 'can u give future sprints', 'what sprints are coming', 'upcoming sprints',
  'next few sprints', 'next 3 sprints', 'what comes after this', 'what is planned after this', 'future pls',
  'futre sprints', 'upcomming sprints', 'give upcoming ones', "what's next", 'next pls',
];
for (const input of futureIntentCases) {
  const normalized = normalizeAssistantInput(input).normalized;
  check(`future intent: ${input}`, resolveAssistantIntent(normalized).type === 'LIST_FUTURE_SPRINTS', `${normalized} -> ${resolveAssistantIntent(normalized).type}`);
}

const nextSummaryCases = [
  'next sprint summary please', 'summary of next sprint', 'how does next sprint look', 'tell me about the upcoming sprint',
  'what is planned next sprint', 'summry next sprint', 'previous sprint summary', 'summary of current sprint',
];
for (const input of nextSummaryCases) {
  const normalized = normalizeAssistantInput(input).normalized;
  check(`relative summary intent: ${input}`, resolveAssistantIntent(normalized).type === 'SPRINT_SUMMARY', `${normalized} -> ${resolveAssistantIntent(normalized).type}`);
}

const temporalCases = [
  ['future sprints', 'future-list'], ['next 3 sprints', 'future-list'], ['what comes after this', 'future-list'],
  ['next sprint summary please', 'next'], ['upcoming sprint status', 'next'], ['previous sprint summary', 'previous'],
  ['current sprint status', 'active'],
];
for (const [input, expected] of temporalCases) {
  const normalized = normalizeAssistantInput(input).normalized;
  const temporal = getAssistantTemporalRequest(normalized);
  check(`temporal resolution: ${input}`, temporal.type === expected, JSON.stringify(temporal));
}
check('future request count is bounded', getAssistantTemporalRequest('next 99 sprints').count === 10);
check('next 3 sprint count resolved', getAssistantTemporalRequest('next 3 sprints').count === 3);

const ordinalCases = [['first one', 0], ['second one', 1], ['third sprint', 2], ['4th one', 3], ['5th sprint', 4]];
for (const [input, expected] of ordinalCases) {
  const refs = resolveConversationalReferences(input, { ...context, lastSprintChoices: [{}, {}, {}, {}, {}] });
  check(`ordinal choice: ${input}`, refs.listChoiceIndex === expected, JSON.stringify(refs));
  check(`ordinal intent: ${input}`, resolveAssistantIntent(input).type === 'SELECT_SPRINT');
}

const actionFollowUps = assistantFollowUps('SPRINT_SUMMARY', { futureCount: 2, futureSprints: [{ name: 'Sprint 7' }, { name: 'Sprint 8' }], currentSprintName: 'Sprint 6' });
check('Sprint summary offers future sprints when available', actionFollowUps.includes('Show future sprints'));
const noFutureFollowUps = assistantFollowUps('SPRINT_SUMMARY', { futureCount: 0, futureSprints: [], currentSprintName: 'Sprint 6' });
check('Sprint summary hides future follow-up when unavailable', !noFutureFollowUps.includes('Show future sprints'));
const futureFollowUps = assistantFollowUps('LIST_FUTURE_SPRINTS', { futureCount: 2, futureSprints: [{ name: 'Sprint 7' }, { name: 'Sprint 8' }], currentSprintName: 'Sprint 6' });
['Summarize Sprint 7', 'Load Sprint 7', 'Generate report for Sprint 7', 'Compare Sprint 7 with Sprint 6'].forEach((label) => check(`future follow-up: ${label}`, futureFollowUps.includes(label)));

const messyIntentCases = [
  ['can u prepare report for this', 'GENERATE_REPORT'], ['give me the report', 'GENERATE_REPORT'], ['put this on confluence', 'PUBLISH'],
  ['switch to sprint 7', 'LOAD_SPRINT'], ['what remains', 'REMAINING_WORK'], ['how can we reach green', 'RETURN_TO_GREEN'],
  ['tell me about this sprint', 'SPRINT_SUMMARY'], ['how does upcoming sprint look', 'SPRINT_SUMMARY'],
];
for (const [input, expected] of messyIntentCases) {
  const normalized = normalizeAssistantInput(input).normalized;
  check(`messy intent: ${input}`, resolveAssistantIntent(normalized).type === expected, `${normalized} -> ${resolveAssistantIntent(normalized).type}`);
}

const noJiraSmallTalk = ['thnx', 'ty', 'ok', 'great', 'nice', 'hello', 'good morning'];
for (const input of noJiraSmallTalk) {
  const normalized = normalizeAssistantInput(input).normalized;
  check(`small talk remains terminal: ${input}`, Boolean(classifySmallTalk(normalized)) && resolveAssistantIntent(normalized).type === 'UNKNOWN');
}

const modeFuturePlan = getAssistantAnalysisPlan('high', 'LIST_FUTURE_SPRINTS');
check('Future sprint listing is metadata-only', modeFuturePlan.metadataOnly === true && modeFuturePlan.fetchSnapshot === false && modeFuturePlan.fetchVelocity === false);
check('High future listing remains bounded', modeFuturePlan.maxSprintMetadata === 350);



// Agile/Jira delivery-domain knowledge layer: natural terminology maps to a
// supported StatusDeck intent before generic fallbacks are considered.
const agileIntentCases = [
  ['show me the burndown', 'BURNDOWN'], ['i need burn down', 'BURNDOWN'], ['how are we burning down', 'BURNDOWN'],
  ['remaining trend for this sprint', 'BURNDOWN'], ['commitment vs delivery', 'COMMITMENT_DELIVERY'],
  ['what did we commit vs complete', 'COMMITMENT_DELIVERY'], ['completion rate', 'COMPLETION'],
  ['how much is done', 'COMPLETION'], ['what is our throughput', 'THROUGHPUT'], ['how many work items completed', 'THROUGHPUT'],
  ['show status distribution', 'STATUS_DISTRIBUTION'], ['show wip', 'STATUS_DISTRIBUTION'],
  ['issues by status', 'STATUS_DISTRIBUTION'], ['show work item types', 'ISSUE_TYPES'], ['stories vs bugs', 'ISSUE_TYPES'],
  ['priority distribution', 'PRIORITY_DISTRIBUTION'], ['show high priority items', 'PRIORITY_DISTRIBUTION'],
  ['scope creep', 'SCOPE_CHANGES'], ['what was added after sprint start', 'SCOPE_CHANGES'],
  ['show carry over', 'CARRY_OVER'], ['what is the spillover', 'CARRY_OVER'], ['work moved to next sprint', 'CARRY_OVER'],
  ['show missing estimates', 'UNESTIMATED_WORK'], ['unestimated work', 'UNESTIMATED_WORK'],
  ['estimate confidence', 'ESTIMATES'], ['remaining estimate coverage', 'ESTIMATES'], ['effort variance', 'ESTIMATES'],
  ['show team capacity', 'CAPACITY'], ['team bandwidth', 'CAPACITY'], ['show workload', 'WORKLOAD'],
  ['show blockers', 'BLOCKERS'], ['impediments in this sprint', 'BLOCKERS'], ['aging work', 'AGING_WORK'],
  ['oldest open items', 'AGING_WORK'], ['what is the sprint goal', 'SPRINT_GOAL'],
  ['how predictable are we', 'PREDICTABILITY'], ['will we meet the commitment', 'PREDICTABILITY'],
  ['show velocity', 'VELOCITY'], ['team pace', 'VELOCITY'], ['what are the delivery risks', 'RISKS'],
  ['why is this amber', 'RAG_EXPLANATION'], ['what work is overdue', 'OVERDUE'], ['unresolved bugs', 'DEFECTS'],
];
for (const [input, expected] of agileIntentCases) {
  const normalized = normalizeAssistantInput(input).normalized;
  const resolved = resolveAssistantIntent(normalized);
  check(`Agile intent: ${input}`, resolved.type === expected, `${normalized} -> ${resolved.type}`);
}


const agileSameTurnCases = [
  ['burndown of customer experience sprint', 'SD03', 'BURNDOWN'],
  ['show scope creep for insurance', 'SD02', 'SCOPE_CHANGES'],
  ['commitment vs delivery for retail banking', 'SD01', 'COMMITMENT_DELIVERY'],
  ['show estimate confidence for customer experience', 'SD03', 'ESTIMATES'],
  ['how predictable is insurance', 'SD02', 'PREDICTABILITY'],
];
for (const [input, projectKeyExpected, intentExpected] of agileSameTurnCases) {
  const normalized = normalizeAssistantInput(input).normalized;
  const refs = resolveConversationalReferences(normalized, context);
  const resolution = resolveAssistantProject({ question: normalized, catalogue, fallbackKey: context.projectKey, references: refs });
  const intent = resolveAssistantIntent(normalized);
  check(`Agile same-turn project: ${input}`, resolution.project?.key === projectKeyExpected, resolution.project?.key ?? 'none');
  check(`Agile same-turn intent: ${input}`, intent.type === intentExpected, intent.type);
}
const contextBurndown = 'i need burndown';
const contextBurndownRefs = resolveConversationalReferences(contextBurndown, context);
const contextBurndownProject = resolveAssistantProject({ question: contextBurndown, catalogue, fallbackKey: context.projectKey, references: contextBurndownRefs });
check('Agile intent can use current conversation project', contextBurndownProject.project?.key === 'SD01' && resolveAssistantIntent(contextBurndown).type === 'BURNDOWN');

const unsupportedAgileCases = [
  ['cycle time', 'CYCLE_TIME'], ['lead time', 'LEAD_TIME'], ['backlog health', 'BACKLOG_HEALTH'],
  ['show burnup', 'BURNUP'], ['definition of done', 'DEFINITION_OF_DONE'], ['defect leakage', 'DEFECT_LEAKAGE'],
  ['release forecast', 'RELEASE_FORECAST'],
];
for (const [input, concept] of unsupportedAgileCases) {
  const normalized = normalizeAssistantInput(input).normalized;
  const resolved = resolveAssistantIntent(normalized);
  check(`Unsupported concept recognized: ${input}`, resolved.type === 'UNSUPPORTED_KPI' && resolved.concept === concept, JSON.stringify(resolved));
  const answer = buildUnsupportedAgileAnswer(resolved.concept);
  check(`Unsupported concept is honest: ${input}`, /will not invent|does not currently|not reliably|does not yet/i.test(answer.text), answer.text);
  const plan = getAssistantAnalysisPlan('high', resolved.type);
  check(`Unsupported concept makes no snapshot call: ${input}`, plan.fetchSnapshot === false && plan.metadataOnly === true);
}

const knowledgeSummary = getAgileKnowledgeSummary();
check('Agile knowledge layer has broad vocabulary', knowledgeSummary.length >= 25, String(knowledgeSummary.length));
check('Burndown concept is supported', detectAgileConcept('show burndown')?.intent === 'BURNDOWN');
check('Cycle time is recognized but unsupported', detectAgileConcept('cycle time')?.support === 'unsupported');

const burndownAnswer = buildAssistantAnswer('BURNDOWN', fakeData);
check('Burndown answer uses existing sprint history', /Sprint burndown/.test(burndownAnswer.text) && /Ideal remaining now/.test(burndownAnswer.text));
const commitmentAnswer = buildAssistantAnswer('COMMITMENT_DELIVERY', fakeData);
check('Commitment answer shows sprint-start commitment', /Sprint-start commitment/.test(commitmentAnswer.text) && /Scope added/.test(commitmentAnswer.text));
const predictabilityAnswer = buildAssistantAnswer('PREDICTABILITY', fakeData);
check('Predictability is labeled as deterministic signal', /predictability signal/i.test(predictabilityAnswer.text) && /not a statistical probability/i.test(predictabilityAnswer.text));
const capacityAnswer = buildAssistantAnswer('CAPACITY', fakeData);
check('Capacity does not invent utilisation', /will not invent a utilisation percentage/i.test(capacityAnswer.text));
const blockerAnswer = buildAssistantAnswer('BLOCKERS', fakeData);
check('Blockers use Jira status evidence', blockerAnswer.issueKeys.includes('SD01-1') && /Blocked/.test(blockerAnswer.text));
const unestimatedAnswer = buildAssistantAnswer('UNESTIMATED_WORK', fakeData);
check('Unestimated work identifies zero-estimate issue', unestimatedAnswer.issueKeys.includes('SD01-2'));

const carryOverAnswer = buildCarryOverAnswer({
  available: true,
  sprint: { name: 'Sprint 7' },
  carryOverItems: 2,
  carryOverPoints: 13,
  carryOverKeys: ['SD01-1', 'SD01-2'],
  plannedItems: 30,
  plannedPoints: 80,
  unestimatedItems: 1,
  estimationSource: { unit: 'points' },
});
check('Carry-over answer uses actual next-sprint overlap', /Carry-over items: 2/.test(carryOverAnswer.text) && carryOverAnswer.issueKeys.length === 2);
check('Carry-over is targeted not snapshot+outlook', getAssistantAnalysisPlan('instant', 'CARRY_OVER').fetchSnapshot === false && getAssistantAnalysisPlan('instant', 'CARRY_OVER').fetchNextSprintOutlook === true);
check('Predictability Instant avoids extra velocity call', getAssistantAnalysisPlan('instant', 'PREDICTABILITY').fetchVelocity === false);
check('Predictability Medium may fetch targeted velocity context', getAssistantAnalysisPlan('medium', 'PREDICTABILITY').fetchVelocity === true);
check('Predictability High history remains bounded', getAssistantAnalysisPlan('high', 'PREDICTABILITY').maxHistoricalSprints === 6);

const agileFollowUpCases = [
  ['BURNDOWN', 'Show scope changes'], ['COMMITMENT_DELIVERY', 'Show burndown'], ['PREDICTABILITY', 'Show estimate confidence'],
  ['STATUS_DISTRIBUTION', 'Show work item types'], ['UNESTIMATED_WORK', 'Show estimate confidence'], ['CARRY_OVER', 'Show future sprints'],
];
for (const [intent, label] of agileFollowUpCases) {
  check(`Agile follow-up ${intent}: ${label}`, assistantFollowUps(intent, { futureCount: 1, currentSprintName: 'Sprint 6' }).includes(label));
}

console.log(`\nAssistant scenarios: ${passed} passed, ${failed} failed.`);
if (failed) process.exit(1);
