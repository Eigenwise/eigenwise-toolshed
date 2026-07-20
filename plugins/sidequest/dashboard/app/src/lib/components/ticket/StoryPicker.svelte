<script lang="ts">
	import type { BoardState } from '../../state/board.svelte';
	import type { Story } from '../../types';

	const colors = ['#d86b5b', '#d49a4a', '#789d49', '#4f9f9a', '#5d8fc7', '#836bc0', '#b66aa1', '#7c7c7c'];
	let { board, project, value = '', onchange }: {
		board: BoardState;
		project: string | null;
		value?: string;
		onchange: (storyId: string) => Promise<void> | void;
	} = $props();
	let creating = $state(false);
	let title = $state('');
	let color = $state<string | null>(null);
	let stories = $derived((project ? board.scopedStories.filter((story) => story.project === project || story.projectSlug === project) : []) as Story[]);

	async function select(event: Event) {
		const storyId = (event.currentTarget as HTMLSelectElement).value;
		if (storyId === '__new') {
			creating = true;
			return;
		}
		await onchange(storyId);
	}

	async function create() {
		if (!project || !title.trim()) return;
		const story = await board.createStory({ project, title: title.trim(), ...(color ? { color } : {}) });
		title = '';
		color = null;
		creating = false;
		await onchange(story.id);
	}
</script>

<label>
	<span>Story</span>
	<select aria-label="Story" value={value} onchange={select}>
		<option value="">No story</option>
		{#each stories as story (story.id)}
			<option value={story.id}>{story.ref ? `${story.ref} · ` : ''}{story.title}</option>
		{/each}
		{#if project}<option value="__new">New story…</option>{/if}
	</select>
</label>
{#if creating}
	<div class="new-story">
		<input aria-label="New story title" bind:value={title} placeholder="Story title" />
		<div class="colors" aria-label="Story color">
			{#each colors as choice (choice)}
				<button type="button" class:chosen={color === choice} style:background={choice} aria-label={`Use ${choice}`} onclick={() => color = choice}></button>
			{/each}
		</div>
		<button type="button" onclick={create}>Create story</button>
		<button type="button" onclick={() => creating = false}>Cancel</button>
	</div>
{/if}

<style>
	label { display:grid; gap:.3rem; } select, input { width:100%; padding:.55rem; border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); color:var(--text); }
	.new-story { display:grid; gap:.5rem; margin-top:.5rem; padding:.65rem; background:var(--surface-muted); border-radius:var(--radius); }
	.colors { display:flex; gap:.35rem; } .colors button { width:1.25rem; height:1.25rem; border-radius:50%; border:2px solid transparent; } .colors button.chosen { border-color:var(--text); }
</style>
