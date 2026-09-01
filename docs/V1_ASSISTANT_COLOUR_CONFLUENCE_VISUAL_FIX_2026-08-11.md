# StatusDeck UI v1 — Assistant Colour + Confluence Visual/Link Fix

Locked UI v1 patch only.

Changes:
- StatusDeck Assistant renders Overall RAG as a coloured callout and applies semantic colour cues to headings/list markers.
- Simple acknowledgements such as "good", "thanks", "ok", "great" are answered locally and do not trigger Jira data lookups or repeat the previous project summary.
- Confluence native report adds coloured status macros/panels for Executive Pulse, Management Commentary, Return to Green and report files.
- Executive Pulse Confluence KPI table uses shorter headers and wider table metadata to reduce wrapping.
- Confluence View Page now uses a canonical `/wiki/spaces/{spaceKey}/pages/{pageId}/{title}` route based on the actual child page metadata; previously stored non-/wiki webui links are canonicalized when opened.
- Existing full native report content, PDF/PPT attachments, child-page creation/update, last-published tracking, UI layout, scheduler, configuration, exports and backend behavior are preserved.

Validation:
- `node scripts/regression-check.mjs`
- App.js JSX/transpile syntax via TypeScript
- backend syntax via `node --check src/index.js`
- regression script syntax via `node --check scripts/regression-check.mjs`
- CSS brace balance
- final ZIP integrity and packaged regression
