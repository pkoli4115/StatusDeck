# StatusDeck privacy and data flow

## Jira -> StatusDeck

When a user loads a report or asks a supported Assistant question, StatusDeck reads only Jira data needed for that operation, such as projects, boards, sprints, issues, estimation fields, status, assignee, due dates, time tracking, history and versions/epics where applicable.

Acceptance Criteria analysis reads Description for Story issues only within the selected sprint being reported (future, active or completed). The bounded next-sprint outlook reads Description only for that next sprint. StatusDeck derives deterministic Story-level coverage plus individual criterion counts and explicit checkbox/task completion states.

## Browser / Custom UI

Report presentation, PDF/PPTX generation, charts, commentary editing, calendar invitation generation and the deterministic Assistant UI run in the StatusDeck Custom UI. Browser/session memory is used for bounded context/catalogue caching to reduce repeated Jira lookups.

## Forge backend / KVS

Forge resolvers retrieve Jira data under the current user's permissions. Forge KVS stores small application state and bounded caches as described in `DATA_RETENTION.md`.

## Confluence

Publishing occurs only after a user explicitly chooses Publish to Confluence and selects a Space/Parent page. StatusDeck creates or updates the Sprint child page and uploads the generated PDF/PPTX attachments. Confluence is optional in app compatibility.

## External AI / external database

The current StatusDeck Assistant does not call an external LLM/API, and the manifest does not declare external egress domains. StatusDeck does not use a separate QTI Labs/Firebase database for Jira report data in this package.
