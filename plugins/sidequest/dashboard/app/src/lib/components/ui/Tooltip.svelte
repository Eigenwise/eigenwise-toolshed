<script lang="ts">
  import type { Snippet } from 'svelte';
  let { children, text }: { children: Snippet; text: string } = $props();
</script>

<span class="ui-tooltip" data-tooltip={text}>{@render children()}</span>

<style>
  .ui-tooltip { position:relative; display:inline-flex; }
  .ui-tooltip::after { position:absolute; z-index:50; bottom:calc(100% + .4rem); left:50%; width:max-content; max-width:16rem; padding:.35rem .5rem; border:1px solid var(--border); border-radius:.35rem; background:var(--surface); color:var(--text); content:attr(data-tooltip); font-size:.7rem; opacity:0; pointer-events:none; transform:translate(-50%, .2rem); transition:opacity var(--motion-fast),transform var(--motion-fast); }
  .ui-tooltip:hover::after, .ui-tooltip:focus-within::after { opacity:1; transform:translate(-50%, 0); }
</style>
