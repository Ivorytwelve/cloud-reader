# Cloud Reader v0.1.3.3 — deterministic audiobook resume

The cloud progress can already contain a valid audiobook timestamp while the
Whispersync audio element still opens at 0. This patch removes the startup race.

Changes:
- marks remote/cloud audio before assigning the audio src;
- seeds Whispersync's local audioBook cache with the cloud timestamp;
- restores loadedmetadata from extensionData.playbackPosition for cloud audio;
- blocks startup timeupdate/pause persistence until the initial seek completes.

Frontend only. No Worker deploy required.
