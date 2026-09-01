# StatusDeck Unified Card Canvas — 2026-08-10

## Problem fixed
The report used a two-column pseudo-masonry layout for top-level report sections and multiple independent CSS grids inside Executive Overview. This caused two visible problems:

1. Large blank areas when one top-level column contained a much taller section than the other.
2. Individual Overview cards could be dragged only inside their original nested grid, so Management Commentary could not move to the first position or across to the opposite column.

## Changes
- Top-level report sections now use normal single-column document flow. The runtime grid-row-span/masonry calculation is removed.
- Executive Overview is now one responsive two-column card canvas.
- Existing Overview wrapper grids are retained in JSX for component compatibility but flattened with `display: contents`.
- Card pointer dragging treats all supported Overview cards as one logical reorder group.
- Overview card order uses a new localStorage preference key (`statusdeck-card-order-v2:overview:unified-canvas-v2`) so stale per-grid order preferences do not constrain the new layout.
- Existing pointer-based iframe-safe dragging remains in place.
- No Forge permissions/scopes, backend resolver logic, licensing, KVS usage, PPT export, or PDF export were changed.

## Regression
`node scripts/regression-check.mjs` => 36/36 PASS.

Fresh frontend dependency installation could not be completed in the sandbox because the internal npm mirror returned HTTP 404 for React. Run the build locally before deployment.
