<script lang="ts">
	import type { BoardState } from '../../state/board.svelte';
	import type { Ticket } from '../../types';

	let { board, ticket }: { board: BoardState; ticket: Ticket } = $props();
	let custom = $state('');
	let reminder = $derived(ticket.reminder as { fireAt?: string } | undefined);

	function future(hours: number) { return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(); }
	function tomorrow() {
		const now = new Date();
		return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9).toISOString();
	}
	async function schedule(fireAt: string) {
		if (!Number.isFinite(Date.parse(fireAt)) || Date.parse(fireAt) <= Date.now()) {
			board.toast('Choose a future reminder time.');
			return;
		}
		await board.scheduleReminder(ticket, fireAt);
		custom = '';
	}
</script>

<section class="reminder">
	<h3>Reminder</h3>
	{#if reminder?.fireAt}<div class="active">Scheduled for {new Date(reminder.fireAt).toLocaleString()} <button type="button" onclick={() => board.cancelReminder(ticket)}>Cancel</button></div>{/if}
	<div class="presets"><button type="button" onclick={() => schedule(future(1))}>In 1 hour</button><button type="button" onclick={() => schedule(future(3))}>In 3 hours</button><button type="button" onclick={() => schedule(tomorrow())}>Tomorrow 09:00</button></div>
	<div class="custom"><input aria-label="Custom reminder" type="datetime-local" bind:value={custom} /><button type="button" onclick={() => schedule(custom ? new Date(custom).toISOString() : '')}>Schedule</button></div>
</section>

<style>
	.reminder { margin-top:1rem; } h3 { margin:0 0 .4rem; font-size:.9rem; } .active, .presets, .custom { display:flex; flex-wrap:wrap; gap:.4rem; align-items:center; } .presets, .custom { margin-top:.4rem; } input { padding:.45rem; border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); color:var(--text); }
</style>
