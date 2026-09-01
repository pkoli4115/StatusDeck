# Blank page hotfix V2

Root cause: the masonry layout effect dependency array referenced `commentaryDraft`, but no such variable exists in the current frontend. That causes a `ReferenceError` during the initial React render and leaves the Forge Custom UI blank.

Fix: removed the invalid `commentaryDraft` dependency. The effect still reacts to report/layout changes, while `ResizeObserver` handles content-height changes such as commentary edits.
