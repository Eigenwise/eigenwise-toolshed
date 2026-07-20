<script lang="ts">
	import type { BoardState } from '../../state/board.svelte';
	import type { Ticket } from '../../types';

	let { board, ticket }: { board: BoardState; ticket: Ticket } = $props();
	let verb = $state('blocks');
	let target = $state('');
	let links = $derived((ticket.links as { ref?: string; to?: string; type?: string }[] | undefined) ?? []);
	let targets = $derived(board.scopedTickets.filter((candidate) => candidate.id !== ticket.id && candidate.ref !== ticket.ref));

	async function add() {
		if (target) await board.linkTicket(ticket, verb, target);
	}

	function label(link: { type?: string }) {
		return link.type === 'blocked-by' ? 'blocked by' : link.type === 'related' ? 'related to' : link.type ?? 'blocks';
	}
</script>

<section class="links">
	<h3>Links</h3>
	<div class="link-list">
		{#each links as link, index (link.ref ?? link.to ?? index)}
			<div class="link"><span>{label(link)} {link.ref ?? link.to}</span><button type="button" aria-label={`Remove link to ${link.ref ?? link.to}`} onclick={() => board.unlinkTicket(ticket, String(link.ref ?? link.to))}>Remove</button></div>
		{/each}
	</div>
	<div class="add-link">
		<select aria-label="Link type" bind:value={verb}><option value="blocks">blocks</option><option value="blocked-by">depends on</option><option value="related">related to</option></select>
		<select aria-label="Link target" bind:value={target}><option value="">Choose a ticket</option>{#each targets as candidate (candidate.id)}<option value={candidate.ref}>{candidate.ref} · {candidate.title}</option>{/each}</select>
		<button type="button" disabled={!target} onclick={add}>Add link</button>
	</div>
</section>

<style>
	.links { margin-top:1rem; } h3 { margin:0 0 .4rem; font-size:.9rem; } .link-list { display:grid; gap:.35rem; } .link { display:flex; align-items:center; justify-content:space-between; gap:.5rem; padding:.4rem .5rem; border:1px solid var(--border); border-radius:var(--radius); } .add-link { display:grid; grid-template-columns:8rem minmax(0, 1fr) auto; gap:.4rem; margin-top:.5rem; } select { min-width:0; padding:.5rem; border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); color:var(--text); }
</style>
