<script lang="ts">
  import type { BoardState } from '../../state/board.svelte';

  let { state }: { state: BoardState } = $props();

  function close(event: MouseEvent) {
    if (event.currentTarget === event.target) state.closeLightbox();
  }
</script>

{#if state.lightbox}
  <div class="overlay" role="presentation" onclick={close}>
    <dialog class="lightbox" open aria-label={`Image ${state.lightbox.filename}`}>
      <img src={state.lightbox.src} alt={state.lightbox.filename} />
      <footer><span>{state.lightbox.filename}</span><button onclick={() => state.closeLightbox()}>Close</button></footer>
    </dialog>
  </div>
{/if}

<style>
  .overlay { position: fixed; z-index: 40; inset: 0; display: grid; place-items: center; padding: 1rem; background: rgb(16 24 28 / .88); }
  .lightbox { max-width: min(72rem, 100%); max-height: 100%; display: grid; gap: .6rem; }
  img { display: block; max-width: 100%; max-height: calc(100vh - 6rem); margin: auto; border-radius: var(--radius); box-shadow: var(--shadow); }
  footer { display: flex; justify-content: space-between; align-items: center; gap: 1rem; color: white; font-size: .86rem; }
  button { border: 1px solid rgb(255 255 255 / .45); border-radius: var(--radius); background: transparent; color: white; padding: .4rem .6rem; font: inherit; }
</style>
