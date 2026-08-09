<script lang="ts">
	import ActionButtonList from './ActionButtonList.svelte';
	import { Action, executeAction } from '../lib/actions';
	import type { MouseEventWithElement, PointerEventWithElement, Subtitle } from '../lib/general';
	import { SubtitleActionsVisibility } from '../lib/settings';
	import {
		activeSubtitle$,
		currentSubtitles$,
		currentTime$,
		isMobile$,
		isRecording$,
		settings$,
	} from '../lib/stores';
	import { onDestroy, tick } from 'svelte';

	export let subtitles: Subtitle[];
	export let skipUpdates = false;

	const {
		subtitlesEnableAutoScroll$,
		subtitlePreventActionOnSelection$,
		subtitlesCopyFontFamily$,
		subtitlesCopyFontSize$,
		subtitlesCopyLineHeight$,
		subtitlesFontFamily$,
		subtitlesFontSize$,
		subtitlesLineHeight$,
		subtitlesClickAction$,
		subtitlesActionsVisibility$,
		subtitlesActionsVisibilityTime$,
		actionListOfSubtitles$,
	} = settings$;

	const font = $subtitlesCopyFontFamily$
		? window.localStorage.getItem('fontFamilyGroupOne') || 'Noto Serif JP'
		: $subtitlesFontFamily$;
	const fontSize = $subtitlesCopyFontSize$
		? Number.parseInt(window.localStorage.getItem('fontSize') || '16', 10)
		: $subtitlesFontSize$;
	const lineHeight = $subtitlesCopyLineHeight$
		? Number.parseFloat(window.localStorage.getItem('lineHeight') || '1.65')
		: $subtitlesLineHeight$;

	let listElement: HTMLDivElement;
	let subtitleInteractionTimer: number | undefined;
	let manualScrollTimer: number | undefined;
	let manualScrollActive = false;
	let hoveredIndex = -1;
	let toggledIndex = -1;
	let subtitleIndexById = new Map<string, number>();

	$: if (subtitles) {
		subtitleIndexById = new Map(subtitles.map((subtitle, index) => [subtitle.id, index]));
	}

	$: if ($activeSubtitle$) {
		scrollToSubtitle();
	}

	onDestroy(() => {
		clearTimeout(subtitleInteractionTimer);
		clearTimeout(manualScrollTimer);
	});

	export async function onResetList(..._args: any[]) {
		await tick();
		await scrollToSubtitle(true);
	}

	export async function scrollToSubtitle(force = false) {
		if (
			$isRecording$ ||
			!listElement ||
			!subtitles.length ||
			(!force &&
				(manualScrollActive ||
					!$subtitlesEnableAutoScroll$ ||
					(!$activeSubtitle$.previous && !$activeSubtitle$.current && !$activeSubtitle$.useTimeFallback)))
		) {
			return;
		}

		const { previous, current, useTimeFallback } = $activeSubtitle$;
		let subtitleIndex = -1;

		if (current && $currentSubtitles$.has(current)) {
			subtitleIndex = subtitleIndexById.get(current) ?? -1;
		} else if (previous && $currentSubtitles$.has(previous)) {
			subtitleIndex = subtitleIndexById.get(previous) ?? -1;
		}

		if (subtitleIndex === -1 && (force || useTimeFallback)) {
			subtitleIndex = findSubtitleIndexAtTime($currentTime$);
		}

		if (subtitleIndex < 0) return;

		await tick();
		const row = listElement.querySelector<HTMLElement>(`[data-index="${subtitleIndex}"]`);
		if (!row) return;

		const listRect = listElement.getBoundingClientRect();
		const rowRect = row.getBoundingClientRect();
		const margin = Math.min(80, listRect.height * 0.18);
		const comfortablyVisible =
			rowRect.top >= listRect.top + margin && rowRect.bottom <= listRect.bottom - margin;

		if (!comfortablyVisible || force) {
			row.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
		}
	}

	function findSubtitleIndexAtTime(seconds: number) {
		if (!subtitles.length || !seconds) return 0;
		let low = 0;
		let high = subtitles.length - 1;
		let result = 0;
		while (low <= high) {
			const middle = (low + high) >> 1;
			if (subtitles[middle].startSeconds <= seconds) {
				result = middle;
				low = middle + 1;
			} else {
				high = middle - 1;
			}
		}
		return result;
	}

	function markManualScroll() {
		manualScrollActive = true;
		clearTimeout(manualScrollTimer);
		manualScrollTimer = window.setTimeout(() => {
			manualScrollActive = false;
		}, 3000);
	}

	function shouldRenderActions(index: number) {
		switch ($subtitlesActionsVisibility$) {
			case SubtitleActionsVisibility.ALWAYS:
				return true;
			case SubtitleActionsVisibility.HOVER:
				return hoveredIndex === index;
			case SubtitleActionsVisibility.TOGGLE:
				return toggledIndex === index;
			default:
				return false;
		}
	}

	function onSubtitleClick(event: MouseEventWithElement<HTMLDivElement>) {
		if (
			event.button !== 0 ||
			$subtitlesClickAction$ === Action.NONE ||
			$subtitlesActionsVisibility$ === SubtitleActionsVisibility.TOGGLE ||
			hasSelection()
		) {
			return;
		}

		clearSubtitleEvents();
		executeAction(
			$subtitlesClickAction$,
			subtitles[Number.parseInt(event.currentTarget.parentElement!.dataset.index!, 10)],
		);
	}

	function onSubtitlePointerDown(event: PointerEventWithElement<HTMLDivElement>) {
		if (event.button !== 0 || $subtitlesActionsVisibility$ !== SubtitleActionsVisibility.TOGGLE) return;

		if ($subtitlePreventActionOnSelection$ && $isMobile$) {
			window.getSelection()?.removeAllRanges();
			document.body.style.userSelect = 'none';
		}

		const { currentTarget } = event;
		const index = Number.parseInt(currentTarget.parentElement!.dataset.index!, 10);
		currentTarget.addEventListener('pointerup', onSubtitlePointerUp, false);
		subtitleInteractionTimer = window.setTimeout(() => {
			clearSubtitleEvents(currentTarget);
			if (!hasSelection()) toggledIndex = toggledIndex === index ? -1 : index;
		}, $subtitlesActionsVisibilityTime$);
	}

	function onSubtitlePointerUp(this: HTMLDivElement) {
		clearSubtitleEvents(this);
		if (hasSelection()) return;
		executeAction($subtitlesClickAction$, subtitles[Number.parseInt(this.parentElement!.dataset.index!, 10)]);
	}

	function hasSelection() {
		if (!$subtitlePreventActionOnSelection$) return false;
		return !!window.getSelection()?.toString().trim();
	}

	function clearSubtitleEvents(element?: HTMLDivElement) {
		clearTimeout(subtitleInteractionTimer);
		element?.removeEventListener('pointerup', onSubtitlePointerUp, false);
		document.body.style.userSelect = 'auto';
	}
