# StatusDeck executive canvas fix — 2026-08-10

## Scope

This build corrects the executive dashboard layout/drag regressions introduced by the earlier nested-card experiments.

### Executive hierarchy

1. Management Commentary — full width and first by default.
2. Sprint Health & Core KPIs — full width. Delivery Progress, Completed, Remaining and Delivery Risk stay together inside this block.
3. Risk Profile / Scope Health — half-width peer blocks.
4. Work Distribution / Capacity View — half-width peer blocks.
5. Velocity / Return to Green — half-width peer blocks.

The Executive Overview uses one 12-column reorderable canvas. Individual executive blocks are peers and can be reordered using their six-dot handles. Full-width blocks retain span 12; paired blocks retain span 6.

### Drag behavior

- Uses Pointer Events for Forge iframe compatibility.
- Drop resolution uses direct hit testing plus nearest-card fallback, so whitespace/gaps do not prevent a move.
- Dragging near the top or bottom of the viewport auto-scrolls, allowing a lower card to be moved back to the top.
- A fresh local layout preference key is used so broken experimental orders from previous packages are ignored.

### Burndown

- A compact daily story-point burndown is embedded in Sprint Health for Executive view.
- The chart is constrained to an executive-card-sized height (max ~320px inside Sprint Health).
- The detailed Burndown section remains selected for exports and remains available in Custom/Detailed views; it is only hidden as a duplicate in Executive view.
- The standalone detailed chart is also capped at ~340px on the web.

### Velocity

- A compact recent-velocity summary (latest 3 closed sprints) is included beside Return to Green in Executive view.
- The detailed Velocity section remains available in Custom/Detailed views and for exports.

### Not changed

- Forge scopes / permissions
- Licensing
- Backend/KVS behavior
- Jira data retrieval and calculations
- PowerPoint/PDF generation logic
- Commentary persistence
- Scheduler logic
