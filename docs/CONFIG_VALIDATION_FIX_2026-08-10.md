# StatusDeck UI v1 — Configuration Validation Fix

UI baseline: 2026-08-10 Calculation Hover Fix (locked as StatusDeck UI v1).

Behavioral changes only:

- Configuration modal edits a draft copy. Changing Estimation override no longer mutates the live report while the dropdown is being edited.
- Estimation override is applied to Sprint Report, Velocity, Next Sprint Outlook and Project/Program report generation.
- Supported estimation modes: Jira board setting, Issue count, Original Estimate (hours), and Jira numeric fields.
- Report/velocity/outlook cache keys are partitioned by estimation override.
- Invalid or deleted custom numeric fields return a visible error instead of blanking the report.
- Existing report stays visible if a refresh fails.
- Green/Amber completion thresholds control visible progress tone in Executive Pulse and Sprint Health.
- Amber/Red unresolved-defect and overdue thresholds control Delivery Risk tone using unresolved defects only.
- Minimum Remaining Estimate coverage controls provisional forecast state.
- Maximum next-sprint velocity load is now used by planning readiness instead of a hard-coded 120% threshold.
- Configuration relationships are validated before save (Amber <= Green; Amber defect/overdue <= Red).
- Estimation labels adapt for items, hours and story points in the core UI narrative.

No changes to Forge manifest, scopes, licensing, package dependencies, report section layout, move-menu UI, commentary UI, calculation tooltip UI, or Burndown UI baseline.
