# StatusDeck Forge permissions

This document reflects the current `manifest.yml` in this package. StatusDeck is a Forge app for Jira Cloud with optional Confluence publishing. It does not request Jira write scopes and does not declare external egress permissions.

## Jira scopes

- `read:jira-user` — read Jira user information needed for report context and display.
- `read:jira-work` — read Jira project/issue data used by reports and drill-downs.
- `read:project:jira` — read projects and project metadata.
- `read:board-scope:jira-software` — read Scrum boards and board-scoped data.
- `read:board-scope.admin:jira-software` — read board configuration, including estimation configuration and status/column mapping.
- `read:sprint:jira-software` — read sprint metadata and sprint-scoped work items.
- `read:issue-details:jira` — read issue details used in report calculations.
- `read:jql:jira` — execute/read JQL-backed queries used by StatusDeck reporting.
- `read:user:jira` — read Jira users visible to the current user.

## Forge storage

- `storage:app` — stores small StatusDeck settings/state records and bounded short-lived report caches in Forge KVS.

Stored records can include reporting settings, commentary Draft/Published overlays, calendar reminder settings, usage counters, Confluence publication metadata, and bounded report/velocity/outlook cache records. StatusDeck does not store generated PDF or PowerPoint files in KVS.

## Confluence scopes

Confluence is optional in app compatibility but is supported for direct report publishing.

- `read:space:confluence` — list/read spaces available to the user.
- `read:page:confluence` — read pages for parent-page selection and matching an existing Sprint child page.
- `write:page:confluence` — create/update the StatusDeck report page.
- `read:content-details:confluence` — read page/content metadata required by the publishing flow.
- `write:attachment:confluence` — upload/update the generated PDF and PowerPoint attachments on the report page.

## What is not requested

- No Jira issue/project write scope.
- No SharePoint permission or Microsoft Graph permission.
- No external AI/LLM API permission.
- No external egress domain is declared in the manifest.

## Installation / upgrade note

This package does not add new scopes beyond the current Confluence-enabled StatusDeck baseline. Existing installations that have already consented to these scopes should not require another permission upgrade solely for the Project/Program movement or Sprint Acceptance Criteria changes in this release.
