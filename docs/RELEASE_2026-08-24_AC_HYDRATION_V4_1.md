# StatusDeck v4.1 — Acceptance Criteria hydration

Fixes a Jira Cloud edge case where the Jira Software sprint issue endpoint can return the selected sprint correctly while omitting/thinning rich-text Acceptance Criteria source fields.

- Keeps Description/custom-field AC detection unchanged.
- If every Story appears to have zero AC, performs one bounded Jira Platform enhanced-JQL hydration for the Story keys.
- Also hydrates individually missing AC source fields when only some Stories are affected.
- Does not store descriptions or raw Acceptance Criteria.
- Bumps report/outlook cache versions so stale 0% AC results are not reused after deployment.
- Preserves v4 glossy UI, v3 project/program commentary, exports, Confluence publishing, scheduler and Assistant.
