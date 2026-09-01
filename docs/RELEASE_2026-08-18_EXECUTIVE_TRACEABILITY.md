# StatusDeck Executive & Traceability Update — 18 Aug 2026

This release applies product feedback from the 18 Aug 2026 StatusDeck demo while preserving the stable v1 report flow and existing Custom Jira Insights, Confluence, PDF/PPT, scheduler, Assistant and section-movement behavior.

## Changes

- Executive Summary refreshed into a presentation-first leadership briefing with RAG, delivery status, reporting basis, concise takeaway and four headline KPIs.
- Estimation override now drives user-facing units consistently across the main Sprint report and Sprint PDF/PPT export (for example, Original Estimate is presented as hours/effort rather than points).
- Acceptance Criteria source can be configured as Auto detect, Jira Description, or an eligible Jira custom text field. Auto detection prefers likely Acceptance Criteria fields and falls back to Description.
- Acceptance Criteria coverage below the configured minimum now appears explicitly as a quality-readiness risk and recommended action.
- Added Traceability & quality evidence section using Jira-recorded parent/issue links, Acceptance Criteria, linked test-type work items, linked defects and Fix Version mapping. StatusDeck reports gaps and does not invent missing trace links.
- Present mode is read-only for report editing/reordering/configuration controls. Exported PowerPoint remains editable by design.
- Saved management commentary is fingerprinted to its report snapshot. If Jira data changes, stale saved commentary is warned in the UI and excluded from export until reviewed/republished, preventing old generated metrics from being presented as current facts.
- Existing Days Remaining browser `atob` fix is retained.

## Validation

- 348 deterministic StatusDeck regression checks passed.
- 393 deterministic Assistant scenarios passed.
- Backend and test-script syntax checks passed.
- The packaged source intentionally excludes `node_modules` and generated frontend `build`; run `npm ci` and `npm run build` in `static/hello-world` before Forge deployment.
