<script lang="ts">
  import { onMount } from 'svelte';
  import type { BoardState } from '../../state/board.svelte';
  import type { Project } from '../../types';
  import { projectFor } from '../board/surface';

  let { state: board }: { state: BoardState } = $props();
  let menuProject = $state<Project | null>(null);

  const activeProjects = $derived(board.raw?.projects ?? []);
  const archivedCount = $derived(board.archivedTickets.filter((ticket) => board.selectedProject === 'all' || projectFor(ticket) === board.selectedProject).length);

  function projectTickets(project: Project) {
    return board.raw?.tickets.filter((ticket) => projectFor(ticket) === project.slug) ?? [];
  }

  function counts(project?: Project) {
    const tickets = project ? projectTickets(project) : board.raw?.tickets ?? [];
    return {
      todo: tickets.filter((ticket) => ticket.status === 'todo').length,
      doing: tickets.filter((ticket) => ticket.status === 'doing').length,
      done: tickets.filter((ticket) => ticket.status === 'done').length
    };
  }

  function openCount(project?: Project) {
    const values = counts(project);
    return values.todo + values.doing + values.done;
  }

  function unread(project: Project) {
    return Number(project.unread ?? project.unseen ?? 0);
  }

  function projectLocation(path?: string) {
    if (!path) return '';
    return path.split(/[\\/]+/).filter(Boolean).slice(-2).join(' / ');
  }

  async function refreshArchivedProjects() {
    try {
      board.archivedProjects = (await board.api.archivedProjects()).projects;
    } catch {
      board.archivedProjects = [];
    }
  }

  onMount(() => { void refreshArchivedProjects(); });

  async function archiveProject(project: Project) {
    const count = openCount(project) + board.archivedTickets.filter((ticket) => projectFor(ticket) === project.slug).length;
    if (!confirm(`Archive "${project.name}" and its ${count} ticket${count === 1 ? '' : 's'}? You can restore it from Archived boards.`)) return;
    await board.archiveProject(project);
    if (board.selectedProject === project.slug) board.selectProject('all');
    await refreshArchivedProjects();
  }

  async function restoreProject(project: Project) {
    await board.restoreProject(project);
    await refreshArchivedProjects();
  }

  async function deleteProject(project: Project) {
    const count = openCount(project) + board.archivedTickets.filter((ticket) => projectFor(ticket) === project.slug).length;
    if (!confirm(`Delete "${project.name}" and its ${count} ticket${count === 1 ? '' : 's'} permanently? This cannot be undone.`)) return;
    await board.deleteProject(project);
    if (board.selectedProject === project.slug) board.selectProject('all');
    await refreshArchivedProjects();
  }

  function showMenu(event: MouseEvent, project: Project) {
    event.preventDefault();
    menuProject = project;
  }
</script>

