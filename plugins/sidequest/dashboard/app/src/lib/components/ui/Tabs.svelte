<script lang="ts">
  import type { Snippet } from 'svelte';
  let { children }: { children: Snippet } = $props();
</script>

<div class="ui-tabs" role="tablist">{@render children()}</div>

<style>
  .ui-tabs { display:flex; gap:.2rem; padding:.22rem; border:1px solid var(--border); border-radius:var(--radius); background:var(--surface-muted); }
</style>
