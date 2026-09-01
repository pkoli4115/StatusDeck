# StatusDeck card drag fix — Pointer Events — 2026-08-10

## Problem reproduced from Jira screenshot
The six-dot card handles were visible, but the individual dashboard cards did not begin a reliable native HTML5 drag inside the Forge Custom UI iframe. The previous implementation depended on `dragstart`, `dragover` and `drop`.

## Fix
- Individual card handles now use Pointer Events (`pointerdown`, `pointermove`, `pointerup`, `pointercancel`).
- Native HTML5 dragging is disabled on injected card handles.
- Drag hit-testing uses `document.elementFromPoint()` against sibling movable cards.
- Card drag events are prevented/stopped so they cannot activate the parent report-section drag system.
- A 5px movement threshold distinguishes drag from a simple press.
- Mouse, pen and touch pointer paths are supported.
- Existing card order still persists only in browser `localStorage`; Forge/KVS usage is unchanged.
- PPT/PDF export, licensing, resolver logic, manifest scopes and backend storage were not changed.

## Regression
Run from the app root:

    node scripts/regression-check.mjs

Expected for this package: `31 regression checks passed.`

The captured result is in `docs/CARD_POINTER_DRAG_REGRESSION.txt`.

## Build validation
A clean frontend dependency install was attempted in the OpenAI sandbox. It was blocked by the sandbox's internal npm mirror returning HTTP 404 for packages referenced by the supplied lockfile (including `yocto-queue@0.1.0`). Therefore the React production build is NOT claimed as passed in the sandbox.

Build with the already-working Node/npm setup on the StatusDeck development machine before Forge deploy.
