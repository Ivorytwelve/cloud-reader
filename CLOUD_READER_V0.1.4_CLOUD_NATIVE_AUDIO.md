# Cloud Reader v0.1.4 — cloud-native audiobook state

This changes the integrated Whispersync instance to use cloud audiobook state as the only
persistence source for remote audio.

- NativeWhispersync mounts AudioBookMenu with `cloudOnly={true}`.
- AudioBookMenu no longer loads local `audioBook`/file-handle playback state in cloud mode.
- It emits `ttu-cloud:whispersync-ready` only after its own initialization is fully complete.
- Cloud hydration happens only after that ready event, removing the initialization race that
  could reset the cloud timestamp back to 0.
- A dedicated `pendingCloudResumeTime$` carries the one-shot cloud resume point and cannot
  be overwritten by `<audio>`'s initial 0-second two-way binding.
- Player consumes the cloud resume after metadata/range seeking is available and suppresses
  startup progress writes until that initial seek completes.
- Remote/cloud playback no longer writes to Whispersync's local `audioBook` IndexedDB table.
  It emits only Cloud Reader progress events.

Frontend only; no Worker deployment required.
