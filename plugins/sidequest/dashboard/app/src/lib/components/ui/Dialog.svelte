<script lang="ts">
  import type { Snippet } from 'svelte';
  let { open = $bindable(false), children, label }: { open?: boolean; children: Snippet; label: string } = $props();
  function close() { open = false; }
</script>

{#if open}
  <div class="ui-dialog-backdrop" role="presentation" onclick={close}>
    <dialog open aria-modal="true" aria-label={label} onclick={(event) => event.stopPropagation()}>
      {@render children()}
    </dialog>
  </div>
{/if}

<style>
  .ui-dialog-backdrop { position:fixed; inset:0; z-index:40; display:grid; place-items:center; padding:1rem; background:oklch(.08 .02 240 / .72); backdrop-filter:blur(10px); }
  dialog { width:min(44rem,100%); max-height:calc(100vh - 2rem); overflow:auto; border:1px solid var(--border); border-radius:calc(var(--radius) * 1.25); background:var(--surface); color:var(--text); box-shadow:var(--shadow); }
</style>
