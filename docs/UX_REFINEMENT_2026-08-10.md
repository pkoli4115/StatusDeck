# StatusDeck UX refinement — 2026-08-10

Changes requested after Jira runtime validation:

1. The Report layout/section selector is on the right-hand side on desktop rather than occupying the left side.
2. Report sections can be dragged into a custom order. The order is applied to the rendered report and persisted in browser localStorage as a UI preference; Jira remains the source of truth and no additional Forge KVS cost is introduced.
3. Management commentary is a single card. Generated commentary, Draft and Published commentary are different states of the same surface rather than duplicate dashboard cards.
4. Draft/Publish/Edit/Use generated controls remain available inside the single Management commentary card.
5. Return to Green now provides concise recovery commentary. It aggregates overdue work, unresolved defects, missing remaining estimates and unassigned work instead of enumerating individual defect/issue rows.
6. Calculation help no longer uses a click-driven ƒx popover. It uses a small info indicator and shows calculation detail on hover or keyboard focus. Calculation detail remains UI-only/no-export.
7. Existing velocity runtime/KVS hotfixes, Marketplace licensing, usage limits, PPT/PDF generation, Jira entry modules, project report, settings and assistant code are preserved.

## Validation in this environment

- Backend `src/index.js`: Node syntax check passed.
- Source regression suite: 26/26 passed.
- CSS brace-balance check: passed.
- Full React production build could not be executed in the container because the internal npm registry returned a 404 for `yocto-queue@0.1.0`. Run `npm run build` using the already-installed dependency tree on the development machine before deployment.

## Required local validation

```cmd
cd D:\Prasanth\JiraPluginsProject\statusdeck-next\static\hello-world
npm run build

cd D:\Prasanth\JiraPluginsProject\statusdeck-next
forge lint
forge deploy -e development
```

No new Forge scopes were added by this UX refinement.
