# StatusDeck UI v1 — Context Catalogue + Confluence Sprint Pages

Date: 2026-08-11

This package preserves the locked StatusDeck UI v1 and applies only the approved behavior changes.

## Assistant / Context Catalogue

- Builds a lightweight Jira project catalogue from the projects already loaded for the current user.
- Derives aliases dynamically from Jira project names and keys; there are no hard-coded customer mappings.
- Resolves project scope before intent, so questions such as `give me summary of insurance` resolve the matching accessible Jira project before summary logic runs.
- Uses fuzzy token matching for small spelling errors.
- Does not silently fall back to the active project when a new project reference is unresolved or ambiguous.
- Uses direct `requestJira` calls for board/sprint catalogue metadata and caches those results in browser memory.
- Fetches detailed sprint/report data only when a question requires it.
- Renders assistant answers using structured headings, bullets, and ordered lists.
- Preloads accessible Confluence spaces in browser memory through `requestConfluence` so the publish dialog opens with context ready.
- Loads Confluence pages lazily only after a space is selected.

## Confluence publishing

- Removes the legacy `Copy for Confluence / SharePoint` action.
- Publish flow is Space -> Parent Page -> Sprint child page.
- The Sprint child page title is derived from the sprint name (for example, `Sprint 5`) and remains editable.
- Re-publishing searches for the same child title under the same parent and updates it instead of creating a duplicate.
- The child page contains the full native StatusDeck report content.
- PDF and PowerPoint are attached beneath the native report using stable filenames so subsequent publishes version the same attachments.
- Publication success stores the actual created/updated child page web UI path.
- Last-publication metadata includes the Confluence space, parent page, child page, files, and timestamp.

## Permission change

The package adds:

- `read:space:confluence`

Existing Confluence page/attachment scopes remain in place. Jira remains the required Atlassian app and Confluence remains optional.

## Cost-conscious behavior

- No external AI/LLM API.
- No recurring Forge scheduler or polling.
- No full issue/worklog/changelog preload.
- Project, board, sprint, and Confluence-space context is kept client-side and reused where possible.
- Detailed report data is fetched on demand.
