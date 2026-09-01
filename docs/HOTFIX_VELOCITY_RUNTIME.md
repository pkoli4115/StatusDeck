# StatusDeck Velocity Runtime Hotfix

Date: 2026-08-10

## Why this hotfix exists

Enterprise benchmark testing showed that the current sprint report and next-sprint outlook completed successfully, while historical velocity could exceed Forge's 25-second resolver execution limit. The main cause was serial reconstruction of multiple historical sprints plus an unbounded project-history candidate query for older sprints.

## Changes

1. Historical velocity remains a required StatusDeck feature.
2. Velocity history candidates for a closed sprint are now bounded to the sprint's own time window instead of scanning all project changes after the sprint started.
3. The configured recent closed sprints are processed concurrently rather than serially.
4. Sprint-start commitment reconstruction is still attempted for each velocity sprint.
5. If history reconstruction for a single historical sprint fails, that sprint transparently falls back to current-scope figures and includes `commitmentSource`/`historyWarning` metadata rather than failing the full velocity response.
6. Velocity retains the 30-minute small-result KVS cache.
7. Structured runtime logs added:
   - `velocity_cache_hit`
   - `velocity_sprint_calculated`
   - `velocity_history_fallback`
   - `velocity_generated`
8. Frontend report loading now uses tolerant supplementary loading. `getSprintReport` remains critical; velocity and next-sprint outlook no longer blank the entire report if a supplementary resolver temporarily fails.
9. A visible warning is shown only when a supplementary section is unavailable.
10. Project-level reporting also tolerates a velocity failure for an individual board while preserving that board's main sprint report.

## Important

This does NOT remove velocity. Normal successful behavior still includes full historical velocity, average completed velocity, and its use in Next Sprint Outlook/readiness.
