<script lang="ts">
  import type { BoardState } from '../../state/board.svelte';
  import type { Status, Ticket } from '../../types';
  import TicketCard from './TicketCard.svelte';
  let { state, status, tickets }: { state: BoardState; status: Status; tickets: Ticket[] } = $props();
</script>

<section class="column" role="list" ondragover={(event) => event.preventDefault()} ondrop={() => state.setDragging(false)}><h2>{status} <span>{tickets.length}</span></h2>{#each tickets as ticket (ticket.id)}<TicketCard {state} {ticket} />{:else}<p>No {status} tickets.</p>{/each}</section>

<style>.column { min-height: 12rem; padding: 1rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-muted); } h2 { margin-top: 0; text-transform: capitalize; font-size: 1rem; } h2 span, p { color: var(--text-muted); font-weight: normal; }</style>