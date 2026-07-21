<script lang="ts">
  import type { BoardState } from '../../state/board.svelte';
  import type { Status, Ticket } from '../../types';
  import TicketCard from './TicketCard.svelte';

  let { state: board, status, tickets, draggingTicket = $bindable<Ticket | null>(null), onmove }: { state: BoardState; status: Status; tickets: Ticket[]; draggingTicket?: Ticket | null; onmove: (ticket: Ticket, status: Status) => Promise<void> } = $props();
  let dropActive = $state(false);

  const emptyCopy = { todo: 'Quiet for now. New quests appear here.', doing: 'Nothing in progress.', done: 'Nothing shipped yet.' } as const;

  async function drop(event: DragEvent) {
    event.preventDefault();
    dropActive = false;
    const ticket = draggingTicket;
    draggingTicket = null;
    board.setDragging(false);
    if (ticket) await onmove(ticket, status);
  }
</script>

<section class:drop-active={dropActive} class:done={status === 'done'} class="column" aria-label={`${status} tickets`} ondragover={(event) => { event.preventDefault(); dropActive = true; }} ondragleave={() => dropActive = false} ondrop={drop}>
  <header><span class="flag"></span><h2>{status === 'todo' ? 'To do' : status}</h2><small>{tickets.length}</small>{#if status === 'done' && tickets.length}<button onclick={() => board.archiveDone()}>Archive all</button>{/if}</header>
  <div class="cards" role="list">
    {#each tickets as ticket (ticket.id)}
      <TicketCard state={board} {ticket} ondragging={(value) => { draggingTicket = value ? ticket : null; }} />
    {:else}
      <p>{emptyCopy[status]}</p>
    {/each}
  </div>
</section>

<style>
  .column { min-height: 15rem; padding: .8rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-muted); transition: border-color var(--motion-fast), background var(--motion-fast); } .column.drop-active { border-color: var(--accent); background: var(--accent-soft); } header { display: flex; align-items: center; gap: .45rem; padding: .1rem .15rem .75rem; } .flag { width: .45rem; height: .45rem; border-radius: 999px; background: var(--border-strong); } .column:not(.done) .flag { background: var(--warning); } .column.done .flag { background: var(--accent); } h2 { margin: 0; font-size: .82rem; text-transform: uppercase; letter-spacing: .08em; } header small { color: var(--text-muted); font-family: var(--font-mono); } header button { margin-left: auto; border: 0; border-radius: 4px; padding: .25rem .4rem; background: transparent; color: var(--accent); font: inherit; font-size: .72rem; cursor: pointer; } header button:hover { background: var(--accent-soft); } .cards { display: grid; align-content: start; gap: .65rem; min-height: 10rem; } p { margin: 1rem .2rem; color: var(--text-muted); font-size: .82rem; line-height: 1.45; }
</style>
