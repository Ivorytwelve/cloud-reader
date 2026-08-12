# Cloud Reader v0.1.3.2 — cloud audiobook resume fix

Fixes cloud-hosted audiobooks reopening at 00:00 even when the cloud progress
record contains a saved audiobook timestamp.

Cause:
Svelte's two-way `bind:currentTime` can write the new audio element's initial
0 seconds back into the current-time store when the remote `src` is replaced,
before `loadedmetadata` applies the resume position.

Fix:
For cloud/remote audio, Player.svelte now treats
`extensionData.playbackPosition` as the authoritative pending resume time at
`loadedmetadata`, writes it back into the store, and seeks the element to it.
Local Whispersync audio keeps the existing behavior.

Frontend only. No Worker deployment required.
