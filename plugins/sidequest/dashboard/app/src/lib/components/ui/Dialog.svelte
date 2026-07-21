<script lang="ts">
  import type { Snippet } from 'svelte';
  let { open = false, children, label, wide = false, onclose }: { open?: boolean; children: Snippet; label: string; wide?: boolean; onclose?: () => void } = $props();
  function close() { onclose?.(); }
</script>

{#if open}
  <div class="ui-dialog-backdrop" role="presentation" onclick={close}>
    <dialog class:wide open aria-modal="true" aria-label={label} onclick={(event) => event.stopPropagation()}>
      {@render children()}
    </dialog>
  </div>
{/if}

<style>
  .ui-dialog-backdrop { position:fixed; inset:0; z-index:40; display:grid; place-items:center; padding:1rem; background:oklch(.08 .02 240 / .72); backdrop-filter:blur(10px); }
  dialog { width:min(44rem,100%); max-height:calc(100vh - 2rem); overflow:auto; border:1px solid var(--border-strong); border-radius:var(--radius); background:var(--bg-deep); color:var(--text); scrollbar-width:thin; scrollbar-color:var(--border) transparent; }
  dialog.wide { width:min(70rem, 100%); }
  dialog::-webkit-scrollbar, .ui-dialog-backdrop::-webkit-scrollbar { width:.55rem; }
  dialog::-webkit-scrollbar-thumb, .ui-dialog-backdrop::-webkit-scrollbar-thumb { border-radius:var(--radius); background:var(--border); }
</style>
