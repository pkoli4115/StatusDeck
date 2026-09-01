# StatusDeck release — Executive commentary at-a-glance

Date: 24 Aug 2026

## What changed

The Sprint Management Commentary card is now presentation-first for busy stakeholders instead of defaulting to a large editable text area.

- Prominent colour-coded Sprint Status / Sprint Outcome / Planning Status badge.
- Two high-impact callouts for Progress and Forecast (or Planned Scope and Planning Readiness for future sprints).
- Active sprints show timebox elapsed and days remaining in the Progress callout.
- Forecast callout shows forecast vs original estimate and clearly marks provisional variance.
- Key Risks, Recommended Actions, and Next Sprint Outlook are separated into scannable visual panels.
- Leading labels such as `Schedule risk:` and `Validate estimates:` are visually emphasised.
- Missing Remaining Estimate action now uses the actual count of incomplete items without coverage where available.
- Planning/quality checks in the next-sprint outlook are shown as compact badges.
- Editing is still supported, but the textarea is opt-in behind **Edit commentary**. Save draft / Publish / Restore generated are preserved.
- Present mode remains read-only and shows the same presentation-first view.
- Saved/published custom summary text is retained as an Executive Note and preserved in exports.

## Export / publishing parity

- PowerPoint Management Commentary slide redesigned into the same at-a-glance hierarchy: status badge, Progress, Forecast, Key Risks, Recommended Actions, Next Sprint Outlook.
- PDF Management Commentary page uses the same hierarchy.
- Overflow and additional published commentary continue on a dedicated continuation page/slide.
- Confluence commentary now renders semantic headings and bullet lists, and bolds leading callout labels before a colon.

## Preserved behavior

No Jira calculations, RAG thresholds, report loading, caching, scheduler, Assistant, Custom Jira Insights, section movement, Confluence attachment publishing, or usage/quota behavior was intentionally changed by this update.
