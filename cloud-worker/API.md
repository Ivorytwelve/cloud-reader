# Worker API (v0)

All routes except `/health` and signed asset GET/HEAD reads require `Authorization: Bearer <AUTH_TOKEN>`.

- `GET /v1/library` — library manifest.
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

Asset kinds: `epub`, `audio`, `subtitles`, `cover`.
