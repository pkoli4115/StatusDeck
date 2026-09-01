# StatusDeck nested drag fix — 2026-08-10

## Root cause
The report section itself was marked `draggable=true` while card-level six-dot handles inside the section were also draggable. Browser drag events from a card therefore bubbled into the parent report section and could be interpreted as a whole-section drag/drop.

## Fix
- Whole report sections are no longer draggable from their entire surface.
- Only the visible six-dot report-section handle starts a section drag.
- Card-level dragstart/dragover/drop/dragend events stop propagation so the parent section cannot hijack them.
- Existing card order storage (`statusdeck-card-order-v1:*`) and section order storage are preserved.
- No Forge scopes, manifest permissions, resolver APIs, licensing, or KVS behaviour changed.

## Expected behaviour
- Drag a section using its outer six-dot handle: the whole section moves.
- Drag an inner card using its own six-dot handle: only that card reorders within its supported grid.
- Inner card drag should no longer trigger or interfere with the parent section drag.
