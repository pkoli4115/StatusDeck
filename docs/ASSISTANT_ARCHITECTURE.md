# StatusDeck Assistant Architecture

The StatusDeck Assistant is a local deterministic Jira delivery assistant. It does not call an external LLM.

## Pipeline

1. Normalize input, shorthand, common typos and contractions.
2. Short-circuit greetings, acknowledgements and conversational filler without Jira calls.
3. Resolve pronouns/anaphora such as `this`, `it`, `those issues`, and ordinal follow-ups such as `second one` from session context.
4. Resolve temporal language such as `current sprint`, `previous sprint`, `next sprint`, `future sprints`, and `next 3 sprints`.
5. Resolve project/board/sprint entities from the user's accessible Jira catalogue with aliases and bounded fuzzy matching.
6. Detect the requested intent before operational retrieval.
7. Ask for clarification when confidence is low instead of silently falling back to an unrelated project.
8. Reuse browser-memory board/sprint/settings/snapshot caches.
9. Fetch detailed Jira data only when required by the resolved intent.
10. Generate adaptive follow-up actions based on the answer and available Jira context.

## Conversational sprint discovery

`LIST_FUTURE_SPRINTS` is a metadata-only intent. It understands natural variants such as:

- `show future sprints`
- `what sprints are coming`
- `next few sprints`
- `what comes after this`
- `future pls`

The returned sprint list is stored in session context so follow-ups such as `second one`, `summarize Sprint 7`, `load Sprint 7`, and `generate report for Sprint 7` can continue naturally.

## Modes

- **Instant** (default): minimal targeted retrieval; current queries normally inspect at most one sprint snapshot.
- **Medium**: allows additional supporting analysis when the intent requires it.
- **High**: allows deeper comparison/trend work but remains bounded; the default historical window is capped.

No mode performs an unrestricted Jira crawl. Future-sprint discovery uses sprint metadata only and does not fetch sprint issue snapshots unless the user subsequently asks for analysis of a selected sprint.

## Tests

- `node scripts/regression-check.mjs` protects the stable StatusDeck v1 report and integration behavior.
- `node scripts/assistant-scenarios.mjs` validates normalization, small talk, project/entity matching, anaphora, temporal language, future-sprint discovery, adaptive follow-ups, bounded analysis modes, and response construction.

## Agile knowledge layer

Before generic intent fallbacks, the Assistant maps natural Agile/Jira terminology to StatusDeck concepts. Supported concepts include sprint health, completion, commitment vs delivery, burndown, scope movement, carry-over/spillover, velocity, throughput, workload, capacity/bandwidth view, defects, overdue work, estimate confidence, unestimated work, status/WIP distribution, work-item types, priority distribution, Sprint Goal, aging open work, blockers/impediments and sprint predictability signals.

The knowledge layer also recognises concepts that the current snapshot cannot calculate reliably, including cycle time, lead time, backlog health, burnup, Definition of Done, defect leakage and release forecasting. These are answered honestly without a Jira snapshot fetch; StatusDeck does not invent unsupported KPI values.

`CARRY_OVER` is intentionally calculated only on request by reusing the existing next-sprint outlook resolver, which verifies that the same Jira issue exists in both the current and next sprint. `BURNDOWN` reuses the sprint history already present in the Assistant snapshot. `PREDICTABILITY` is a deterministic delivery signal from bounded scope/overdue/defect/estimate evidence; it is not presented as a statistical completion probability.
