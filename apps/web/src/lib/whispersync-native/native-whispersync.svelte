<script lang="ts">
  import { onMount } from 'svelte';
  import { listeningAudioAvailable$, listeningSessionReady$ } from '$lib/listening-mode/session-state';
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
    let removeReadyListener: (() => void) | undefined;
    let removeAudioAvailabilitySubscriptions: (() => void) | undefined;

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

        // Keep the page shell informed without importing the large Whispersync
        // store module during SSR. This also tracks a locally selected audio file,
        // not only cloud audio.
        let audioLoaded = false;
        let audioSourceUrl = '';
        const publishAudioAvailability = () =>
          listeningAudioAvailable$.set(Boolean(audioLoaded || audioSourceUrl));
        const unsubscribeAudioLoaded = storesModule.currentAudioLoaded$.subscribe((value) => {
          audioLoaded = value;
          publishAudioAvailability();
        });
        const unsubscribeAudioSource = storesModule.currentAudioSourceUrl$.subscribe((value) => {
          audioSourceUrl = value;
          publishAudioAvailability();
        });
        removeAudioAvailabilitySubscriptions = () => {
          unsubscribeAudioLoaded();
          unsubscribeAudioSource();
          listeningAudioAvailable$.set(false);
        };

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
          let cloudOpened = false;
          const onWhispersyncReady = (event: Event) => {
            const detail = (event as CustomEvent<{ localBookId?: number }>).detail;
            if (cloudOpened || detail?.localBookId !== currentBookId) return;
            cloudOpened = true;
            document.removeEventListener('ttu-cloud:whispersync-ready', onWhispersyncReady);

            void bridgeModule.autoOpenCloudAudiobookForLocalBook(currentBookId)
              .catch((error) => {
                const message = error instanceof Error ? error.message : String(error);
                storesModule.lastError$.set(`Cloud audiobook failed: ${message}`);
              })
              .finally(() => {
                if (!cancelled) listeningSessionReady$.set({ localBookId: currentBookId });
              });
          };

          // Register before mounting: AudioBookMenu emits this only after its own
          // database/subtitle initialization is completely finished.
          document.addEventListener('ttu-cloud:whispersync-ready', onWhispersyncReady);
          removeReadyListener = () =>
            document.removeEventListener('ttu-cloud:whispersync-ready', onWhispersyncReady);
          mounted = true;
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
      listeningSessionReady$.set(undefined);
      if (timer) window.clearTimeout(timer);

      // SPA navigation does not necessarily trigger visibilitychange, so persist
      // the final audiobook position before clearing the cloud session.
      const savePromise = saveCloudAudiobookProgress?.(true);
      if (savePromise) void savePromise.catch(() => undefined);

      removeReadyListener?.();
      removeAudioAvailabilitySubscriptions?.();
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
      cloudOnly={true}
    />
  {/if}
</div>
