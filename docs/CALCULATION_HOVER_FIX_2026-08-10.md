# StatusDeck calculation hover reliability fix — 2026-08-10

Baseline: `StatusDeck_Baseline_Publish_Export_Dual_Burndown_2026-08-10.zip`.

## Fix
- Decorative `.metric-card::after` artwork no longer intercepts pointer events over calculation info controls.
- Calculation info trigger is a real button with pointer hover, mouse hover, keyboard focus, click fallback and Escape close.
- Native browser `title` text carries the same title/formula/note as a final hover fallback.
- Body-level portal tooltip remains in place to avoid clipping by report cards and scroll containers.

## Scope safety
Unchanged from baseline:
- `manifest.yml`
- `src/index.js`
- root package files
- frontend package files
- report layout/move menu
- commentary publish/export
- dual Burndown behavior
- PPT/PDF logic
- Forge scopes/licensing/storage

## Validation
- `node scripts/regression-check.mjs`: 81/81 PASS.
- Baseline comparison confirms only `App.js`, `App.css`, regression checks and documentation changed.
- `npm ci` could not complete in the sandbox because the internal npm mirror returned HTTP 404 for React; no dependency files were changed.
