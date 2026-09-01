# StatusDeck UI v1 targeted completion — 11 Aug 2026

This package preserves the locked StatusDeck UI v1 and applies only the agreed targeted refinements.

## Changes

### StatusDeck Assistant
- Explicit project names/keys no longer fall back to the currently selected project.
- Phrases such as `summary of Retail Banking project` are resolved against Jira projects.
- Ambiguous project matches request clarification.
- Responses use headings, bullets, ranked workload and compact issue lists.
- Existing sprint context/follow-ups remain session-local and no external AI API is used.

### Executive Pulse
- Overall RAG is the first/left-most executive signal.
- Sprint progress and supporting metrics remain to its right.

### Reporting Scheduler
- Time zone is an IANA-zone dropdown.
- New unsaved schedules default to the browser's local time zone.
- Existing exact-minute persistence and Google/Outlook/.ics reminder flow are unchanged.

### Export / Publish
- Main toolbar now uses one `Export / Publish` action.
- Download destination supports PowerPoint and PDF via the existing generators.
- Publish to Confluence accepts an existing page URL or page ID.
- Confluence publish can append the latest StatusDeck report or replace the page.
- The existing clipboard `Copy for Confluence / SharePoint` fallback remains.

## Forge permission change

Direct Confluence publishing adds:
- `read:page:confluence`
- `write:page:confluence`

The manifest also declares Jira as required and Confluence as optional under Forge multiple-app compatibility.

## Validation

Run:

```cmd
node scripts\regression-check.mjs
```

Expected result for this package: `163 regression checks passed.`
