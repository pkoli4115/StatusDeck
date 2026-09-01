# StatusDeck UI v1 — Locked Feature Completion (2026-08-11)

Baseline: `StatusDeck_UI_v1_Config_React16_Event_Fix_2026-08-11.zip`

## Implemented in this package

### 1. Overall RAG at the top
- Executive Pulse now shows an explicit `Overall RAG` badge: GREEN / AMBER / RED.
- RAG is driven by the StatusDeck reporting configuration: completion thresholds, unresolved-defect thresholds, overdue thresholds, and provisional estimate confidence.
- The approved v1 report layout remains intact.

### 2. Reporting Scheduler → calendar reminder
- Fixed exact-minute persistence. The previous backend regular expression incorrectly treated `\\d` as a literal sequence, which caused values such as `15:15` to fall back to `15:00`.
- Time is now validated as `HH:mm` and preserved exactly.
- Time zone is validated as an IANA time zone (for example `Asia/Kolkata`).
- Calendar reminder lead time is stored with the schedule.
- User options:
  - Add to Google Calendar
  - Open the next event in Outlook
  - Download a recurring `.ics` invite (daily/weekly recurrence + alarm)
- No Forge scheduled trigger or five-minute background polling was added.

### 3. StatusDeck Assistant
- Removed the Assistant from the report toolbar.
- Added a collapsible floating Assistant at the bottom-right of the page.
- Works without a generated report.
- Can resolve a named Jira project, inspect its Scrum boards, find a named sprint, and query Jira for the sprint snapshot.
- Searches other Scrum boards when a named sprint is not on the initially selected board.
- Supports lightweight conversational session context and follow-up actions.
- Submitted questions are immediately cleared from the input and moved into chat history.
- Supports sprint detail/status, RAG/risk, overdue work, unresolved defects, scope history, estimates, workload, remaining work, return-to-green, velocity, and two-sprint comparison intents.
- Uses Jira/Forge data and deterministic local intent logic. No external AI/LLM API was added.
- Assistant sprint lookup is a dedicated resolver and does not consume StatusDeck's formal report-generation quota.

## Scope and permission impact
- `manifest.yml` is unchanged.
- No new Forge scopes were added.
- No external AI service, calendar OAuth, or scheduler service was added.
- Backend changes are limited to calendar schedule validation/persistence and the Jira-backed Assistant sprint snapshot resolver.

## Validation performed
- `node scripts/regression-check.mjs` — PASS
- `node --check src/index.js` — PASS
- `node --check scripts/regression-check.mjs` — PASS
- Frontend JSX/JavaScript syntax via TypeScript parser — PASS
- CSS brace regression — PASS
- `npm ci` was attempted in the build environment but timed out before dependencies were installed, so a production `react-scripts build` is not claimed here.
