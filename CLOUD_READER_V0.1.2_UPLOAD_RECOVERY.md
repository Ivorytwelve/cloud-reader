# Cloud Reader v0.1.2 — upload recovery + local EPUB identity fix

## Fixed

- Cloud EPUBs no longer have to use exactly the same display title as the EPUB's internal `dc:title`.
  Cloud Reader identifies the actual IndexedDB record changed by Ttsu's import and only falls back to normalized-title matching.
- Multipart requests now have finite timeouts and existing per-part retries no longer wait forever on a dead fetch.
- Uploads can be stopped from the upload dialog.
- Failed uploads keep their selected files and expose `Retry upload`.
- Upload errors are visible inside the upload dialog.
- Every supplied asset is verified in the cloud manifest after upload before the book is considered complete.
- Added `Clear stuck upload` next to a non-zero idle reservation in the library footer. It aborts incomplete multipart uploads and releases their quota reservations, without deleting already committed objects.
- Default abandoned multipart reservation TTL is reduced from 24 hours to 30 minutes of inactivity.

## Worker deployment

This patch changes Worker code. Deploy the updated Worker after applying the patch.

If your real `cloud-worker/wrangler.toml` still contains:

    MULTIPART_RESERVATION_TTL_SECONDS = "86400"

change it to:

    MULTIPART_RESERVATION_TTL_SECONDS = "1800"

The manual `Clear stuck upload` action works immediately even before the TTL expires.
