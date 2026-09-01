# KVS cache hotfix

Forge KVS permits a maximum single persisted value of 240 KiB. Large enterprise sprint reports can exceed that because StatusDeck keeps detailed issue/history data for drill-down and exports.

This package uses a 220 KiB cache safety margin. Oversized reports are returned normally but are not cached. This does not remove any report content; it only avoids using KVS for a non-critical cache entry that is too large.

After deployment, an oversized benchmark sprint may take longer to reload because it is recalculated from Jira instead of being served from KVS. Small reports continue to use the existing cache.
