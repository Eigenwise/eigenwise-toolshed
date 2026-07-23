<script lang="ts">
  import type { Snippet } from 'svelte';

  let { open = false, children, label, wide = false, onclose, class: className = '' }: { open?: boolean; children: Snippet; label: string; wide?: boolean; onclose?: () => void; class?: string } = $props();
  let dialog = $state<HTMLDialogElement>();

  function close() { onclose?.(); }

  function handleCancel(event: Event) {
    event.preventDefault();
    close();
  }

  function handleClick(event: MouseEvent) {
    if (!dialog) return;
    const bounds = dialog.getBoundingClientRect();
    const inside = event.target !== dialog
      || (event.clientX >= bounds.left && event.clientX <= bounds.right
        && event.clientY >= bounds.top && event.clientY <= bounds.bottom);
    if (inside) event.stopPropagation();
    else close();
  }

  $effect(() => {
    const element = dialog;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
    return () => {
      if (element.open) element.close();
    };
  });
</script>

<dialog bind:this={dialog} class={className} class:wide aria-label={label} oncancel={handleCancel} onclick={handleClick}>
  {@render children()}
</dialog>

<style>
  dialog {
    --dialog-gutter: 1.5rem;
    position: fixed;
    inset: 0;
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    box-sizing: border-box;
    inline-size: min(44rem, calc(100vw - 2 * var(--dialog-gutter)));
    block-size: min(46rem, calc(100dvh - 2 * var(--dialog-gutter)));
    max-inline-size: calc(100vw - 2 * var(--dialog-gutter));
    max-block-size: calc(100vh - 2 * var(--dialog-gutter));
    max-block-size: calc(100dvh - 2 * var(--dialog-gutter));
    margin: auto;
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    background: var(--surface-card);
    color: var(--text);
    box-shadow: 0 18px 56px rgb(12 16 22 / .28), 0 2px 8px rgb(12 16 22 / .16);
  }

  dialog:not([open]) { display: none; }

  dialog.wide { inline-size: min(70rem, calc(100vw - 2 * var(--dialog-gutter))); }
  dialog::backdrop { background: color-mix(in oklch, var(--bg-deep), transparent 22%); backdrop-filter: blur(4px); }

  @media (max-width: 560px) {
    dialog { --dialog-gutter: .75rem; block-size: calc(100dvh - 2 * var(--dialog-gutter)); }
  }
</style>
