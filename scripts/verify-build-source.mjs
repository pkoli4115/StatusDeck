import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const appPath = path.join(root, 'static', 'hello-world', 'src', 'App.js');
const manifestPath = path.join(root, 'manifest.yml');

let failed = false;

function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed = true;
}

check('manifest resolved cross-platform', fs.existsSync(manifestPath));
check('App.js resolved cross-platform', fs.existsSync(appPath));

if (fs.existsSync(appPath)) {
  const app = fs.readFileSync(appPath, 'utf8');
  check('v4.4.4 build marker present', app.includes('v4.4.4-complete-label-titlecase-fix'));
  check('no literal newline tokens before build marker', !app.includes('\\n\\nconst STATUSDECK_UI_BUILD'));
  check('titleCaseUiLabel is real JavaScript source', app.includes('function titleCaseUiLabel(value) {'));
  check('At Risk is dynamically formatted', app.includes('titleCaseUiLabel(deliveryStatus?.label'));
}

if (failed) process.exit(1);
console.log('\nBUILD SOURCE SANITY PASSED');
