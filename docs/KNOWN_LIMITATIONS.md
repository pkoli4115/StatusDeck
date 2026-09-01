# StatusDeck known limitations

1. `forge lint`, Forge bundling and tenant-level placement checks must be run in a local environment with the Forge CLI and valid Atlassian credentials.
2. Project page, board action, backlog action and dashboard gadget placement must be verified against the target Jira Cloud tenant after deployment.
3. Board estimation auto-detection should be tested against Scrum boards using story-point/custom numeric fields, issue count, Original Estimate and boards without a configured estimation statistic.
4. Project/Program reporting evaluates each Scrum board independently. StatusDeck deliberately does not sum incompatible estimation units or compare teams by a single aggregated velocity.
5. Project/Program scope-growth claims require a reliable sprint-start baseline. If Jira history cannot establish one, StatusDeck shows `Scope baseline unavailable` instead of treating all current items as scope added.
6. Acceptance Criteria analysis is deterministic. StatusDeck checks Story descriptions for an Acceptance Criteria/AC section or Given-When-Then structure. It counts identifiable individual criteria but does not judge semantic quality or business correctness.
7. Acceptance Criteria readiness currently counts Story/User Story issue types only. Epics and other work-item types are not included in the Story-level coverage percentage.
8. StatusDeck fetches Description only for the selected sprint being reported (future, active or completed), plus the bounded next-sprint outlook when needed. The full Description is not copied into the AC result solely for this feature; detection metadata, issue keys and aggregate criterion counts are returned. Met/Not met is reported only for explicit checkbox/task states. Plain-text criteria are shown as completion status not recorded.
9. Direct Confluence publishing is supported. Direct SharePoint publishing is intentionally not implemented.
10. Reporting reminders use Google Calendar/Outlook links and downloadable recurring `.ics` invitations. StatusDeck does not send external email/Teams/Slack reminder messages.
11. StatusDeck Assistant is deterministic/local and does not call an external LLM. It only answers supported Jira/Agile questions and uses bounded Jira retrieval based on intent.
12. Cycle time, lead time, CFD-quality flow analysis and similar history-heavy metrics are not shown as calculated values unless the required transition history is intentionally retrieved and supported. StatusDeck does not fabricate unsupported KPIs.
13. PDF/PPTX exports are generated client-side. Confluence publishing uploads those generated files to the selected Confluence page; copies are not stored in StatusDeck KVS as report-file blobs.
14. Forge KVS report caches are an optimization only. They carry an expiry timestamp and expired records are deleted on a later cache read; there is no separate recurring cleanup job in this code.

## Custom KPIs / Filters and Jira dashboard reuse

StatusDeck can reuse visible Jira saved filters directly and evaluate custom JQL as matching-issue KPIs. It also catalogues Jira dashboards and inspects dashboard item properties for saved-filter references. Only filter-backed gadgets whose saved filter is actually exposed by Jira are offered as reusable KPI sources. StatusDeck does not guess or reverse-engineer proprietary/private gadget calculations.

## Project / Program export

Project / Program reports can be downloaded as PowerPoint or PDF and can use the same Confluence Space → Parent Page → report-page publishing workflow as Sprint reports. The same Export / Publish action is used for both report types.

## Jira dashboard gadget portability
StatusDeck can reuse Jira dashboard gadgets only when Jira exposes enough portable gadget metadata/properties to reconstruct the calculation. The current visual compatibility set includes Created vs. Resolved, Pie Chart, Two-Dimensional Filter Statistics, Days Remaining, plus count-based saved-filter/custom-JQL insights. A filter-backed gadget with an unknown or non-portable configuration may fall back to a count/evidence result rather than an exact visual. Third-party dashboard gadgets are not assumed to be reproducible.

Saved Jira filters themselves are generic JQL sources, so customers do not need to test every individual filter. Release validation should cover each supported gadget family and representative JQL patterns (large filters, custom fields, no-result filters, permissions, renamed gadgets, and mixed dashboard configurations).

Confluence publishing uses native Confluence Chart macros for portable line/pie visuals and native tables/panels for tabular/count insights. The attached PDF and PowerPoint remain the branded full-fidelity artifacts.

15. Confluence Cloud no longer allows new instances of the legacy Chart macro. StatusDeck therefore publishes Created-vs-Resolved and Pie custom insight visuals as generated PNG attachments embedded in the report page, while Two-Dimensional insights remain native Confluence tables. This avoids legacy macro rendering failures and preserves the underlying PDF/PPTX attachments.
