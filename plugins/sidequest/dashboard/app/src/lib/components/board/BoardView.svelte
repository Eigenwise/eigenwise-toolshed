<script lang="ts">
  import type { BoardState } from '../../state/board.svelte';
  import type { Status, Ticket } from '../../types';
  import BoardColumn from './BoardColumn.svelte';
  import { movePayload } from './surface';

  let { state: board }: { state: BoardState } = $props();
  let draggingTicket = $state<Ticket | null>(null);

  async function move(ticket: Ticket, status: Status) {
    const payload = movePayload(ticket, status);
    if (!payload) return;
    if (board.raw) board.raw = { ...board.raw, tickets: board.raw.tickets.map((item) => item.id === ticket.id ? { ...item, ...payload } : item) };
    await board.moveTicket(ticket, status);
  }
</script>

{#if !board.scopedTickets.length}
  <section class="onboarding panel"><span>+</span><h2>No side quests yet</h2><p>Stray work lands here when you file it. Start with a ticket, then pull it across the board.</p><button onclick={() => board.openDialog = 'create'}>New ticket</button></section>
{:else}
  <div class="board" aria-label="Ticket board">
    <BoardColumn state={board} status="todo" tickets={board.columns.todo} bind:draggingTicket onmove={move} />
    <BoardColumn state={board} status="doing" tickets={board.columns.doing} bind:draggingTicket onmove={move} />
    <BoardColumn state={board} status="done" tickets={board.columns.done} bind:draggingTicket onmove={move} />
  </div>
{/if}

<style>
  .onboarding { display: grid; justify-items: start; gap: .6rem; max-width: 34rem; padding: 2rem; } .onboarding span { display: grid; width: 2.4rem; height: 2.4rem; place-items: center; border-radius: 999px; background: var(--accent-soft); color: var(--accent); font-size: 1.5rem; } h2, p { margin: 0; } h2 { font-family: var(--font-serif); } p { color: var(--text-muted); line-height: 1.5; } button { margin-top: .4rem; border: 0; border-radius: var(--radius); padding: .55rem .75rem; background: var(--accent); color: white; font: inherit; font-weight: 700; cursor: pointer; }
</style>
