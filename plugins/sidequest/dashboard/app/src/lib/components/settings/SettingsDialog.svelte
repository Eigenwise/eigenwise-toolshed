<script lang="ts">
  import type { BoardState } from '../../state/board.svelte';
  let { state }: { state: BoardState } = $props();
</script>

<button onclick={() => state.popover = state.popover === 'settings' ? null : 'settings'}>Settings</button>{#if state.popover === 'settings'}<section class="settings panel"><h2>Settings</h2><div class="settings-grid"><section><h3>Routing</h3><p>Routing controls will live here.</p><h3>Categories</h3><p>{Object.keys(state.categoryGroups).length} category groups.</p></section><section><h3>Notifications</h3><p>Notification preferences will live here.</p></section></div></section>{/if}

<style>button { border: 1px solid var(--border); background: var(--surface); padding: .55rem .75rem; border-radius: var(--radius); }.settings { position: absolute; z-index: 2; top: 4.5rem; right: 1rem; padding: 1rem; width: min(42rem, calc(100vw - 2rem)); }.settings-grid { display:grid; grid-template-columns:1fr 1fr; gap:1rem; } h2,h3 { margin-top:0; }</style>