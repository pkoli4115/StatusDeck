# StatusDeck v4.4.1 — Title Case Package Layout Fix

This release corrects the v4.4 distribution ZIP layout.

## Root cause
The v4.4 ZIP contained the updated application under a top-level `statusdeck_v44/` directory.
Copying that ZIP into an existing `statusdeck-next` folder could therefore leave the actual
application files unchanged.

## Fix
- All deployable project files now sit directly at the ZIP root.
- Dynamic delivery-status labels continue to use Title Case (`At Risk`, `On Track`, etc.).
- Remaining visible UI naming surfaces were normalized.
- Added `scripts/verify-titlecase-package.mjs` to verify both install layout and key Title Case surfaces.
- Added a non-visible console build marker: `v4.4.1-titlecase-package-fix`.

No Jira calculations, AC logic, traceability logic, Forge scopes, or report data logic were changed.
