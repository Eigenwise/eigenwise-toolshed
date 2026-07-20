<script lang="ts">
	import type { BoardState } from '../../state/board.svelte';
	import type { Ticket } from '../../types';
	import Button from '../ui/Button.svelte';
	import Select, { type SelectOption } from '../ui/Select.svelte';

	let { board, ticket }: { board: BoardState; ticket: Ticket } = $props();
	let verb = $state('blocks');
	let target = $state('');
	let links = $derived((ticket.links as { ref?: string; to?: string; type?: string }[] | undefined) ?? []);
	let targets = $derived(board.scopedTickets.filter((candidate) => candidate.id !== ticket.id && candidate.ref !== ticket.ref));
	let verbOptions: SelectOption[] = [{ value: 'blocks', label: 'Blocks' }, { value: 'blocked-by', label: 'Depends on' }, { value: 'related', label: 'Related to' }];
	let targetOptions = $derived<SelectOption[]>([{ value: '', label: 'Choose a ticket' }, ...targets.map((candidate) => ({ value: candidate.ref, label: `${candidate.ref} · ${candidate.title}` }))]);

	async function add() { if (target) await board.linkTicket(ticket, verb, target); }
	function label(link: { type?: string }) { return link.type === 'blocked-by' ? 'blocked by' : link.type === 'related' ? 'related to' : link.type ?? 'blocks'; }
</script>

<section class="links">
	<h3>Links</h3>
	<div class="link-list">
		{#each links as link, index (link.ref ?? link.to ?? index)}
			<div class="link"><span>{label(link)} {link.ref ?? link.to}</span><Button variant="quiet" onclick={() => board.unlinkTicket(ticket, String(link.ref ?? link.to))}>Remove</Button></div>
		{/each}
	</div>
	<div class="add-link"><Select label="Link type" bind:value={verb} options={verbOptions} /><Select label="Link target" bind:value={target} options={targetOptions} /><Button variant="primary" disabled={!target} onclick={add}>Add link</Button></div>
</section>

<style>
	.links { margin:0; } h3 { margin:0 0 .55rem; font-size:.82rem; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); } .link-list { display:grid; gap:.35rem; } .link { display:flex; align-items:center; justify-content:space-between; gap:.5rem; padding:.45rem .55rem; border:1px solid var(--border); border-radius:calc(var(--radius) - .1rem); font-size:.82rem; } .add-link { display:grid; grid-template-columns:minmax(7.5rem, .6fr) minmax(0, 1fr) auto; gap:.4rem; margin-top:.55rem; } @media (max-width:520px) { .add-link { grid-template-columns:1fr; } }
</style>
