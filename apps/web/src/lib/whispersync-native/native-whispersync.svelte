<script lang="ts">
  import { onMount } from 'svelte';
  import '$lib/whispersync-upstream/styles.css';

  export let currentBookId: number;

  let containerElement: HTMLDivElement;
  let bookContentElement: HTMLDivElement | undefined;
  let AudioBookMenu: any;
  let mounted = false;
  let loadError = '';

  onMount(() => {
    let cancelled = false;
    let timer: number | undefined;
    let removeCloudProgressEvents: (() => void) | undefined;
    let clearCloudAudiobookSession: (() => void) | undefined;
    let saveCloudAudiobookProgress:
      | ((force?: boolean) => Promise<void>)
      | undefined;

    const initialise = async () => {
      try {
        const [componentModule, bridgeModule, storesModule] = await Promise.all([
          import('$lib/whispersync-upstream/components/AudioBookMenu.svelte'),
          import('./cloud-bridge'),
          import('$lib/whispersync-upstream/lib/stores')
        ]);

        if (cancelled) return;

        AudioBookMenu = componentModule.default;
        clearCloudAudiobookSession = bridgeModule.clearCloudAudiobookSession;
        saveCloudAudiobookProgress = bridgeModule.saveCloudAudiobookProgress;
        removeCloudProgressEvents = bridgeModule.installCloudAudiobookProgressEvents();

        const findBookContent = () => {
          if (cancelled) return;
          const content = document.querySelector<HTMLDivElement>('.book-content');
          if (!content) {
            timer = window.setTimeout(findBookContent, 100);
            return;
          }

          bookContentElement = content;
          const root = document.documentElement;
          const contentStyle = getComputedStyle(content);
          const bodyStyle = getComputedStyle(document.body);
          root.style.setProperty('--ttu-whispersync-color', contentStyle.color || 'rgb(0, 0, 0)');
          root.style.setProperty(
            '--ttu-whispersync-background-color',
            bodyStyle.backgroundColor || 'transparent'
          );
          mounted = true;

          void bridgeModule.autoOpenCloudAudiobookForLocalBook(currentBookId).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            storesModule.lastError$.set(`Cloud audiobook failed: ${message}`);
          });
        };

        findBookContent();
      } catch (error) {
        if (cancelled) return;
        loadError = error instanceof Error ? error.message : String(error);
        console.error('Failed to initialise native Whispersync', error);
      }
    };

    void initialise();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);

      // SPA navigation does not necessarily trigger visibilitychange, so persist
      // the final audiobook position before clearing the cloud session.
      const savePromise = saveCloudAudiobookProgress?.(true);
      if (savePromise) void savePromise.catch(() => undefined);

      removeCloudProgressEvents?.();
      clearCloudAudiobookSession?.();
    };
  });
</script>

<div
  class="flex h-full items-center justify-center text-sm sm:text-lg"
  bind:this={containerElement}
  on:click|stopPropagation
  on:keyup|stopPropagation
  role="presentation"
  title={loadError || undefined}
>
  {#if mounted && AudioBookMenu && bookContentElement && currentBookId > 0}
    <svelte:component
      this={AudioBookMenu}
      componentContainerElement={containerElement}
      {bookContentElement}
      sandboxElement={undefined}
      {currentBookId}
    />
  {/if}
</div>
