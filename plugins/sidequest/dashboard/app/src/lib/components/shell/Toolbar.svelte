<script lang="ts">
  import type { BoardState } from '../../state/board.svelte';
  import NotificationInbox from '../notifications/NotificationInbox.svelte';
  import SettingsDialog from '../settings/SettingsDialog.svelte';
  let { state }: { state: BoardState } = $props();
</script>

<header><div><h1>{state.currentProject?.name ?? 'All boards'}</h1><p>{state.scopedTickets.length} tickets</p></div><input aria-label="Search tickets" bind:value={state.search} placeholder="Search" /><button onclick={() => state.openDialog = 'create'}>New ticket</button><NotificationInbox {state} /><SettingsDialog {state} /></header>

<style>header { display: flex; gap: .75rem; align-items: center; margin-bottom: 1.5rem; flex-wrap: wrap; } h1, p { margin: 0; } p { color: var(--text-muted); } input { flex: 1 1 14rem; padding: .55rem .75rem; border: 1px solid var(--border); border-radius: var(--radius); } button { border: 0; border-radius: var(--radius); padding: .55rem .75rem; background: var(--accent); color: white; }</style>