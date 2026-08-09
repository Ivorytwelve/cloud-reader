# Cloud Reader

A cloud-first fork of Ttsu Reader with integrated audiobook/subtitle synchronization.

Cloud Reader keeps the library, reading/audio progress, alignment data and statistics in your own Cloudflare R2-backed Worker, while the frontend can be hosted as a static GitHub Pages site.

## Features

- Cloud library with EPUB, audiobook, subtitles and cover storage
- Native Whispersync-style audiobook/subtitle integration
- Exact reader + audiobook progress sync between devices
- Cloud-synced reading/listening statistics
- Automatic EPUB/subtitle alignment
- Reading history
- Import/export of Cloud Reader connection settings
- Private R2 bucket with signed media URLs and HTTP Range streaming
- Storage/rate quota guard

## Run locally

Requirements:

- Node.js 24
- pnpm 11

Install dependencies:

```bash
pnpm install
```

Copy:

```text
cloud-worker/.dev.vars.example
```

to:

```text
cloud-worker/.dev.vars
```

and fill in a local `AUTH_TOKEN` and `SIGNING_KEY`.

On Windows you can then run:

```text
START-LOCAL-DEV.bat
```

Or start the two processes manually:

```bash
pnpm dev
```

and, in another terminal:

```bash
cd cloud-worker
npx wrangler dev --port 8787
```

Use `http://localhost:8787` as the Worker URL in Cloud Reader while developing locally.

## Deploy the frontend to GitHub Pages

This repository already contains a GitHub Pages workflow.

1. Create a new empty GitHub repository. It can be named `cloud-reader` or anything else.
2. Push the contents of this folder to the repository's `main` branch.
3. On GitHub open **Settings → Pages**.
4. Under **Build and deployment**, choose **GitHub Actions** as the source.
5. Open the **Actions** tab and wait for **Deploy Cloud Reader to GitHub Pages** to finish.

The workflow automatically detects the repository name and builds with the correct SvelteKit base path. For a repository named `cloud-reader`, the site will normally be:

```text
https://YOUR_USERNAME.github.io/cloud-reader/
```

No Worker secrets are stored in the frontend repository.

## Deploy your Cloudflare Worker

The app contains a short expandable setup guide under **Settings → Cloud**.

The Worker source is in `cloud-worker/`. Start from:

```text
cloud-worker/wrangler.toml.example
```

Create your own `cloud-worker/wrangler.toml`, configure your R2 bucket, and set the Worker secrets:

```bash
npx wrangler secret put AUTH_TOKEN
npx wrangler secret put SIGNING_KEY
```

Then deploy:

```bash
cd cloud-worker
npx wrangler deploy
```

`ALLOWED_ORIGIN` only needs the web origin, not the repository path. For example:

```toml
ALLOWED_ORIGIN = "https://YOUR_USERNAME.github.io,http://localhost:5173"
```

Do not commit `cloud-worker/.dev.vars`, `cloud-worker/wrangler.toml`, `AUTH_TOKEN`, or `SIGNING_KEY`.

## Build locally

```bash
pnpm build
```

The static frontend output is generated in:

```text
apps/web/build
```

## Credits and license

Cloud Reader is based on Ttsu Reader and retains its BSD 3-Clause license.

The integrated Whispersync code is derived from `ttu-whispersync`; its license is preserved at:

```text
apps/web/src/lib/whispersync-upstream/LICENSE.ttu-whispersync
```
