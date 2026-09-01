# StatusDeck UI v1 - Configuration blank-page root fix

## Root cause
The Executive Overview move controls were injected into React-owned card nodes with DOM APIs (`document.createElement` + `insertBefore`). Any Configuration edit updates React state and triggers a rerender. React could then reconcile against a child tree that no longer matched the JSX tree, causing an intermittent runtime reconciliation failure and a blank Forge Custom UI page.

## Fix
- Removed all imperative DOM creation/insertion for Executive Overview move controls.
- Overview card order is now stored in React state (`overviewOrder`) and persisted to the existing localStorage preference.
- Six-dot move controls are rendered directly in JSX.
- The existing React `MoveMenu` portal is reused for Move Up/Down/Left/Right.
- Card placement uses React `style.order`, so Configuration rerenders do not mutate or conflict with the DOM tree.
- UI v1 layout, report calculations, configuration semantics, exports, backend, manifest, scopes and dependencies are otherwise unchanged.

## Validation
Run `node scripts/regression-check.mjs` from the app root.
