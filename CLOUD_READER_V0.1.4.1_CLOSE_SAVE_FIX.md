# Cloud Reader v0.1.4.1 — audiobook close-save fix

Fixes the cloud audiobook timestamp being overwritten with `0` when leaving a book.

Root cause:
`saveCloudAudiobookProgress()` awaited `session.loaded` before reading the player's
current time. During reader teardown that await yields execution, allowing Svelte
to destroy/reset the audio element and its two-way `currentTime` binding to 0.
The function then resumed and persisted that teardown 0 to cloud progress.

Fix:
Snapshot `currentTime`, duration, and playback rate synchronously before the first
await, then persist that immutable snapshot after the progress session is ready.

Frontend only. No Worker deployment required.
