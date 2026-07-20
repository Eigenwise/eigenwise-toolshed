<script lang="ts">
	import type { BoardState } from '../../state/board.svelte';
	import type { Ticket } from '../../types';
	import { renderMarkdown } from './markdown';

	let { board, ticket }: { board: BoardState; ticket: Ticket } = $props();
	let body = $state('');
	let comments = $derived((ticket.comments as { id?: string; by?: string; at?: string; body?: string; kind?: string }[] | undefined) ?? []);

	async function post() {
		if (!body.trim()) return;
		await board.addComment(ticket, body.trim());
		body = '';
	}
</script>

<section class="comments">
	<h3>Comments</h3>
	{#if comments.length}
		<div class="thread">
			{#each comments as comment, index (comment.id ?? `${comment.at}-${index}`)}
				<article>
					<header><strong>Comment</strong><span>{comment.by ?? 'unknown'} · {comment.at ? new Date(comment.at).toLocaleString() : ''}</span></header>
					<div class="markdown">{@html renderMarkdown(comment.body)}</div>
				</article>
			{/each}
		</div>
	{:else}<p class="empty">No comments yet.</p>{/if}
	<textarea bind:value={body} placeholder="Add a comment" aria-label="Add a comment"></textarea>
	<div class="actions"><button type="button" onclick={post}>Comment</button></div>
</section>

<style>
	.comments { margin-top:1rem; } h3 { margin:0 0 .4rem; font-size:.9rem; } .thread { display:grid; gap:.5rem; max-height:18rem; overflow:auto; } article { padding:.6rem; border:1px solid var(--border); border-radius:var(--radius); } article header { display:flex; justify-content:space-between; gap:.5rem; font-size:.8rem; color:var(--text-muted); } article header strong { color:var(--text); } textarea { box-sizing:border-box; width:100%; min-height:4rem; margin-top:.6rem; padding:.55rem; border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); color:var(--text); } .actions { display:flex; gap:.4rem; margin-top:.4rem; } .empty { color:var(--text-muted); } .markdown :global(p) { margin:.35rem 0 0; } .markdown :global(pre) { overflow:auto; }
</style>
