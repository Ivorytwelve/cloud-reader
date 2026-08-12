<script lang="ts">
  import { onMount } from 'svelte';
  import {
    CLOUD_WRITE_RECOVERED_EVENT,
    CLOUD_WRITE_THROTTLED_EVENT,
    cloudWriteThrottleMessage,
    getCloudWriteThrottleState,
    type CloudWriteThrottleEventDetail
  } from './cloud-write-throttle';

  let visible = false;
  let message = '';
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  function show(text: string, duration: number) {
    message = text;
    visible = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      visible = false;
      hideTimer = undefined;
    }, duration);
  }

  onMount(() => {
    const active = getCloudWriteThrottleState();
    if (active) show(cloudWriteThrottleMessage(active), 5_000);

    const onThrottled = (event: Event) => {
      const detail = (event as CustomEvent<CloudWriteThrottleEventDetail>).detail;
      if (detail?.message) show(detail.message, 5_000);
    };
    const onRecovered = () => show('Cloud sync resumed.', 3_000);

    document.addEventListener(CLOUD_WRITE_THROTTLED_EVENT, onThrottled as EventListener);
    document.addEventListener(CLOUD_WRITE_RECOVERED_EVENT, onRecovered);

    return () => {
      if (hideTimer) clearTimeout(hideTimer);
      document.removeEventListener(CLOUD_WRITE_THROTTLED_EVENT, onThrottled as EventListener);
      document.removeEventListener(CLOUD_WRITE_RECOVERED_EVENT, onRecovered);
    };
  });
</script>

{#if visible}
  <div
    class="writing-horizontal-tb pointer-events-none fixed top-4 left-1/2 z-[100] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg bg-zinc-900/95 px-4 py-2.5 text-center text-sm text-white shadow-lg"
    role="status"
    aria-live="polite"
  >
    {message}
  </div>
{/if}
