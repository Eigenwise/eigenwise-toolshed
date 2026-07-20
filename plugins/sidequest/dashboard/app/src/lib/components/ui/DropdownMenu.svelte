<script lang="ts">
  import type { Snippet } from 'svelte';
  let { children, label }: { children: Snippet; label: string } = $props();
</script>

<div class="ui-dropdown" role="menu" aria-label={label}>{@render children()}</div>

<style>
  .ui-dropdown { position:absolute; z-index:30; display:grid; min-width:12rem; padding:.3rem; border:1px solid var(--border); border-radius:var(--radius); background:var(--surface); box-shadow:var(--shadow); }
  .ui-dropdown :global(button) { justify-content:flex-start; }
</style>
