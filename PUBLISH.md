# Publish to GitHub Pages

Create an empty GitHub repository, then run these commands from this folder:

```bash
git init
git add .
git commit -m "Initial Cloud Reader release"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

Then open the repository on GitHub:

**Settings → Pages → Build and deployment → Source → GitHub Actions**

The included `.github/workflows/pages.yml` workflow builds and deploys the site automatically.

The repository can have any name. The workflow detects it and configures the SvelteKit base path automatically.

Examples:

- repository `cloud-reader` → `https://YOUR_USERNAME.github.io/cloud-reader/`
- repository `reader` → `https://YOUR_USERNAME.github.io/reader/`
- repository `YOUR_USERNAME.github.io` → `https://YOUR_USERNAME.github.io/`

After the frontend is online, make sure your Cloudflare Worker allows:

```text
https://YOUR_USERNAME.github.io
```

as an origin, then deploy the Worker again if you changed `ALLOWED_ORIGIN`.
