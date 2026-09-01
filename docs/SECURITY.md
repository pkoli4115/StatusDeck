# StatusDeck security overview

## Hosting and execution

StatusDeck is implemented as an Atlassian Forge app. Jira and optional Confluence access is performed through Forge APIs under the current user's product permissions.

## External services

The current manifest does not declare external egress domains. The StatusDeck Assistant is deterministic/local and does not call an external LLM or AI API.

## Least-privilege product behavior

StatusDeck reads Jira data required to build reports and does not request Jira work-item write scopes. Confluence write scopes are used only when the user explicitly chooses Publish to Confluence.

## Storage

StatusDeck uses Forge KVS for bounded application state such as configuration, commentary overlays, calendar reminder settings, usage counters, last-publication metadata and short-lived report/velocity/outlook caches. Generated PDF and PowerPoint files are not stored as KVS file blobs.

## Sprint Acceptance Criteria

For Acceptance Criteria reporting, StatusDeck requests Story Description content only for the selected sprint being reported (future, active or completed), plus the bounded next-sprint outlook when requested. It deterministically identifies Acceptance Criteria/AC sections or Given-When-Then structures, counts individual criteria, and reads explicit Markdown/Jira task completion state when present. Plain text is never inferred as Met or Not met. The AC result contains metadata/counts and issue keys; StatusDeck does not return the full Description solely for this metric.

## Defensive behavior

- Report generation is bounded by maximum issue limits.
- Report cache writes are skipped when the serialized record would exceed the configured KVS safety margin.
- Jira requests use retry handling for supported transient failures.
- Configuration values are normalized/validated before persistence.
- Commentary text and metadata fields are length-bounded before KVS writes.
- Report/Assistant queries run within the current user's Jira permissions.
