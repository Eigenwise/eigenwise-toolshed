<script lang="ts">
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';

  let { open = false, children, label, wide = false, onclose }: { open?: boolean; children: Snippet; label: string; wide?: boolean; onclose?: () => void } = $props();
  let dialog = $state<HTMLDialogElement>();

  function close() { onclose?.(); }

  function handleCancel(event: Event) {
    event.preventDefault();
    close();
  }

  function handleClick(event: MouseEvent) {
    if (event.target === dialog) close();
  }

  onMount(() => {
    if (dialog && open && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  });
</script>

{#if open}
  <dialog bind:this={dialog} class:wide aria-label={label} oncancel={handleCancel} onclick={handleClick}>
    {@render children()}
  </dialog>
{/if}

<style>
  dialog {
    --dialog-gutter: 1rem;
    position: fixed;
    inset: 0;
    box-sizing: border-box;
    inline-size: min(44rem, calc(100vw - 2 * var(--dialog-gutter)));
    max-inline-size: calc(100vw - 2 * var(--dialog-gutter));
    max-block-size: calc(100vh - 2 * var(--dialog-gutter));
    max-block-size: calc(100dvh - 2 * var(--dialog-gutter));
    margin: auto;
    padding: 0;
    overflow: visible;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-card);
    color: var(--text);
    box-shadow: 0 18px 56px rgb(12 16 22 / .28), 0 2px 8px rgb(12 16 22 / .16);
  }

  dialog.wide { inline-size: min(70rem, calc(100vw - 2 * var(--dialog-gutter))); }
  dialog::backdrop { background: color-mix(in oklch, var(--bg-deep), transparent 22%); backdrop-filter: blur(4px); }

  @media (max-width: 560px) {
    dialog { --dialog-gutter: .5rem; }
  }
</style>
