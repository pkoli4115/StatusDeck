# StatusDeck v4.4.2 — Title Case Verifier Fix

No report calculations or UI behaviour changed from v4.4.1.

The v4.4.1 package verifier incorrectly required some JSX labels to exist as
contiguous strings such as `>Remaining Effort<`. In the React source those
labels are separated from their surrounding tags by whitespace/newlines,
causing false FAIL results even though the displayed labels were already
Title Case.

v4.4.2 updates the verifier to recognize JSX whitespace correctly.

Confirmed source labels include:
- At Risk (dynamic formatter)
- At a Glance
- Reporting Scheduler
- Story Points
- Remaining Effort
- Live Events
- Full Table
- Executive Note
