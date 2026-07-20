<script lang="ts">
  import type { BoardState } from '../../state/board.svelte';
  import StoryPicker from './StoryPicker.svelte'; import AttachmentPicker from './AttachmentPicker.svelte'; import CommentThread from './CommentThread.svelte'; import LinkEditor from './LinkEditor.svelte'; import ReminderEditor from './ReminderEditor.svelte';
  let { state }: { state: BoardState } = $props();
</script>

{#if state.openDialog}<div class="overlay" role="presentation" onclick={() => state.openDialog = null}><dialog class="dialog panel" open aria-modal="true" onclick={(event) => event.stopPropagation()}><header><h2>{state.openDialog === 'create' ? 'New ticket' : 'Ticket'}</h2><button onclick={() => state.openDialog = null}>Close</button></header><input placeholder="Title" aria-label="Title" /><textarea placeholder="Details" aria-label="Details"></textarea><StoryPicker /><AttachmentPicker /><CommentThread /><LinkEditor /><ReminderEditor /></dialog></div>{/if}

<style>.dialog { width:min(46rem, calc(100vw - 2rem)); max-height:calc(100vh - 2rem); overflow:auto; padding:1rem; }.dialog header { display:flex; justify-content:space-between; }.dialog input,.dialog textarea { display:block; width:100%; margin:.75rem 0; padding:.6rem; border:1px solid var(--border); border-radius:var(--radius); }.dialog textarea { min-height:8rem; }</style>