# Cloud Reader v0.1.3

## Library shelves
- Library and Reading history are independent horizontal scrollers.
- Their headings remain fixed.
- Horizontal scrollbars stay hidden.
- Edge fades remain independent for each shelf.

## Add / drag and drop
- The Add dialog now has one drag-and-drop / multi-file picker.
- EPUB, audiobook and subtitle files are detected automatically by extension/MIME.
- EPUB metadata/cover inspection still runs automatically.
- Dropping another supported file replaces that file type.

## Statistics
- Restores a Statistics button in the Cloud Reader top bar.
- Existing Ttsu Statistics visualization is retained and fed from cloud aggregates.
- Adds a cloud-data editor (pencil icon in Statistics) for per-book/per-day time and character totals.
- Cloud entries can be edited or deleted.
- Manual corrections are stored as cloud adjustments, so future reading adds normally.
- Local IndexedDB statistics are display/cache only; cloud is canonical.
- Local-only Delete Selection/Delete All controls were removed to avoid misleading cloud users.
- Statistics settings now explain which controls affect cloud audiobook tracking vs classic ebook-only Ttsu tracking.

## Worker
- Adds PUT/DELETE /v1/stats/entry/:bookId/:date for canonical aggregate corrections.
