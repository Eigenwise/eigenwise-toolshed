<script lang="ts">
	import type { BoardState } from '../../state/board.svelte';
	import type { Ticket } from '../../types';
	import { renderMarkdown } from './markdown';
	import Button from '../ui/Button.svelte';

	let { board, ticket }: { board: BoardState; ticket: Ticket } = $props();
	let body = $state('');
	let comments = $derived((ticket.comments as { id?: string; by?: string; at?: string; body?: string }[] | undefined) ?? []);

	async function post() { if (!body.trim()) return; await board.addComment(ticket, body.trim()); body = ''; }
</script>

<section class="comments">
	<h3>Comments</h3>
	{#if comments.length}
		<div class="thread">
			{#each comments as comment, index (comment.id ?? `${comment.at}-${index}`)}
				<article><header><strong>{comment.by ?? 'Unknown'}</strong><time>{comment.at ? new Date(comment.at).toLocaleString() : ''}</time></header><div class="markdown">{@html renderMarkdown(comment.body)}</div></article>
			{/each}
		</div>
	{:else}<p class="empty">No comments yet.</p>{/if}
	<textarea bind:value={body} placeholder="Add a comment" aria-label="Add a comment"></textarea>
	<div class="actions"><Button variant="primary" disabled={!body.trim()} onclick={post}>Add comment</Button></div>
</section>

<style>
	.comments { margin:0; } h3 { margin:0 0 .55rem; font-size:.82rem; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); } .thread { display:grid; gap:.5rem; max-height:18rem; overflow:auto; scrollbar-width:thin; scrollbar-color:var(--border) transparent; } article { padding:.65rem; border:1px solid var(--border); border-radius:calc(var(--radius) - .1rem); background:color-mix(in srgb, var(--surface) 72%, transparent); } article header { display:flex; justify-content:space-between; gap:.5rem; font-size:.76rem; color:var(--text-muted); } article header strong { color:var(--text); } textarea { box-sizing:border-box; width:100%; min-height:4rem; margin-top:.6rem; padding:.55rem; border:1px solid var(--border); border-radius:calc(var(--radius) - .1rem); background:var(--surface); color:var(--text); } .actions { display:flex; gap:.4rem; margin-top:.45rem; } .empty { color:var(--text-muted); font-size:.84rem; } .markdown :global(p) { margin:.35rem 0 0; } .markdown :global(pre) { overflow:auto; }
</style>
