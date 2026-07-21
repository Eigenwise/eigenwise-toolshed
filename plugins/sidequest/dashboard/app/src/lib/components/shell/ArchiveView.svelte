<script lang="ts">
  import type { BoardState } from '../../state/board.svelte';
  import { projectFor, relativeTime } from '../board/surface';

  let { state }: { state: BoardState } = $props();
  const tickets = $derived([...state.archivedTickets].sort((left, right) => String(right.archivedAt ?? right.updatedAt ?? '').localeCompare(String(left.archivedAt ?? left.updatedAt ?? ''))));

  function projectName(ticket: (typeof state.archivedTickets)[number]) {
    const slug = projectFor(ticket);
    return state.raw?.projects.find((project) => project.slug === slug)?.name ?? slug;
  }
</script>

<section class="archive panel">
  <header><div><p class="eyebrow">Archived tickets</p><h2>Archive</h2></div><button onclick={() => state.closeArchive()}>Back to board</button></header>
  {#if tickets.length}
    <div class="rows" role="list">
      {#each tickets as ticket (ticket.id)}
        <article role="listitem"><span class={`priority ${ticket.priority ?? 'normal'}`}>{ticket.priority ?? 'normal'}</span><button class="ticket" onclick={() => state.openDialog = ticket.id}><code>{ticket.ref}</code><strong>{ticket.title}</strong></button>{#if state.selectedProject === 'all'}<span class="project">{projectName(ticket)}</span>{/if}<time datetime={String(ticket.archivedAt ?? ticket.updatedAt ?? '')}>{relativeTime(ticket.archivedAt ?? ticket.updatedAt)}</time><button class="restore" onclick={() => state.restoreTicket(ticket)}>Restore</button></article>
      {/each}
    </div>
  {:else}
    <div class="empty"><span>□</span><h3>Nothing archived yet</h3><p>Finish tickets, then use Archive all on the Done column to tuck them away here.</p></div>
  {/if}
</section>

<style>
  .archive { padding: 1.25rem; } header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding-bottom: 1rem; border-bottom: 1px solid var(--border); } h2, h3, p { margin: 0; } h2 { font-family: var(--font-serif); font-size: 1.6rem; } .eyebrow { color: var(--text-muted); font-size: .7rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; } button { border: 1px solid var(--border); border-radius: var(--radius); padding: .45rem .65rem; background: var(--surface); color: inherit; font: inherit; font-size: .78rem; cursor: pointer; } button:hover { border-color: var(--accent); color: var(--accent); } .rows { display: grid; } article { display: grid; grid-template-columns: auto minmax(12rem, 1fr) auto auto auto; align-items: center; gap: .7rem; padding: .8rem 0; border-bottom: 1px solid var(--border); } .priority, .project { padding: .2rem .55rem; border: 0; border-radius: 999px; background: var(--surface-muted); color: var(--text-muted); font: .73rem var(--font-mono); text-transform: uppercase; } .priority.urgent { color: var(--danger); background: color-mix(in oklch, var(--danger), var(--bg) 84%); } .priority.high { color: var(--warning); background: color-mix(in oklch, var(--warning), var(--bg) 84%); } .ticket { display: grid; justify-items: start; gap: .18rem; padding: 0; border: 0; text-align: left; } .ticket strong { font-size: .86rem; } code, time { color: var(--text-muted); font: .72rem var(--font-mono); } .restore { color: var(--accent); } .empty { display: grid; justify-items: center; gap: .45rem; padding: 4rem 1rem; text-align: center; } .empty span { color: var(--accent); font-size: 2rem; } .empty p { max-width: 24rem; color: var(--text-muted); line-height: 1.5; }
  @media (max-width: 620px) { article { grid-template-columns: auto minmax(0, 1fr) auto; } .project, time { display: none; } }
</style>
