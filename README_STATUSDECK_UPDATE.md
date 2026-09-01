# StatusDeck UI v1 — 2026-08-11 update

This build preserves the locked StatusDeck UI v1 and adds the approved Context Catalogue and Confluence Sprint-page workflow.

Highlights:

- Removed `Copy for Confluence / SharePoint`.
- Assistant resolves accessible Jira projects dynamically before answering project-scoped questions, supports fuzzy matching, and does not blindly fall back to the active project.
- Assistant board/sprint metadata is cached client-side and fetched through Jira bridge calls; detailed report data remains on-demand.
- Confluence spaces preload into browser memory; pages load lazily for the selected space.
- Confluence publishing now uses Space -> Parent Page -> auto-created/updated Sprint child page.
- Full native StatusDeck report remains on the child page, with PDF and PPTX attachments below.
- Re-publishing reuses the same Sprint child page and stable attachment filenames.
- Success/last-published links use the actual child page returned by Confluence.
- New scope: `read:space:confluence`.

See `docs/V1_CONTEXT_CATALOGUE_CONFLUENCE_CHILD_PAGES_2026-08-11.md` and the run-commands document for details.
