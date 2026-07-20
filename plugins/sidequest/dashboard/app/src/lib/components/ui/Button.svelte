<script lang="ts">
  import type { Snippet } from 'svelte';

  let { children, variant = 'secondary', type = 'button', disabled = false, onclick }: { children: Snippet; variant?: 'primary' | 'secondary' | 'quiet' | 'danger'; type?: 'button' | 'submit' | 'reset'; disabled?: boolean; onclick?: (event: MouseEvent) => void } = $props();
</script>

<button class={`ui-button ${variant}`} {type} {disabled} {onclick}>
  {@render children()}
</button>

<style>
  .ui-button { display:inline-flex; min-height:2.25rem; align-items:center; justify-content:center; gap:.4rem; border:1px solid var(--border); border-radius:calc(var(--radius) - .15rem); padding:.45rem .75rem; background:var(--surface-muted); color:var(--text); font:600 .78rem var(--font-sans); }
  .ui-button.primary { border-color:var(--accent); background:var(--accent); color:oklch(.16 .03 235); }
  .ui-button.quiet { border-color:transparent; background:transparent; color:var(--text-muted); }
  .ui-button.danger { color:var(--danger); }
  .ui-button:disabled { cursor:not-allowed; opacity:.55; }
</style>
