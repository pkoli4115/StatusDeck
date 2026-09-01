# StatusDeck data retention and storage behavior

This document describes retention implemented by the current StatusDeck code. Platform-level retention after uninstall or tenant lifecycle is governed by Atlassian Forge and should be verified against the current Atlassian policy before Marketplace publication.

## Persistent application records

StatusDeck may retain the following small Forge KVS records while the app is installed:

- Reporting configuration per project/board.
- Management Commentary Draft/Published text and state.
- Calendar reminder settings.
- Last successful Confluence publication metadata (page/space/parent identifiers, file names, publisher/time).
- Per-user hourly/daily usage counters.

The usage record is retained and logically resets its hourly/daily counters when the time window changes; the record itself is not deleted merely because a window changes.

## Short-lived cache records

StatusDeck can cache report, velocity and next-sprint-outlook results in Forge KVS as a performance optimization. Cache records contain an explicit expiry timestamp. The application treats expired records as invalid and attempts to delete them when they are read after expiry.

There is no recurring cleanup job in this code, so an expired cache record that is never read again is not proactively deleted by StatusDeck itself.

Oversized report caches are skipped rather than failing report generation.

## Generated files

PDF and PowerPoint exports are generated in the client. StatusDeck does not persist generated PDF/PPTX file blobs in Forge KVS. When the user explicitly publishes to Confluence, the generated files are uploaded as Confluence attachments and are then governed by the customer's Confluence content lifecycle.

## Acceptance Criteria analysis

Story Description text used for Acceptance Criteria analysis is processed in memory for the selected sprint (or bounded next-sprint outlook). The report result stores detection metadata, issue keys, individual criterion counts, and explicit Met/Not met/unrecorded counts; it does not copy the full Story Description solely for the AC metric.
