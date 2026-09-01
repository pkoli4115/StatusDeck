# StatusDeck v4.3 — Strict Display Title Case

## Purpose
Correct the v4.2 naming sweep so dynamic statuses and remaining UI labels follow the same visible naming standard as headings and report sections.

## Display naming standard
- Visible headings, cards, badges, status labels, controls, configuration labels, table/report labels, and export labels use Title Case.
- Examples: `At Risk`, `Watch Closely`, `On Track`, `Delivered With Concerns`, `Delivery Progress`, `Sprint Status`, `Acceptance Criteria`, `Traceability Gaps`.
- Normal explanatory sentences and helper prose remain sentence case.
- Internal code identifiers, Jira field IDs, parser aliases, and calculations are unchanged.

## Coverage
- Sprint Status Report
- Executive Pulse and Executive Summary
- Management Commentary
- Acceptance Criteria and Traceability
- Report section selector
- Configuration and Custom Jira Insights
- Project / Program report
- Present mode
- PowerPoint, PDF, and Confluence labels

## Regression guardrail
Regression checks now explicitly fail if core visible statuses or labels regress to forms such as `At risk`, `Watch closely`, `On track`, `Stories with AC`, or `Parent / requirement linked`.
