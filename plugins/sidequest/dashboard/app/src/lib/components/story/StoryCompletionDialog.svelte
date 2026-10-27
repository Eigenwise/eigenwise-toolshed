<script lang="ts">
	import type { BoardState } from '../../state/board.svelte';
	import Button from '../ui/Button.svelte';
	import Dialog from '../ui/Dialog.svelte';
	import StoryCompletionPanel from './StoryCompletionPanel.svelte';

	let { state: board }: { state: BoardState } = $props();
	let story = $derived(board.storyCompletionId ? board.raw?.stories.find((item) => item.id === board.storyCompletionId) ?? null : null);
</script>

<Dialog open={Boolean(board.storyCompletionId)} label={story ? `${story.ref ?? story.title} completion` : 'Story completion'} onclose={() => board.closeStoryCompletion()}>
	{#if board.storyCompletionId}
		<div class="story-completion">
			<header><h2>{story?.ref ?? 'Story'} · {story?.title ?? ''}</h2><Button variant="quiet" onclick={() => board.closeStoryCompletion()}>Close</Button></header>
			<StoryCompletionPanel read={board.storyCompletion} />
		</div>
	{/if}
</Dialog>

<style>
	.story-completion { display:grid; align-content:start; gap:1rem; padding:1.25rem; max-block-size:inherit; overflow:auto; } header { display:flex; justify-content:space-between; align-items:start; gap:1rem; } h2 { margin:0; font-family:var(--font-serif); font-size:1.2rem; line-height:1.15; }
</style>
