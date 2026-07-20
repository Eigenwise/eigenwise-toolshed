<script lang="ts">
  import type { BoardState } from '../../state/board.svelte';
  let { state }: { state: BoardState } = $props();
</script>

{#if state.popover === 'lightbox'}<div class="overlay" role="presentation" onclick={() => state.popover = null}><p>Image lightbox</p></div>{/if}