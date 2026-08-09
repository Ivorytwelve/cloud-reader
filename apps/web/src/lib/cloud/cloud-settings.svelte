<script lang="ts">
  import { onMount } from 'svelte';
  import Fa from 'svelte-fa';
  import { faCloud, faFileExport, faFileImport, faLink, faLinkSlash } from '@fortawesome/free-solid-svg-icons';
  import { inputClasses } from '$lib/css-classes';
  import { TtsuCloudApi } from './api';
  import { clearCloudConfig, loadCloudConfig, saveCloudConfig } from './config';
  import { clearCloudProgressSession } from './progress-session';

  let workerUrl = '';
  let token = '';
  let connected = false;
  let configured = false;
  let checking = false;
  let status = '';
  let error = '';
  let bookCount = 0;
  let usedBytes = 0;
  let maxBytes = 0;
  let importInput: HTMLInputElement;

  onMount(() => {
    const config = loadCloudConfig();
    if (!config) return;
    configured = true;
    workerUrl = config.workerUrl;
    token = config.token;
    void testConnection(false);
  });

  async function saveAndConnect() {
    error = '';
    const url = workerUrl.trim().replace(/\/+$/, '');
    if (!url || !token) {
      error = 'Worker URL and access token are required.';
      return;
    }

    workerUrl = url;
    await testConnection(true);
  }

  async function testConnection(saveOnSuccess: boolean) {
    if (!workerUrl.trim() || !token || checking) return;
    checking = true;
    error = '';
    status = 'Checking connection…';

    try {
      const api = new TtsuCloudApi({ baseUrl: workerUrl.trim().replace(/\/+$/, ''), token });
      const [library, quota] = await Promise.all([api.getLibrary(), api.getQuota()]);
      connected = true;
      bookCount = library.books.length;
      usedBytes = quota.usedBytes;
      maxBytes = quota.maxBytes;
      status = 'Connected';

      if (saveOnSuccess) {
        saveCloudConfig({ workerUrl: workerUrl.trim().replace(/\/+$/, ''), token });
        clearCloudProgressSession();
        configured = true;
      }
    } catch (caught) {
      connected = false;
      status = '';
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      checking = false;
    }
  }

  function disconnect() {
    clearCloudConfig();
    clearCloudProgressSession();
    connected = false;
    configured = false;
    status = '';
    error = '';
    bookCount = 0;
    usedBytes = 0;
    maxBytes = 0;
    token = '';
  }

  function exportConnectionFile() {
    const url = workerUrl.trim().replace(/\/+$/, '');
    if (!url || !token) {
      error = 'Enter a Worker URL and access token before exporting.';
      return;
    }
    const payload = {
      type: 'cloud-reader-connection',
      version: 1,
      workerUrl: url,
      token
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = 'cloud-reader-connection.json';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  async function importConnectionFile(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    error = '';
    try {
      const payload = JSON.parse(await file.text()) as {
        type?: string;
        version?: number;
        workerUrl?: string;
        token?: string;
      };
      if (payload.type !== 'cloud-reader-connection' || payload.version !== 1) {
        throw new Error('This is not a Cloud Reader connection file.');
      }
      const importedUrl = String(payload.workerUrl || '').trim().replace(/\/+$/, '');
      const importedToken = String(payload.token || '');
      if (!importedUrl || !importedToken) throw new Error('The connection file is incomplete.');
      workerUrl = importedUrl;
      token = importedToken;
      await testConnection(true);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (importInput) importInput.value = '';
    }
  }

  function formatBytes(bytes: number) {
    if (!bytes) return '0 GB';
    if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(bytes >= 10_000_000_000 ? 0 : 1)} GB`;
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
    return `${Math.ceil(bytes / 1000)} KB`;
  }
</script>

<div class="rounded-2xl border border-[#90CAF9]/70 bg-white/35 p-4">
  <div class="mb-4 flex items-center gap-2">
    <Fa icon={faCloud} />
    <div>
      <div class="font-semibold">Cloud library</div>
      <div class="text-xs opacity-55">Connection details are stored only on this device.</div>
    </div>
  </div>

  <div class="grid gap-3 lg:grid-cols-2">
    <label class="text-sm">
      <span class="mb-1 block text-xs opacity-65">Cloudflare Worker URL</span>
      <input class={inputClasses} placeholder="https://your-worker.workers.dev" bind:value={workerUrl} />
    </label>

    <label class="text-sm">
      <span class="mb-1 block text-xs opacity-65">Access token</span>
      <input class={inputClasses} type="password" autocomplete="off" bind:value={token} />
    </label>
  </div>

  <div class="mt-4 flex flex-wrap items-center gap-2">
    <button
      class="flex items-center gap-2 rounded-xl bg-[#2196F3] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#0D47A1] disabled:opacity-50"
      on:click={() => void saveAndConnect()}
      disabled={checking}
    >
      <Fa icon={faLink} />
      {checking ? 'Checking…' : 'Save & connect'}
    </button>

    {#if connected || configured}
      <button
        class="flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition hover:bg-white/70"
        on:click={disconnect}
        disabled={checking}
      >
        <Fa icon={faLinkSlash} />
        Disconnect
      </button>
    {/if}

    <button
      class="flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition hover:bg-white/70"
      on:click={exportConnectionFile}
      title="Export Worker URL and access token to a small JSON file"
    >
      <Fa icon={faFileExport} />
      Export connection
    </button>
    <button
      class="flex items-center gap-2 rounded-xl px-3 py-2 text-sm transition hover:bg-white/70"
      on:click={() => importInput?.click()}
    >
      <Fa icon={faFileImport} />
      Import connection
    </button>
    <input
      class="hidden"
      type="file"
      accept="application/json,.json"
      bind:this={importInput}
      on:change={importConnectionFile}
    />

    {#if connected}
      <span class="text-xs opacity-60">{bookCount} books · {formatBytes(usedBytes)} / {formatBytes(maxBytes)}</span>
    {/if}
  </div>

  {#if error}
    <div class="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</div>
  {:else if status}
    <div class="mt-3 text-sm opacity-60">{status}</div>
  {/if}
</div>


<details class="mt-4 overflow-hidden rounded-2xl border border-[#90CAF9]/70 bg-white/25">
  <summary class="cursor-pointer select-none px-4 py-3 text-sm font-semibold hover:bg-white/35">
    Set up your Cloudflare Worker + R2
  </summary>
  <div class="border-t border-[#90CAF9]/50 px-4 py-4 text-sm">
    <p class="mb-3 opacity-70">One-time setup. The R2 bucket stays private; the Worker is the authenticated gateway used by Cloud Reader.</p>
    <ol class="list-decimal space-y-3 pl-5">
      <li>Enable <b>R2</b> in the Cloudflare dashboard. You may be asked to activate R2/add billing details even when staying inside the free allowance.</li>
      <li>Open a terminal in <code>cloud-worker</code>, then run <code>npm install</code> and <code>npx wrangler login</code>.</li>
      <li>Create the private bucket with <code>npx wrangler r2 bucket create ttu-library</code>.</li>
      <li>Copy <code>wrangler.toml.example</code> to <code>wrangler.toml</code>. Set <code>ALLOWED_ORIGIN</code> to your GitHub Pages origin and keep <code>http://localhost:5173</code> while developing.</li>
      <li>Generate two random secrets, for example with <code>node -e &quot;console.log(require('crypto').randomBytes(32).toString('hex'))&quot;</code>.</li>
      <li>Store them with <code>npx wrangler secret put AUTH_TOKEN</code> and <code>npx wrangler secret put SIGNING_KEY</code>. Save the AUTH_TOKEN somewhere safe; the reader never needs the signing key.</li>
      <li>Deploy with <code>npx wrangler deploy</code>. Paste the resulting <code>workers.dev</code> URL and your AUTH_TOKEN above, then choose <b>Save &amp; connect</b>.</li>
    </ol>
    <div class="mt-4 rounded-xl bg-[#90CAF9]/20 px-3 py-2 text-xs opacity-75">
      The exported connection file contains your AUTH_TOKEN in plain text. Treat that file like a password. The Worker enforces the library storage cap; keep the R2 bucket itself private.
    </div>
  </div>
</details>
