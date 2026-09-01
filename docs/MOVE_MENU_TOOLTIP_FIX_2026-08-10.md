# StatusDeck deterministic move menu + calculation tooltip fix

## UI movement
- Retired native/pointer drag-and-drop for report movement inside Forge.
- Clicking a six-dot section handle now opens Move Up / Move Down / Move Left / Move Right commands.
- Top-level full-width report sections support deterministic Up/Down. Left/Right remain disabled because a full-width section has no horizontal sibling slot.
- Executive Overview blocks use a 12-column row model. Half-width peer cards support Left/Right, and Up/Down swaps the appropriate row/column. Full-width Management Commentary and Sprint Health move by complete rows.
- Only logical executive blocks have card movement handles; metric tiles within Effort, Scope History and other sections are not independently movable.
- New local preference keys reset the experimental drag layouts from earlier builds.

## Burndown
- Only the compact Daily story-point Burndown inside Sprint Health is rendered in the Jira web report.
- The standalone duplicate Burndown web section is disabled and removed from the section selector.
- PowerPoint/PDF export Burndown remains unchanged.

## Calculation help
- Calculation help is rendered into document.body with React createPortal and position: fixed so parent card/chart overflow cannot clip it.
- Tooltip appears on mouse hover and keyboard focus and is kept within the Forge viewport.
- Added calculation help to Delivery Health, current scope / estimate revision, estimate coverage metrics, effort forecast/variance, and Velocity where applicable.

## Validation
- 66/66 source regression checks passed.
- App.js passed TypeScript JSX syntax transpilation.
- npm ci was attempted in the sandbox but the internal npm registry returned HTTP 404 for React. Run the normal local npm build before Forge deployment.
