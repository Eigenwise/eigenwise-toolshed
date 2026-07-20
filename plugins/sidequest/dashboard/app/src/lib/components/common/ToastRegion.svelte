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
  button { display: flex; align-items: center; justify-content: space-between; gap: 1rem; width: 100%; border: 0; border-radius: var(--radius); background: var(--text); color: white; padding: .72rem .8rem; box-shadow: var(--shadow); font: inherit; text-align: left; }
  span { color: rgb(255 255 255 / .7); font-size: 1.1rem; }
</style>
