<script lang="ts">
  import type { Snippet } from 'svelte';
  let { children }: { children: Snippet } = $props();
</script>

<div class="ui-popover" role="menu">{@render children()}</div>

<style>
  .ui-popover { position:absolute; z-index:30; min-width:13rem; padding:.35rem; border:1px solid var(--border-strong); border-radius:var(--radius); background:var(--bg-deep); }
</style>
