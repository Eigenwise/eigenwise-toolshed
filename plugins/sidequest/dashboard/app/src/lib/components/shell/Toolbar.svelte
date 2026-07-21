<script lang="ts">
  import type { BoardState } from '../../state/board.svelte';
  import NotificationInbox from '../notifications/NotificationInbox.svelte';
  import SettingsDialog from '../settings/SettingsDialog.svelte';

  let { state }: { state: BoardState } = $props();
  let toolbar: HTMLElement;

  const sortOptions = [
    ['manual', 'Manual', 'your drag order'],
    ['priority', 'Priority', 'urgent first'],
    ['latest', 'Latest', 'recently updated'],
    ['newest', 'Newest', 'recently created']
  ] as const;
  const assigneeOptions = [
    ['all', 'Everyone', 'no assignee filter'],
    ['you', 'Mine', 'assigned to you'],
    ['agent', 'Agents', 'held by an agent'],
    ['unassigned', 'Unassigned', 'nobody yet']
  ] as const;

  const stories = $derived(state.scopedStories);
  const selectedStory = $derived(stories.find((story) => story.id === state.story));
  const selectedSort = $derived(sortOptions.find(([key]) => key === state.sort) ?? sortOptions[0]);
  const selectedAssignee = $derived(assigneeOptions.find(([key]) => key === state.assignee) ?? assigneeOptions[0]);
  const subtitle = $derived(state.selectedProject === 'all'
    ? `${state.raw?.projects.length ?? 0} projects · ${state.scopedTickets.length} tickets`
    : state.currentProject?.path ?? `${state.scopedTickets.length} tickets`);

  function toggle(name: string) {
    state.popover = state.popover === name ? null : name;
  }

  function setSort(value: typeof state.sort) {
    state.sort = value;
    try { localStorage.setItem('sq_sort', value); } catch {}
    state.popover = null;
  }

  function closeOutside(event: MouseEvent) {
    if (state.popover && !toolbar?.contains(event.target as Node)) state.popover = null;
  }
</script>

<svelte:document onclick={closeOutside} />

<header bind:this={toolbar} class="toolbar">
  <div class="scope"><h1>{state.currentProject?.name ?? 'All boards'}</h1><p>{subtitle}</p></div>
  <div class="controls">
    <label class="search"><span>Search tickets</span><input aria-label="Search tickets" bind:value={state.search} placeholder="Search ref, title, labels" /></label>
    <div class="priority" aria-label="Priority filter">
      {#each ['all', 'urgent', 'high', 'normal', 'low'] as priority (priority)}
        <button class:active={state.priority === priority} onclick={() => state.priority = priority as typeof state.priority}>{priority}</button>
      {/each}
    </div>
    {#if stories.length}
      <div class="menu-wrap"><button class:active={state.story !== 'all'} aria-expanded={state.popover === 'stories'} onclick={() => toggle('stories')}>Stories: {state.story === 'all' ? 'All' : state.story === 'none' ? 'None' : selectedStory?.title}</button>
        {#if state.popover === 'stories'}<div class="popover" role="menu"><button role="menuitemradio" aria-checked={state.story === 'all'} onclick={() => { state.story = 'all'; state.popover = null; }}>All stories</button><button role="menuitemradio" aria-checked={state.story === 'none'} onclick={() => { state.story = 'none'; state.popover = null; }}>No story</button>{#each stories as story (story.id)}<button role="menuitemradio" aria-checked={state.story === story.id} onclick={() => { state.story = story.id; state.popover = null; }}><i style:background={story.color}></i>{story.ref ? `${story.ref} · ` : ''}{story.title} <small>{story.ticketCount ?? 0}</small></button>{/each}</div>{/if}
      </div>
    {/if}
    <div class="menu-wrap"><button class:active={state.assignee !== 'all'} aria-expanded={state.popover === 'assignee'} onclick={() => toggle('assignee')}>Assignee: {selectedAssignee[1]}</button>
      {#if state.popover === 'assignee'}<div class="popover" role="menu">{#each assigneeOptions as [key, label, hint] (key)}<button role="menuitemradio" aria-checked={state.assignee === key} onclick={() => { state.assignee = key; state.popover = null; }}><span>{label}</span><small>{hint}</small></button>{/each}</div>{/if}
    </div>
    <div class="menu-wrap"><button class:active={state.sort !== 'manual'} aria-expanded={state.popover === 'sort'} onclick={() => toggle('sort')}>Sort: {selectedSort[1]}</button>
      {#if state.popover === 'sort'}<div class="popover" role="menu">{#each sortOptions as [key, label, hint] (key)}<button role="menuitemradio" aria-checked={state.sort === key} onclick={() => setSort(key)}><span>{label}</span><small>{hint}</small></button>{/each}</div>{/if}
    </div>
    <button class="new-ticket" onclick={() => state.openDialog = 'create'}>New ticket</button>
    <NotificationInbox {state} />
    <SettingsDialog {state} />
  </div>
</header>

<style>
  .toolbar { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center; gap: 1rem; margin-bottom: 1.5rem; } .scope { display: grid; flex: 0 0 auto; gap: .25rem; } .scope h1, .scope p { margin: 0; white-space: nowrap; } .scope h1 { font-family: var(--font-serif); font-size: clamp(1.35rem, 2vw, 1.85rem); letter-spacing: -.03em; } .scope p { color: var(--text-muted); font-size: .8rem; }
  .controls { display: flex; flex: 1 1 42rem; align-items: center; justify-content: end; gap: .1rem; flex-wrap: wrap; min-width: 0; } button, input { font: inherit; } .controls > button, .controls > .menu-wrap > button, .controls .search input, .controls .priority { box-sizing: border-box; height: var(--control-height); min-height: var(--control-height); } button { border: 1px solid var(--border); border-radius: var(--radius); padding: .46rem .45rem; background: var(--surface); color: inherit; cursor: pointer; font-size: .76rem; } button:hover, button.active { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); } .search span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); } input { min-width: 10rem; padding: .46rem .65rem; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text); }
  .priority { display: flex; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); } .priority button { height: 100%; min-height: 0; border: 0; border-radius: 0; padding: 0 .35rem; text-transform: capitalize; } .priority button + button { border-left: 1px solid var(--border); } .menu-wrap { position: relative; } .popover { position: absolute; z-index: 3; top: calc(100% + .35rem); right: 0; display: grid; min-width: 13rem; padding: .25rem; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--bg-deep); } .popover button { display: flex; align-items: center; justify-content: space-between; gap: 1rem; border: 0; text-align: left; } .popover small { color: var(--text-muted); } .popover i { width: .55rem; height: .55rem; border-radius: 999px; } .new-ticket { border-color: var(--accent); background: var(--accent); color: var(--text-on-accent); font-weight: 700; } .new-ticket:hover { background: var(--accent-strong); color: var(--text-on-accent); }
  @media (max-width: 820px) { .toolbar { gap: .7rem; } .controls { justify-content: start; } .search { flex: 1 0 100%; order: -1; } .search input { width: 100%; } }
</style>
