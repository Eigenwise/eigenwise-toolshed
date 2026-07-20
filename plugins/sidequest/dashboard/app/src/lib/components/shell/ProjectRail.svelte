<script lang="ts">
  import type { BoardState } from '../../state/board.svelte';
  let { state }: { state: BoardState } = $props();
</script>

<aside class="rail"><strong>Sidequest</strong><button onclick={() => state.selectProject('all')}>All boards</button>{#each state.raw?.projects ?? [] as project (project.slug)}<button aria-pressed={state.selectedProject === project.slug} onclick={() => state.selectProject(project.slug)}>{project.name}</button>{/each}<small>{state.offline ? 'offline' : 'live'}</small></aside>

<style>.rail { display: grid; align-content: start; gap: .5rem; padding: 1rem; background: var(--surface); border-right: 1px solid var(--border); } button { border: 0; background: transparent; color: inherit; padding: .5rem; text-align: left; border-radius: var(--radius); } button[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent); } small { color: var(--text-muted); }</style>