<aside class="rail" aria-label="Boards">
  <div class="brand"><img class="brand-mark" src="/eigenwise-e.svg" alt="" /><strong>Sidequest</strong><span>work queue</span></div>
  <nav>
    <button class:active={board.selectedProject === 'all' && board.view === 'board'} onclick={() => board.selectProject('all')}>
      <span class="project-row"><b>All boards</b><small>{openCount()}</small></span>
      <span class="project-path">{activeProjects.length} project{activeProjects.length === 1 ? '' : 's'}</span>
      <span class="progress" aria-hidden="true"><i style:--size={`${counts().todo}`} class="todo"></i><i style:--size={`${counts().doing}`} class="doing"></i><i style:--size={`${counts().done}`} class="done"></i></span>
    </button>
    {#each activeProjects as project (project.slug)}
      {@const total = openCount(project)}
      {@const projectCounts = counts(project)}
      <button class:active={board.selectedProject === project.slug && board.view === 'board'} onclick={() => board.selectProject(project.slug)} oncontextmenu={(event) => showMenu(event, project)}>
        <span class="project-row"><b>{project.name}</b>{#if project.notify === false}<span class="muted" title="Notifications muted">muted</span>{/if}{#if unread(project)}<mark>{unread(project) > 99 ? '99+' : unread(project)}</mark>{/if}<small>{total}</small></span>
        <span class="project-path" title={project.path}>{projectLocation(project.path)}</span>
        <span class="progress" aria-hidden="true"><i style:--size={`${projectCounts.todo}`} class="todo"></i><i style:--size={`${projectCounts.doing}`} class="doing"></i><i style:--size={`${projectCounts.done}`} class="done"></i></span>
      </button>
    {/each}
    {#if board.archivedProjects.length}
      <details class="archived-group">
        <summary>Archived boards <span>{board.archivedProjects.length}</span></summary>
        {#each board.archivedProjects as project (project.slug)}
          <button class="archived" title={`Restore ${project.name}`} onclick={() => restoreProject(project)} oncontextmenu={(event) => showMenu(event, project)}>{project.name}</button>
        {/each}
      </details>
    {/if}
  </nav>
  <button class:active={board.view === 'archive'} class="archive-button" onclick={() => board.view === 'archive' ? board.closeArchive() : board.openArchive()}><span>Archive</span>{#if archivedCount}<mark>{archivedCount}</mark>{/if}</button>
  <small class:offline={board.offline} class="connection">{board.offline ? 'offline' : 'live'}</small>
</aside>

{#if menuProject}
  <div class="menu-backdrop" role="presentation" onclick={() => menuProject = null}></div>
  <div class="project-menu" role="menu">
    {#if menuProject.archived}
      <button role="menuitem" onclick={() => { restoreProject(menuProject!); menuProject = null; }}>Restore board</button>
    {:else}
      <button role="menuitem" onclick={() => { archiveProject(menuProject!); menuProject = null; }}>Archive board</button>
      <button class="danger" role="menuitem" onclick={() => { deleteProject(menuProject!); menuProject = null; }}>Delete board</button>
    {/if}
  </div>
{/if}

<style>
  .rail { display: grid; grid-template-rows: auto minmax(0, 1fr) auto auto; gap: 1rem; min-height: 100vh; padding: 1rem; background: var(--surface); border-right: 1px solid var(--border); }
  .brand { display: grid; grid-template-columns: auto 1fr; column-gap: .55rem; padding: .25rem .5rem; color: var(--accent); letter-spacing: -.02em; } .brand-mark { grid-row: span 2; align-self: center; width: 1.45rem; height: 1.6rem; } .brand strong { align-self: end; font-family: var(--font-serif); font-size: 1.3rem; } .brand span, .connection { color: var(--text-muted); font-size: .72rem; text-transform: uppercase; letter-spacing: .08em; }
  nav { display: grid; align-content: start; gap: .3rem; overflow-x: hidden; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--border) transparent; } nav::-webkit-scrollbar { width: .45rem; } nav::-webkit-scrollbar-thumb { border-radius: 999px; background: var(--border); } button { width: 100%; border: 0; border-radius: var(--radius); padding: .55rem; background: transparent; color: inherit; text-align: left; cursor: pointer; font: inherit; } button:hover { background: var(--surface-muted); } button.active { background: var(--accent-soft); color: var(--accent); }
  .project-row { display: flex; align-items: center; gap: .4rem; min-width: 0; } .project-row b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .86rem; } .project-row small { margin-left: auto; color: var(--text-muted); font-family: var(--font-mono); font-size: .7rem; } mark { padding: .08rem .3rem; border-radius: 999px; background: var(--warning); color: white; font: 700 .66rem var(--font-mono); } .muted { color: var(--text-muted); font-size: .65rem; }
  .project-path { display: block; overflow: hidden; color: var(--text-muted); font-size: .69rem; text-overflow: ellipsis; white-space: nowrap; } .progress { display: flex; height: .2rem; margin-top: .45rem; overflow: hidden; border-radius: 999px; background: var(--border); } .progress i { flex: var(--size, 0); } .todo { background: #7180b3; } .doing { background: var(--warning); } .done { background: var(--accent); }
  .archived-group { margin-top: .5rem; color: var(--text-muted); font-size: .78rem; } summary { padding: .35rem .55rem; cursor: pointer; } summary span { font-family: var(--font-mono); } .archived { color: var(--text-muted); font-size: .8rem; }
  .archive-button { display: flex; align-items: center; justify-content: space-between; border: 1px solid var(--border); } .connection { padding: .2rem .5rem; } .connection.offline { color: var(--danger); }
  .menu-backdrop { position: fixed; inset: 0; z-index: 4; } .project-menu { position: fixed; z-index: 5; left: 1rem; bottom: 3rem; display: grid; min-width: 10rem; padding: .25rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow); } .project-menu .danger { color: var(--danger); }
  @media (max-width: 820px) { .rail { grid-template-columns: auto minmax(0, 1fr) auto; grid-template-rows: auto; min-height: auto; gap: .6rem; border-right: 0; border-bottom: 1px solid var(--border); } nav { display: flex; align-items: stretch; overflow-x: auto; } nav > button { min-width: 10rem; } .project-path, .connection { display: none; } .progress { margin-top: .3rem; } .archive-button { width: auto; white-space: nowrap; } .archived-group { display: none; } }
</style>
