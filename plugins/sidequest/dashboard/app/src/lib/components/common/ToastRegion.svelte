<script lang="ts">
  import type { BoardState } from '../../state/board.svelte';
  let { state }: { state: BoardState } = $props();
</script>

<div class="toasts" aria-live="polite">{#each state.toasts as toast (toast)}<button onclick={() => state.dismissToast(toast)}>{toast}</button>{/each}</div>

<style>.toasts { position:fixed; right:1rem; bottom:1rem; display:grid; gap:.5rem; z-index:3; }.toasts button { background:var(--text); color:white; border:0; padding:.75rem; border-radius:var(--radius); }</style>