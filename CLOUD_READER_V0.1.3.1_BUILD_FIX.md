# Cloud Reader v0.1.3.1 build fix

Fixes the Svelte 4 parse error in `cloud-statistics-editor.svelte`.

The TypeScript casts that were placed directly inside Svelte template
expressions are now performed in a typed `inputValue(event)` helper in
the `<script lang="ts">` block.

No Worker changes.