</script>

<div
	class="ttu-whispersync-container subtitle-container native-subtitle-list flex-1 min-h-0 w-full"
	style={`overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; overscroll-behavior: contain; font-family: "${font}", "Lora", "Noto Serif JP", serif; font-size: ${fontSize}px; line-height: ${lineHeight};`}
	bind:this={listElement}
	on:wheel={markManualScroll}
	on:touchmove={markManualScroll}
	on:scroll={markManualScroll}
>
	{#each subtitles as subtitle, index (subtitle.id)}
		<div
			class="subtitle-native-row flex items-center sub"
			class:active={$activeSubtitle$.current === subtitle.id}
			class:on-hover={$subtitlesActionsVisibility$ === SubtitleActionsVisibility.HOVER}
			data-index={index}
			on:mouseenter={() => (hoveredIndex = index)}
			on:mouseleave={() => {
				if (hoveredIndex === index) hoveredIndex = -1;
			}}
		>
			<div
				tabindex="0"
				role="button"
				class="flex-1 p-b"
				class:cursor-not-allowed={$isRecording$}
				title={$isRecording$ ? 'Recording in progress' : null}
				on:click={onSubtitleClick}
				on:pointerdown={onSubtitlePointerDown}
				on:keyup={() => {}}
			>
				{subtitle.text}
			</div>

			{#if shouldRenderActions(index)}
				<div
					class="flex m-x-xs m-y-b sub-action"
					class:hidden={$subtitlesActionsVisibility$ === SubtitleActionsVisibility.HIDDEN}
				>
					<div class="grid">
						<ActionButtonList
							hideCancelAction
							listItems={$actionListOfSubtitles$}
							{subtitle}
							{skipUpdates}
						/>
					</div>
				</div>
			{/if}
		</div>
	{/each}
</div>

<style>
	/* Let the browser skip paint/layout work for rows far outside the viewport.
	 * Unlike JS virtualization, every subtitle remains part of the native scroll
	 * range, so there is no calculated end-of-list that can become incorrect. */
	.subtitle-native-row {
		content-visibility: auto;
		contain-intrinsic-size: auto 96px;
		contain: layout paint style;
	}

	.native-subtitle-list {
		min-height: 0;
		max-height: 100%;
	}
</style>
