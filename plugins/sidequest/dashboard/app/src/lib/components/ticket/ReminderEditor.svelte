<script lang="ts">
	import type { BoardState } from '../../state/board.svelte';
	import type { Ticket } from '../../types';
	import Button from '../ui/Button.svelte';
	import DateTimePicker from '../ui/DateTimePicker.svelte';

	let { board, ticket }: { board: BoardState; ticket: Ticket } = $props();
	let custom = $state('');
	let reminder = $derived(ticket.reminder as { fireAt?: string } | undefined);

	function future(hours: number) { return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(); }
	function tomorrow() { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9).toISOString(); }
	async function schedule(fireAt: string) {
		if (!Number.isFinite(Date.parse(fireAt)) || Date.parse(fireAt) <= Date.now()) { board.toast('Choose a future reminder time.'); return; }
		await board.scheduleReminder(ticket, fireAt);
		custom = '';
	}
</script>

<section class="reminder">
	<h3>Reminder</h3>
	{#if reminder?.fireAt}<div class="active"><span>Scheduled for {new Date(reminder.fireAt).toLocaleString()}</span><Button variant="quiet" onclick={() => board.cancelReminder(ticket)}>Cancel</Button></div>{/if}
	<div class="presets"><Button onclick={() => schedule(future(1))}>In 1 hour</Button><Button onclick={() => schedule(future(3))}>In 3 hours</Button><Button onclick={() => schedule(tomorrow())}>Tomorrow 09:00</Button></div>
	<div class="custom"><DateTimePicker label="Custom reminder" bind:value={custom} /><Button variant="primary" onclick={() => schedule(custom ? new Date(custom).toISOString() : '')}>Schedule</Button></div>
</section>

<style>
	.reminder { margin:0; } h3 { margin:0 0 .55rem; font-size:.82rem; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); } .active, .presets, .custom { display:flex; flex-wrap:wrap; gap:.45rem; align-items:center; } .active { justify-content:space-between; font-size:.82rem; } .presets, .custom { margin-top:.55rem; } .custom :global(.date-picker) { flex:1 1 13rem; }
</style>
