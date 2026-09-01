# StatusDeck safe deployment / test sequence

This package is intended to be extracted into a clean StatusDeck working folder. It intentionally excludes `backup/`, dependency directories and generated frontend build output.

## 1. Run regression suites

From the app root:

```cmd
node scripts\regression-check.mjs
node scripts\assistant-scenarios.mjs
```

Both suites must pass before building or deploying.

## 2. Front-end build

```cmd
cd static\hello-world
npm ci
npm run build
cd ..\..
```

If the working checkout already has a known-good `node_modules`, `npm run build` is sufficient. Do not upgrade React or force dependency changes as part of this release.

## 3. Forge validation and development deployment

```cmd
forge lint
forge deploy -e development
```

No new manifest scopes are introduced by the Project/Program movement or Sprint Acceptance Criteria changes in this package. If the current development installation already has the Confluence-enabled StatusDeck scopes, an installation upgrade should not be required solely for this release.

## 4. Sprint-report smoke tests

- Load an active Sprint report and confirm the stable Sprint layout/calculations remain unchanged.
- Move overview blocks with the six-dot menu and verify Up/Down and paired Left/Right behavior.
- Edit Management Commentary, Save draft, Publish and Restore generated.
- Check RAG calculation help and configurable thresholds.
- Verify Return to Green uses real Jira risks.
- Verify Remaining Estimate/Forecast/Variance calculation help and provisional labeling.
- Export PDF and PowerPoint.
- Publish to Confluence and verify the native page plus PDF/PPTX attachments.

## 5. Future Sprint readiness smoke tests

Load a future sprint containing several Story issues with a mix of Description content:

- Story with an `Acceptance Criteria` or `AC` heading and identifiable criteria -> detected and individual criteria counted.
- Story with Given/When/Then structure -> detected.
- Story with Description but no identifiable AC -> flagged.
- Story with no Description -> flagged.
- Bug/Task/Epic -> not counted in the Story-level AC percentage.

Verify the Future Sprint panel shows:

- Sprint Goal presence.
- Assigned coverage.
- Estimated coverage.
- Acceptance Criteria Story coverage, individual criteria count, explicit Met/Not met/status-not-recorded counts, and calculation help.
- Velocity load versus recent average.
- Flagged Story keys with `Open flagged Stories in Jira`.
- Data-generated Management Commentary mentioning real AC gaps; no dummy text.

In Configuration, change `Minimum Story Acceptance Criteria coverage %`, reload the future sprint and confirm readiness scoring uses the saved threshold.

## 6. Project / Program report smoke tests

- Select `Project / Program Report` and `All Scrum boards`.
- Confirm Executive & Program Health, Management Commentary, Delivery & Team Health, Operational Flow & Capacity, Quality/Risk, Epics, Releases and detailed board evidence render from Jira data.
- Verify calculation-info controls show actual team-by-team arithmetic.
- Verify scope baseline is guarded when sprint-start history is unavailable.
- Use each six-dot menu. Full-width sections move Up/Down; paired analytical sections also move Left/Right.
- Refresh/reopen and confirm the Project layout persists independently of the Sprint layout.
- Confirm empty Epic/Release sections remain compact.
- Confirm the generic `Your report preview will appear here` empty state is not rendered after a Project report has loaded.

## 7. Accessibility smoke tests

- RAG states always display GREEN/AMBER/RED text and are not conveyed by colour alone.
- Use keyboard-only navigation for move menus, Configuration, calculation-help controls and Export/Publish.
- Confirm visible focus treatment is present.
- Confirm charts/visuals have adjacent text values or tables so meaning is not colour-only.

## 8. Production

Deploy the exact source that passed the development smoke tests:

```cmd
forge deploy -e production
```

Keep the Git commit/tag aligned with the deployed source so the Marketplace/customer documentation matches the running app.
