<script lang="ts">
  import type { BoardState } from '../../state/board.svelte';

  let { state }: { state: BoardState } = $props();
</script>

<div class="toasts" aria-live="polite" aria-label="Status messages">
  {#each state.toasts as toast (toast)}
    <button onclick={() => state.dismissToast(toast)}>{toast}<span aria-hidden="true">×</span></button>
  {/each}
</div>

<style>
  .toasts { position: fixed; right: 1rem; bottom: 1rem; z-index: 50; display: grid; gap: .5rem; width: min(24rem, calc(100vw - 2rem)); }
  button { display: flex; align-items: center; justify-content: space-between; gap: 1rem; width: 100%; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--bg-deep); color: var(--text); padding: .72rem .8rem; font: inherit; text-align: left; }
  span { color: var(--text-muted); font-size: 1.1rem; }
</style>
