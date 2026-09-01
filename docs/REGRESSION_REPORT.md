# StatusDeck regression report

Date: 2026-08-08
Baseline: production source supplied by the user on 2026-08-08.

## PASS — dependency tree consistency

Existing installed production dependency trees were checked with `npm ls --depth=0`.

Root dependencies resolved as installed:
- @forge/api 8.0.1
- @forge/kvs 2.0.1
- @forge/resolver 2.0.0
- eslint 8.57.1
- eslint-plugin-react-hooks 4.6.2

Front-end dependencies resolved as installed:
- React 16.14.0 / React DOM 16.14.0
- @forge/bridge 6.1.0-next.8
- @atlaskit/css-reset 6.16.0
- pptxgenjs 3.12.0
- jsPDF 2.5.2
- jspdf-autotable 3.8.4
- react-scripts 5.0.1

## PASS — backend syntax

`node --check src/index.js`

Result: pass.

## PASS — front-end production build

Using the supplied production `node_modules`, the executable bit lost in ZIP transport was restored for `react-scripts`, then:

`npm run build`

Result: **Compiled successfully.**

Generated production bundle is included under `static/hello-world/build`.

## PASS — source regression suite

`node scripts/regression-check.mjs`

Result: **26/26 checks passed**.

Checks cover:
- existing global page preserved
- project page
- board action
- backlog action
- dashboard gadget
- Marketplace licensing preserved
- storage scope preserved
- existing sprint-report, velocity, usage and license resolver markers preserved
- board estimation/config resolver
- reporting settings persistence
- commentary persistence
- scheduler settings persistence
- HDP hard-code absent
- PowerPoint/PDF export functions preserved
- Project/Program report UI
- Jira estimation detection UI
- calculation help
- Draft/Publish commentary
- Return to Green
- deterministic local StatusDeck Assistant
- Confluence/SharePoint copy action
- CSS brace balance

## PASS — Jira board configuration permission corrected

The board-configuration endpoint used by the new estimation auto-detection requires the granular scope:

`read:board-scope.admin:jira-software`

That scope is included in the updated manifest in addition to the app's existing scopes.

## Forge lint status — NOT EXECUTED IN THIS CONTAINER

The Forge CLI is not installed in the build environment. Attempting to obtain it via the container npm registry failed because that internal registry does not expose the Forge CLI package.

Therefore `forge lint` must be run in the user's configured Forge development environment before deployment.

## Fresh npm ci status — ENVIRONMENT BLOCKED, existing dependencies verified

A clean `npm ci` was also attempted in isolated test folders. The container's internal npm mirror returned 404 for packages referenced by the supplied lock files (for example `yocto-queue@0.1.0`) and attempted incompatible newer Atlaskit peer resolution on the front end.

No dependency or React upgrade was forced. The production dependency files were deliberately preserved. The existing installed dependency tree passes `npm ls`, and the full front-end production build passes with it.

## Direct resolver runtime import

A raw Node import is not a valid Forge runtime test for this source: the supplied production `@forge/resolver` package is loaded/bundled by Forge and raw Node ESM/CJS interop reports `ForgeResolver is not a constructor`. The unchanged production baseline has the same runtime-loading characteristic. Backend JavaScript syntax passes; Forge CLI bundling/deployment remains the authoritative runtime test.

## Overall status

The package **passes local source and front-end build regression checks**. It is **not labelled production-ready yet** because Forge manifest lint and in-product Jira smoke tests require the user's Atlassian development environment.

## Runtime hotfix: enterprise KVS cache size

Observed in Jira development after loading benchmark sprints with 125 issues: `Unexpected error in Forge KVS API`.

Root cause addressed: full sprint report cache values can exceed Forge KVS's 240 KiB per-value limit because the report payload intentionally includes detailed issue and history data. Report caching is now best-effort:

- cache reads fall back to fresh Jira generation if KVS cache access fails;
- cache writes are skipped above a 220 KiB safety threshold;
- cache write/delete failures are logged but never fail report generation;
- usage counters, settings, commentary and scheduler storage remain strict KVS operations because those records are small and functional rather than optional cache data.

Backend syntax check: PASS.
Automated regression suite: 26/26 PASS after hotfix.
Frontend source unchanged from the previously built package; user's Windows production build already compiled successfully.
