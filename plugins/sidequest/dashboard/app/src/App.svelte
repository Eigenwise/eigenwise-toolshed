<script lang="ts">
  import { onMount } from 'svelte';
  import ProjectRail from './lib/components/shell/ProjectRail.svelte';
  import Toolbar from './lib/components/shell/Toolbar.svelte';
  import BoardView from './lib/components/board/BoardView.svelte';
  import ArchiveView from './lib/components/shell/ArchiveView.svelte';
  import TicketDialog from './lib/components/ticket/TicketDialog.svelte';
  import Lightbox from './lib/components/common/Lightbox.svelte';
  import ToastRegion from './lib/components/common/ToastRegion.svelte';
  import { BoardState } from './lib/state/board.svelte';
  import { PollingController } from './lib/state/polling';
  import { setBoardState } from './lib/state/context';

  const state = new BoardState();
  const polling = new PollingController(state);
  state.controller = polling;
  setBoardState(state);

  onMount(() => polling.start());
</script>

<svelte:document onvisibilitychange={() => { if (document.visibilityState === 'visible') polling.refresh(); }} />

<svg class="grain-filter" aria-hidden="true"><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter></svg>
<div class="app-shell">
  <ProjectRail {state} />
  <main class="workspace">
    <Toolbar {state} />
    {#if state.view === 'archive'}
      <ArchiveView {state} />
    {:else}
      <BoardView {state} />
    {/if}
  </main>
</div>
<TicketDialog {state} />
<Lightbox {state} />
<ToastRegion {state} />

<style>
  .grain-filter { position: absolute; width: 0; height: 0; }
</style>
