# StatusDeck Layout Grid Refinement — 2026-08-10

This package applies the UX corrections agreed after Jira-side review.

## Changes

1. Report Sections control moved directly below Project / Report Type / Board / Sprint selectors.
2. Report Sections control is compact and collapsible; selected sections use small checkbox chips/cards.
3. Removed the redundant selected-project line containing "No JQL required".
4. Removed the standalone "Include subtasks in management totals" row and moved it into the compact Report Sections control as a report option.
5. Visible report sections now have a six-dot drag affordance and can be repositioned in the live report.
6. Drag/drop supports up/down/left/right placement intent. The report uses a responsive CSS Grid, so neighbouring sections reflow into available cells instead of overlapping.
7. The two-column report grid automatically collapses to one column on narrower screens.
8. Management Commentary is directly editable in place. The field always starts from the current saved/generated commentary rather than a blank editor.
9. Save Draft and Publish operate on the exact text currently visible in the inline commentary field.
10. Restore Generated clears the saved override and returns to deterministic generated commentary.

## Validation completed in the build container

- Backend JavaScript syntax: PASS (`node --check src/index.js`)
- React/JSX parse using TypeScript parser: PASS
- Manifest YAML parse: PASS
- Existing automated source regression: 26/26 PASS
- Compact top Report Sections control source check: PASS
- Redundant "No JQL required" text removal check: PASS
- Six-dot report drag handle source check: PASS
- 2D grid reorder logic source check: PASS
- Inline Management Commentary source check: PASS
- Save Draft visible-text wiring: PASS
- Publish visible-text wiring: PASS

## Build limitation in this environment

A fresh `npm ci --legacy-peer-deps` could not complete because the OpenAI container's internal npm proxy returns HTTP 404 for `yocto-queue@0.1.0`. This is an environment registry issue, not a StatusDeck package resolution result. The source should therefore still be built with the already-working local dependency installation on the developer machine before deployment.
