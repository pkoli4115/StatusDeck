import fs from 'node:fs';

const requiredRootFiles = [
  'manifest.yml',
  'package.json',
  'static/hello-world/src/App.js',
  'scripts/regression-check.mjs',
];

let failed = false;

for (const file of requiredRootFiles) {
  if (!fs.existsSync(file)) {
    console.error(`FAIL package root: missing ${file}`);
    failed = true;
  } else {
    console.log(`PASS package root: ${file}`);
  }
}

const appPath = 'static/hello-world/src/App.js';

function containsUiText(source, text) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Accept JSX/HTML whitespace/newlines around visible text.
  const rx = new RegExp(`>\\s*${escaped}\\s*<`, 'm');
  return rx.test(source) || source.includes(`'${text}'`) || source.includes(`"${text}"`);
}

if (fs.existsSync(appPath)) {
  const app = fs.readFileSync(appPath, 'utf8');

  const checks = [
    ['build marker', app.includes("v4.4.4-complete-label-titlecase-fix")],

    ['no malformed literal-newline helper block', !app.includes('\\n\\nconst STATUSDECK_UI_BUILD') && !app.includes("]);\\n\\nfunction titleCaseUiLabel")],
    [
      'At Risk dynamic formatting',
      app.includes("titleCaseUiLabel(deliveryStatus?.label") &&
      app.includes("titleCaseUiLabel(snapshot.statusLabel)")
    ],
    ['At a Glance', containsUiText(app, 'At a Glance')],
    ['Reporting Scheduler', containsUiText(app, 'Reporting Scheduler')],
    ['Story Points', containsUiText(app, 'Story Points')],
    ['Remaining Effort', containsUiText(app, 'Remaining Effort')],
    ['Live Events', containsUiText(app, 'Live Events')],
    ['Full Table', containsUiText(app, 'Full Table')],
    ['Executive Note', app.includes('summaryTitle="Executive Note"')],
    ['Progress value uses % Complete', app.includes("value: `${formatNumber(report?.metrics?.storyPointCompletionPercentage ?? 0)}% Complete`,")],
    ['Progress ring label uses Complete', app.includes("label={report.sprint.state === 'future' ? 'Planning Ready' : 'Complete'}")],
    ['Sprint pulse label uses Complete', app.includes("<span>{isFuture ? 'Planning Ready' : 'Complete'}</span>")],
    ['no literal At risk status', !app.includes("'At risk'") && !app.includes('"At risk"')],
  ];

  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'} Title Case: ${name}`);
    if (!ok) failed = true;
  }

  console.log('\nVerified source examples:');
  for (const label of [
    'At a Glance',
    'Reporting Scheduler',
    'Story Points',
    'Remaining Effort',
    'Live Events',
    'Full Table',
  ]) {
    console.log(`  ${containsUiText(app, label) ? '✓' : '✗'} ${label}`);
  }
}

if (failed) process.exit(1);
console.log('\nPACKAGE + TITLE CASE VERIFICATION PASSED');
