<script lang="ts">
  import type { BoardState } from '../../state/board.svelte';
  import type { Ticket } from '../../types';
  let { state, ticket }: { state: BoardState; ticket: Ticket } = $props();
</script>

<button class="card" draggable="true" ondragstart={() => state.setDragging(true)} ondragend={() => state.setDragging(false)} onclick={() => state.openDialog = ticket.id}><small>{ticket.ref} · {ticket.priority ?? 'normal'}</small><strong>{ticket.title}</strong>{#if ticket.description}<span>{ticket.description}</span>{/if}</button>

<style>.card { display: grid; gap: .35rem; width: 100%; text-align: left; padding: .8rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text); } small, span { color: var(--text-muted); }</style>