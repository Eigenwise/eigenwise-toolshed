<script lang="ts">
  import type { BoardState } from '../../state/board.svelte';
  let { state }: { state: BoardState } = $props();
</script>

<button class="bell" onclick={() => state.popover = state.popover === 'inbox' ? null : 'inbox'} aria-label="Notifications">Inbox {state.raw?.notifications.unread ?? 0}</button>{#if state.popover === 'inbox'}<section class="inbox panel"><h2>Notifications</h2>{#each state.unreadBuckets[state.inboxTab] as notification (notification.id)}<button onclick={() => state.markNotificationsRead({ id: notification.id })}>{notification.kind}</button>{:else}<p>Nothing new.</p>{/each}</section>{/if}

<style>.bell { border: 1px solid var(--border); background: var(--surface); padding: .55rem .75rem; border-radius: var(--radius); }.inbox { position: absolute; z-index: 2; right: 1rem; top: 4.5rem; width: 18rem; padding: 1rem; }.inbox button { display:block; width:100%; border:0; background:transparent; text-align:left; padding:.35rem 0; }</style>