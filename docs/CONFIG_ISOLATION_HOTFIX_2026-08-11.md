# StatusDeck UI v1 - Configuration Isolation Hotfix (2026-08-11)

UI v1 remains locked. This hotfix changes configuration behaviour only.

## Changes
- Configuration draft state moved into an isolated `ReportingSettingsModal` React component.
- Editing a select/input no longer rerenders the full report application.
- Estimation-source saves are transactional: report refresh succeeds before live settings are committed.
- Failed estimation refresh rolls persisted settings back to the previous profile.
- Sprint and Project/Program report loaders can rethrow failures to the configuration transaction.
- A React error boundary prevents a Jira white screen and surfaces the actual render exception with a Reload StatusDeck action.
- No manifest, Forge scope, licensing, KVS schema, export, Burndown, commentary, or dependency changes.

## Commands
From the app root:

    node scripts/regression-check.mjs
    cd static/hello-world
    npm ci
    npm run build
    cd ../..
    forge lint
    forge deploy -e development

If node_modules is already valid, omit `npm ci`.
