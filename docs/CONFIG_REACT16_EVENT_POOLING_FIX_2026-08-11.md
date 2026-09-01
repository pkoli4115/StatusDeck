# Configuration React 16 event-pooling fix — 2026-08-11

## Root cause
The Custom UI uses React ^16. React 16 pools SyntheticEvent objects. Several Configuration controls read `event.target.value` or `event.target.checked` from inside a functional state updater. The updater may execute after React has released the event, at which point `event.target` is null. This produced the runtime error:

`Cannot read properties of null (reading 'value')`

## Fix
All affected Configuration controls now copy `event.currentTarget.value` (or `checked`) to a local primitive before calling the functional state updater. The same latent React-16 pattern was corrected in Reporting Scheduler controls.

## Scope
No UI layout, manifest, backend, permissions, storage, export, Burndown, licensing, or dependency changes.
