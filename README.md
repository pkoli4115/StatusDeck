> **v4.3 (2026-08-31):** strict visible Title Case consistency, including dynamic status badges such as **At Risk / Watch Closely / On Track**, controls, Acceptance Criteria, traceability, configuration, and export labels.

# StatusDeck – Executive Sprint Reporting for Jira Cloud

StatusDeck is a Forge app for Jira Cloud that produces management-ready sprint reporting, PowerPoint/PDF exports, Confluence publishing, scheduled calendar reminders, and a local deterministic Jira delivery assistant.

## Stable report baseline

The StatusDeck report/UI is treated as the stable v1 baseline. Assistant development is isolated from report calculations, exports, Configuration, scheduler/calendar reminders, Confluence publishing, RAG, Management Commentary, Burndown, and report layout.

## Local setup

Install root dependencies:

```cmd
npm ci
```

Install and build the Custom UI:

```cmd
cd static\hello-world
npm ci
npm run build
cd ..\..
```

## Validation

Run the full StatusDeck regression suite:

```cmd
node scripts\regression-check.mjs
```

Run the dedicated Assistant conversation scenarios:

```cmd
node scripts\assistant-scenarios.mjs
```

## Deploy to development

```cmd
forge lint
forge deploy -e development
```

When scopes have not changed, an installation upgrade is normally not required. If deploying to a new site/product or after a permission change, use the appropriate `forge install` / `forge install --upgrade` command.

## Assistant architecture

The Assistant uses no external LLM/API. It uses an in-browser Context Catalogue plus lazy, intent-driven Jira retrieval. The conversational pipeline is:

1. Input normalization
2. Small-talk interception
3. Conversational reference/anaphora resolution
4. Jira entity resolution
5. Intent detection and confidence handling
6. Targeted Jira retrieval only when needed
7. Deterministic StatusDeck calculations
8. Structured response/action rendering
9. Session-context update

Assistant analysis modes are **Instant** (default), **Medium**, and **High**. Higher modes allow deeper but bounded analysis; they never mean “fetch everything”.

## Repository hygiene

Do not commit generated/local artifacts such as `node_modules/`, `static/hello-world/build/`, `backup/`, logs, or release ZIPs.

## Custom Jira Insights compatibility

Custom Jira Insights reuses saved Jira filters, custom JQL, and portable Jira dashboard gadget configuration without silently adding the selected StatusDeck project/sprint scope. Current first-class dashboard visual support includes **Created vs. Resolved**, **Pie Chart**, **Two-Dimensional Filter Statistics**, and **Days Remaining**. Generic saved-filter/custom-JQL sources are supported as counts. Gadgets whose calculation/configuration is not exposed portably by Jira are not assumed to be exactly reproducible.

Custom Jira Insights now participate in the same movable report-section model as native Sprint and Project/Program sections. Confluence publishing renders portable line/pie insights using native Confluence Chart macros, two-dimensional insights as native tables, and count/days-remaining insights as native panels; the PDF and PowerPoint remain attached as full-fidelity companion files.


## Confluence chart compatibility

Custom Jira Insight charts are rendered client-side and uploaded as stable PNG attachments for Confluence pages. This intentionally avoids creating new legacy Confluence Chart macros, which are no longer supported for insertion in current Confluence Cloud pages. Two-Dimensional Filter Statistics continue to publish as native Confluence tables.

## v4.2 naming consistency

Visible product terminology uses **Title Case** consistently across the Jira UI, Sprint and Project/Program reports, PowerPoint, PDF, and Confluence output. Examples include **Delivery Progress**, **Sprint Report**, **Sprint Scope History**, **Team Workload**, **Executive Summary**, **Management Commentary**, and **Traceability & Quality Evidence**. Explanatory sentences remain sentence case; internal code identifiers and parser aliases are unchanged.

## v4.4 Naming Consistency
Visible StatusDeck UI headings, statuses, metric labels, action labels and report/export headings use consistent Title Case. Explanatory prose remains sentence case. See `docs/RELEASE_2026-08-31_COMPLETE_TITLE_CASE_V4_4.md`.


## v4.4.1 installation note
This ZIP is intentionally packaged with `manifest.yml`, `static/`, `src/`, and `scripts/` at the ZIP root. Copy these root contents directly over your existing `statusdeck-next` folder.

After copying, run:
`node scripts/verify-titlecase-package.mjs`

