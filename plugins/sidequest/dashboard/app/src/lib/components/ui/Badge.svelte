<script lang="ts">
  import type { Snippet } from 'svelte';
  let { children, tone = 'neutral' }: { children: Snippet; tone?: 'neutral' | 'accent' | 'warning' | 'danger' | 'success' } = $props();
</script>

<span class={`ui-badge ${tone}`}>{@render children()}</span>

<style>
  .ui-badge { display:inline-flex; align-items:center; border:1px solid var(--border); border-radius:999px; padding:.12rem .4rem; color:var(--text-muted); font:600 .65rem var(--font-mono); }
  .accent { border-color:color-mix(in oklch, var(--accent), transparent 45%); color:var(--accent); background:var(--accent-soft); }
  .warning { color:var(--warning); } .danger { color:var(--danger); } .success { color:var(--success); }
</style>
