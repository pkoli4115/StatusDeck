# StatusDeck v4.4.3 — Build + Windows Regression Fix

Fixes two packaging defects from v4.4.1/v4.4.2:

1. `App.js` contained literal `\n` text in the inserted Title Case helper block.
   React/Babel interpreted the leading backslash as invalid JavaScript and the
   production build failed before `build/index.html` could be created.

2. `scripts/regression-check.mjs` used `new URL(import.meta.url).pathname`.
   On Windows this produced a path like `D:\D:\...`. It now uses
   `fileURLToPath(import.meta.url)`.

No Jira calculations, Acceptance Criteria logic, traceability logic, report
metrics, Forge permissions, or export logic were intentionally changed.
