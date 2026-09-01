# Blank page hotfix - 2026-08-10

## Root cause
The masonry/grid-gap refinement introduced a React runtime initialization error.
The masonry `useEffect` dependency array referenced `activeReportPreset` before the
`useState` declaration for that variable had executed. In JavaScript this hits the
temporal dead zone and can stop the React app during initial render, leaving only
the Jira page shell visible.

## Fix
Moved the `activeReportPreset` state declaration above the masonry `useEffect`.
No resolver, manifest, licensing, KVS, report calculation, export, or permission
logic was changed.

## Preserved refinements
- compact Report Sections panel below selectors
- inline editable Management Commentary with Save Draft / Publish
- six-dot live section dragging
- two-column movable report layout
- masonry-style packing to reduce gaps between unequal-height sections
- drag handle offset so it does not cover section headings

## Validation
- source regression suite: 26/26 PASS
- CSS brace validation: PASS (part of regression suite)
- state/effect initialization order: PASS by source inspection

A full React production build should still be run locally before deploying.
