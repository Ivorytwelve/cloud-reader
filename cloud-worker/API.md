# Worker API (v0)

All routes except `/health` and signed asset GET/HEAD reads require `Authorization: Bearer <AUTH_TOKEN>`.

- `GET /v1/library` — library manifest.
- `GET /v1/library/snapshot` — bulk library refresh: manifest, quota, per-book progress/ETags, and signed cover URLs in one browser request.
- `PUT /v1/books/:id` — create/update book metadata.
- `DELETE /v1/books/:id` — remove metadata, assets, and progress.
- `GET /v1/books/:id/assets/:kind` — stream/download an asset; supports Range for media.
- `HEAD /v1/books/:id/assets/:kind` — probe asset metadata/content length without a response body.
- `POST /v1/books/:id/assets/:kind/signed-url` — issue a 24-hour signed asset URL.
- `PUT /v1/books/:id/assets/:kind/direct` — small-file upload.
- `POST /v1/books/:id/assets/:kind/multipart/create` — start multipart upload.
- `PUT /v1/books/:id/assets/:kind/multipart/part?...` — upload one part.
- `POST /v1/books/:id/assets/:kind/multipart/complete?...` — finish multipart upload.
- `DELETE /v1/books/:id/assets/:kind/multipart/abort?...` — abort multipart upload.
- `GET /v1/progress/:id` — get reader/audiobook progress and ETag.
- `PUT /v1/progress/:id` — save progress; optionally send `If-Match` with the previous ETag.

Asset kinds: `epub`, `audio`, `subtitles`, `cover`, `audioCover`, `alignment`.
- `GET /v1/stats` — aggregate cloud statistics across devices.
- `PUT /v1/stats/snapshot/:deviceId/:bookId/:date` — write an absolute per-device/day statistics contribution.
- `PUT /v1/stats/entry/:bookId/:date` — edit the canonical aggregate for one book/day by writing a manual adjustment.
- `DELETE /v1/stats/entry/:bookId/:date` — remove the current aggregate for one book/day; later reading can add new data again.
