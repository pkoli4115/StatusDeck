# StatusDeck UI v1 hotfix — Assistant project context + Confluence home page URL

## Fixes
- Treats `about <name> project`, `from <name> project`, and `<name> project` as explicit project references in StatusDeck Assistant.
- Explicit project references reset prior assistant project context rather than falling back to the previously discussed project.
- Confluence page parsing accepts both `pageId=<id>` and space overview `homepageId=<id>` URLs, plus `/pages/<id>` and numeric IDs.

## Validation
- Regression suite: 165/165 passed.
- Backend JavaScript syntax: passed.
- Frontend App.js TypeScript/JSX parse: passed.
- Final packaged ZIP regression is run after extraction before handoff.
