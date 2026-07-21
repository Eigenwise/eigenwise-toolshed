<script lang="ts">
  import type { BoardState } from '../../state/board.svelte';
  import Dialog from '../ui/Dialog.svelte';

  let { state }: { state: BoardState } = $props();
</script>

<Dialog open={Boolean(state.lightbox)} label={`Image ${state.lightbox?.filename ?? ''}`} onclose={() => state.closeLightbox()}>
  {#if state.lightbox}
    <div class="lightbox">
      <img src={state.lightbox.src} alt={state.lightbox.filename} />
      <footer><span>{state.lightbox.filename}</span><button onclick={() => state.closeLightbox()}>Close</button></footer>
    </div>
  {/if}
</Dialog>

<style>
  .lightbox { display: grid; gap: .6rem; padding: .75rem; background: var(--bg-deep); }
  img { display: block; max-inline-size: 100%; max-block-size: calc(100dvh - 8rem); margin: auto; border: 1px solid color-mix(in srgb, var(--text), transparent 55%); border-radius: 3px; }
  footer { display: flex; justify-content: space-between; align-items: center; gap: 1rem; color: var(--text); font-size: .86rem; }
  button { border: 1px solid var(--border-strong); border-radius: 3px; background: transparent; color: var(--text); padding: .4rem .6rem; font: inherit; }
</style>
