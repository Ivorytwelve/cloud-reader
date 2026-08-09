<script lang="ts">
  import { onMount } from 'svelte';
  import CloudManagerHeader from '$lib/cloud/cloud-manager-header.svelte';
  import { pxScreen } from '$lib/css-classes';
  import { formatPageTitle } from '$lib/functions/format-page-title';

  let CloudLibrary: any;

  onMount(async () => {
    // CloudLibrary integrates browser-only EPUB/Whispersync APIs. Keep that tree
    // completely outside SvelteKit SSR while retaining a tiny server-rendered shell.
    const module = await import('$lib/cloud/cloud-library.svelte');
    CloudLibrary = module.default;
  });
</script>

<svelte:head>
  <title>{formatPageTitle('Cloud Reader')}</title>
</svelte:head>

<div class="elevation-4 fixed inset-x-0 top-0 z-20">
  <CloudManagerHeader />
</div>

<main class="{pxScreen} h-dvh min-h-0 pt-12 xl:pt-10">
  {#if CloudLibrary}
    <svelte:component this={CloudLibrary} />
  {:else}
    <div class="flex h-full items-center justify-center text-sm opacity-50">Loading library…</div>
  {/if}
</main>
