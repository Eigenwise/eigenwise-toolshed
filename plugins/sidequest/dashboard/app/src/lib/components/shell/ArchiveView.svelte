<script lang="ts">
  import type { BoardState } from '../../state/board.svelte';
  let { state }: { state: BoardState } = $props();
</script>

<section class="panel"><h2>Archive</h2>{#if state.archivedTickets.length}{#each state.archivedTickets as ticket (ticket.id)}<button onclick={() => state.openDialog = ticket.id}>{ticket.ref} {ticket.title}</button>{/each}{:else}<p>No archived tickets in this scope.</p>{/if}</section>

<style>section { padding: 1rem; } button { display: block; width: 100%; border: 0; background: transparent; padding: .5rem; text-align: left; }</style>