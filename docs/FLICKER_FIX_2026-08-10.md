# StatusDeck report flicker fix

Cause: the masonry ResizeObserver callback reset every report block to `grid-row-end:auto`, measured, then re-applied spans. That layout mutation retriggered ResizeObserver continuously, causing visible flicker.

Fix:
- never reset rows to `auto` during measurement
- measure intrinsic content height
- update a grid span only when the calculated span actually changes
- preserve two-column reflow, six-dot dragging, inline commentary, and compact Report Sections
