# Ttsu Cloud Reader v0 architecture

```text
GitHub Pages / PWA
       |
       | authenticated JSON requests
       v
Cloudflare Worker  --------------------------+
       |                                      |
       | R2 binding                           | temporary signed media URL
       v                                      v
Cloudflare R2 <-------------------------- <audio src>
```

## R2 layout

```text
_meta/library.json
books/<book-id>/epub
books/<book-id>/audio
books/<book-id>/subtitles
books/<book-id>/cover
progress/<book-id>.json
```

`_meta/library.json` contains only lightweight metadata. Audiobook bytes never pass through the library response.

## Playback

The app asks the authenticated Worker for a signed URL for `books/<id>/audio`. The HTML audio element uses that URL directly. Range headers are forwarded to `R2Bucket.get(..., { range: request.headers })`, so seeking does not require downloading the preceding audio. Signed `HEAD` requests are also supported for media probes.

Signed media URLs expire after 24 hours. The long expiry avoids a normal listening session dying in the middle. They expose access only to one asset and do not expose the master API token.

## Uploads

Small files use a direct Worker PUT. Large files use R2 multipart upload with 10 MiB chunks by default and four parallel requests. The client retains the multipart `uploadId` and uploaded part ETags until completion.

A future UI can persist unfinished multipart state in IndexedDB to resume even after the browser is killed. v0 retries failed parts during the active session but does not yet persist an interrupted upload across page reloads.

## Progress conflict behavior

The progress object is stored separately from the large assets. The Worker returns its ETag. Subsequent writes use that version as a precondition. If another device has written newer progress, a stale write receives HTTP 412 instead of silently overwriting the newer position.

This is important for the "close PC, open phone" case: an old delayed PC write should not jump the phone back after it has already continued playback.

## Authentication

v0 is deliberately single-user:

- `AUTH_TOKEN` is a Worker secret.
- the token is entered once on each device and stored by the reader.
- JSON/upload requests send it as `Authorization: Bearer ...`.
- media playback uses a signed capability URL because native `<audio src>` requests cannot carry an arbitrary Authorization header.
- `ALLOWED_ORIGIN` restricts browser API access to the GitHub Pages origin and optional local development origin.

For a public/multi-user product, replace this with real account/session authentication before adding users.
