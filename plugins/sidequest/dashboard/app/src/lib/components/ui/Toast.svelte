<script lang="ts">
  import type { Snippet } from 'svelte';
  let { children, tone = 'default' }: { children: Snippet; tone?: 'default' | 'error' } = $props();
</script>

<section class={`ui-toast ${tone}`} role="status">{@render children()}</section>

<style>
  .ui-toast { padding:.7rem .85rem; border:1px solid var(--border-strong); border-radius:var(--radius); background:var(--bg-deep); color:var(--text); font-size:.8rem; }
  .ui-toast.error { border-color:color-mix(in oklch, var(--danger), transparent 50%); color:var(--danger); }
</style>
