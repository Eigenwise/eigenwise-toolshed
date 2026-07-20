<script lang="ts">
	import type { BoardState } from '../../state/board.svelte';
	import type { Story } from '../../types';
	import Button from '../ui/Button.svelte';
	import Select, { type SelectOption } from '../ui/Select.svelte';

	const colors = ['#d86b5b', '#d49a4a', '#789d49', '#4f9f9a', '#5d8fc7', '#836bc0', '#b66aa1', '#7c7c7c'];
	let { board, project, value = '', onchange }: { board: BoardState; project: string | null; value?: string; onchange: (storyId: string) => Promise<void> | void; } = $props();
	let creating = $state(false);
	let title = $state('');
	let color = $state<string | null>(null);
	let stories = $derived((project ? board.scopedStories.filter((story) => story.project === project || story.projectSlug === project) : []) as Story[]);
	let options = $derived<SelectOption[]>([{ value: '', label: 'No story' }, ...stories.map((story) => ({ value: story.id, label: `${story.ref ? `${story.ref} · ` : ''}${story.title}` })), ...(project ? [{ value: '__new', label: 'New story…' }] : [])]);

	async function select(storyId: string) {
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

<label><span>Story</span><Select label="Story" {value} {options} onchange={select} /></label>
{#if creating}
	<div class="new-story">
		<input aria-label="New story title" bind:value={title} placeholder="Story title" />
		<div class="colors" aria-label="Story color">
			{#each colors as choice (choice)}
				<button type="button" class:chosen={color === choice} style:background={choice} aria-label={`Use ${choice}`} onclick={() => color = choice}></button>
			{/each}
		</div>
		<div class="actions"><Button variant="primary" onclick={create}>Create story</Button><Button onclick={() => creating = false}>Cancel</Button></div>
	</div>
{/if}

<style>
	label { display:grid; gap:.3rem; } input { width:100%; padding:.55rem; border:1px solid var(--border); border-radius:calc(var(--radius) - .1rem); background:var(--surface-muted); color:var(--text); } .new-story { display:grid; gap:.5rem; margin-top:.5rem; padding:.65rem; border:1px solid var(--border); border-radius:var(--radius); background:var(--surface-muted); } .colors { display:flex; gap:.35rem; } .colors button { width:1.35rem; height:1.35rem; border:2px solid transparent; border-radius:50%; } .colors button.chosen { border-color:var(--text); box-shadow:var(--focus-ring); } .actions { display:flex; gap:.4rem; }
</style>
