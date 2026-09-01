# StatusDeck baseline refinement — 2026-08-10

Baseline: Move Menu + Tooltip Fix.

Changes in this package:

1. Management Commentary publish/draft actions now show inline success or failure feedback beside the buttons.
2. PPTX/PDF export receives the full controlled Management Commentary value, independent of textarea scroll position. Summary/Risks/Actions use the editor/published content, and Next Sprint Outlook / Planning Checks / extra commentary are retained on a continuation page/slide when present.
3. Two intentionally different burndown views are available again:
   - Sprint Health compact Live/Intraday Jira-event burndown (event-level data; daily fallback when needed).
   - Detailed Sprint Burndown section with Story Points / Remaining Effort and Daily / Live Events controls.
4. Existing section move menus, layout, calculation hover tooltips, Forge scopes, backend resolvers, storage and export limits are preserved.
