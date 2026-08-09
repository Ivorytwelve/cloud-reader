<script lang="ts">
  import { faPen, faTrash } from '@fortawesome/free-solid-svg-icons';
  import type { ToggleOption } from '$lib/components/button-toggle-group/toggle-option';
  import Ripple from '$lib/components/ripple.svelte';
  import { availableThemes } from '$lib/data/theme-option';
  import { createEventDispatcher } from 'svelte';
  import Fa from 'svelte-fa';

  export let options: ToggleOption<any>[];
  export let selectedOptionId: any;
  export let invertColors = false;

  const dispatch = createEventDispatcher<{
    edit: string;
    delete: string;
  }>();

  function mapToStyleString(style: Record<string, any> | undefined) {
    if (!style) return '';

    return Object.entries(style)
      .map(([key, value]) => `${key}: ${value}`)
      .join(';');
  }

  function isThemePreview(option: ToggleOption<any>) {
    return Boolean(option.style);
  }
</script>

<div class="-m-1 flex flex-wrap gap-y-1">
  {#each options as option}
    <div class="flex items-center">
      <button
        title={option.id}
        class="m-1 overflow-hidden rounded-xl border-2 border-gray-400 p-2 text-lg text-black transition-all"
        class:min-h-[48px]={isThemePreview(option)}
        class:min-w-[58px]={isThemePreview(option)}
        class:px-3={isThemePreview(option)}
        class:shadow-sm={isThemePreview(option)}
        class:ttu-theme-preview={isThemePreview(option)}
        class:ttu-theme-preview--selected={isThemePreview(option) && option.id === selectedOptionId}
        class:ttu-theme-preview--unselected={isThemePreview(option) && option.id !== selectedOptionId}
        class:border-4={option.thickBorders && option.id === selectedOptionId}
        class:border-blue-300={option.id === selectedOptionId}
        class:bg-gray-700={!isThemePreview(option) && option.id === selectedOptionId}
        class:text-white={!isThemePreview(option) && ((option.id === selectedOptionId && !invertColors) ||
          (option.id !== selectedOptionId && invertColors))}
        class:bg-white={!isThemePreview(option) && ((option.id === selectedOptionId && invertColors) ||
          (option.id !== selectedOptionId && !invertColors))}
        style={mapToStyleString(option.style)}
        on:click={() => (selectedOptionId = option.id)}
      >
        {option.text}
        <Ripple />
      </button>
      {#if option.showIcons && option.id === selectedOptionId && !availableThemes.has(option.id)}
        <div class="mr-2 ml-1 flex flex-col justify-around gap-1">
          <button class="rounded-lg p-1.5 hover:bg-white" on:click={() => dispatch('edit', option.id)}>
            <Fa icon={faPen} slot="icon" />
          </button>
          <button class="rounded-lg p-1.5 hover:bg-white" on:click={() => dispatch('delete', option.id)}>
            <Fa icon={faTrash} slot="icon" />
          </button>
        </div>
      {/if}
    </div>
  {/each}

  <slot />
</div>
