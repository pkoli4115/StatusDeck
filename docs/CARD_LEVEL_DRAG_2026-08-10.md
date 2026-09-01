# StatusDeck card-level drag update — 2026-08-10

## Change

Every visual card inside StatusDeck's supported dashboard grids now receives its own six-dot drag handle.

Supported card groups include:
- headline KPI cards (Delivery progress, Completed, Remaining, Delivery risk)
- Sprint health / Work distribution cards
- secondary KPI cards
- risk/scope/capacity/commentary/recovery cards
- effort metric cards
- estimate coverage cards

Cards can be reordered left/right/up/down within their responsive grid. Reordering changes CSS Grid `order`; neighbouring cards therefore reflow naturally and do not overlap.

The existing section-level six-dot handles remain in place for moving whole report sections.

Card order is stored in browser localStorage only (`statusdeck-card-order-v1:*`). No Forge KVS write or additional scope is introduced.

## Preserved
- flicker-stability ResizeObserver fix
- section-level movable layout
- compact Report Sections selector
- inline editable Management Commentary + Save Draft / Publish
- KVS oversized-report protection
- velocity runtime optimization
- PPT/PDF generation
- Marketplace licensing and usage limits

## Deployment

No manifest/scope change. Build frontend, run `forge lint`, then deploy to development. `forge install --upgrade` is not required for this change.
