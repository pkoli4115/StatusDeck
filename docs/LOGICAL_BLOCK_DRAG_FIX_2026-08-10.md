# StatusDeck logical block drag fix — 2026-08-10

## Corrected behaviour
- Executive Overview uses one real drag canvas.
- Headline KPIs (Delivery progress, Completed, Remaining, Delivery risk) remain one composite movable block.
- Secondary KPI strip remains one composite movable block.
- Sprint health, Work distribution, Risk profile, Scope health, Capacity view, Management commentary, and Return to Green are independent peer movable blocks.
- Management commentary can be reordered to the first/top-left position by dropping it before the current first block.
- Removed the previous `display: contents` flattening that split composite KPI groups.
- Pointer-event dragging remains iframe-safe for Forge Custom UI.

## Validation
Run from app root:
`node scripts/regression-check.mjs`

Expected: `38 regression checks passed.`

Frontend production build must be run in the developer's normal npm environment. The sandbox package mirror returned HTTP 404 for React during `npm ci`, so no claim is made that the frontend build completed in the sandbox.
