# Cloud Reader v0.1.1

## Progress sync

- Cloud progress is fetched immediately before opening a title and seeds the shared reader/audiobook progress session.
- A cloud bookmark is authoritative over the invisible local EPUB cache when remote progress exists.
- Reader position is synced on meaningful movement (5 second audit), tab hiding/pagehide, reader teardown, and before SPA navigation.
- Reader progress is mirrored into the local IndexedDB cache only as a fallback/cache.
- Audiobook progress is synced every ~5 seconds while it changes, immediately on pause/visibility changes, and is explicitly flushed before leaving the reader.
- Final reader and audiobook writes are awaited before normal Cloud Reader navigation.

## Refresh optimization

- New `GET /v1/library/snapshot` Worker endpoint returns the manifest, quota, all progress records/ETags, and signed cover URLs in one browser request.
- The manager no longer performs library + quota + progress + signed-cover requests separately for every book.
- Existing cover URLs are retained while the cover ETag is unchanged, so an automatic refresh does not redownload unchanged covers.
- Opening a book performs one fresh bulk snapshot first, so another device's latest reader/audio position is used without a per-book refresh fan-out.
- The frontend falls back to the old refresh flow when used temporarily with an older Worker, allowing frontend/Worker deployment in either order.

This release changes both the frontend and `cloud-worker`; deploy both to enable the optimized snapshot path.
