<script lang="ts">
  import { onMount } from 'svelte';
  import type { Notification } from '../../types';
  import type { BoardState } from '../../state/board.svelte';

  let { state }: { state: BoardState } = $props();

  const tabLabels = { all: 'All', needs: 'Needs you', activity: 'Activity' };
  const emptyCopy = {
    all: 'Nothing queued yet. Comments, reminders, and status changes show up here.',
    needs: 'Nothing needs you right now. Reminders land here.',
    activity: 'No activity yet. New tickets, moves, and comments show up here.'
  };

  let unread = $derived(state.raw?.notifications.unread ?? 0);
  let unreadNeeds = $derived(state.raw?.notifications.unreadNeeds ?? 0);
  let activityUnread = $derived(Math.max(0, unread - unreadNeeds));
  let notificationIcon = '';

  function isRead(notification: Notification) {
    return Boolean(notification.read || notification.readAt);
  }

  function countFor(tab: keyof typeof tabLabels) {
    if (tab === 'all') return unread;
    return tab === 'needs' ? unreadNeeds : activityUnread;
  }

  function notificationTitle(notification: Notification) {
    return String(notification.title ?? notification.ticketRef ?? notification.kind);
  }

  function notificationBody(notification: Notification) {
    return String(notification.body ?? '');
  }

  function notificationTime(notification: Notification) {
    const value = notification.createdAt;
    if (!value) return '';
    const timestamp = Date.parse(String(value));
    if (!Number.isFinite(timestamp)) return String(value);
    const minutes = Math.round((Date.now() - timestamp) / 60_000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 1_440) return `${Math.round(minutes / 60)}h`;
    return `${Math.round(minutes / 1_440)}d`;
  }

  async function openNotification(notification: Notification) {
    if (!isRead(notification)) await state.markNotificationsRead({ id: notification.id });
    const project = typeof notification.projectSlug === 'string' ? notification.projectSlug : undefined;
    if (project) state.selectProject(project);
    const ticket = state.raw?.tickets.find((candidate) => candidate.id === notification.ticketId || candidate.ref === notification.ticketRef);
    state.popover = null;
    if (ticket) {
      state.openDialog = ticket.id;
      return;
    }
    if (project && notification.ticketRef) {
      state.openArchive();
      state.toast(`Opening archived ticket ${notification.ticketRef}.`);
    }
  }

  function createNotificationIcon() {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    if (!context) return '';
    const styles = getComputedStyle(document.documentElement);
    context.fillStyle = styles.getPropertyValue('--accent').trim();
    context.beginPath();
    context.arc(32, 32, 28, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = styles.getPropertyValue('--text-on-accent').trim();
    context.font = 'bold 36px system-ui';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('S', 32, 34);
    return canvas.toDataURL();
  }

  function syncPermission() {
    if (!('Notification' in globalThis)) {
      state.setDesktopNotificationPermission('unsupported');
      return;
    }
    state.setDesktopNotificationPermission(globalThis.Notification.permission);
  }

  $effect(() => {
    const events = state.desktopNotificationEvents;
    if (!events.length || state.desktopNotificationPermission !== 'granted' || document.hasFocus() || !('Notification' in globalThis)) return;
    for (const event of state.takeDesktopNotificationEvents()) {
      const project = String(event.ticket.projectName ?? event.ticket.projectSlug ?? event.ticket.project ?? '');
      const notification = new globalThis.Notification(event.ticket.title, {
        body: project ? `${event.kind} · ${project}` : event.kind,
        tag: `sidequest:${event.key}`,
        icon: notificationIcon
      });
      notification.onclick = () => {
        globalThis.focus();
        if (project) state.selectProject(project);
        state.openDialog = event.ticket.id;
        notification.close();
      };
    }
  });

  onMount(() => {
    notificationIcon = createNotificationIcon();
    syncPermission();
  });
</script>

<svelte:window onkeydown={(event) => { if (event.key === 'Escape' && state.popover === 'inbox') state.popover = null; }} />

<button
  class="bell"
  aria-label="Notifications"
  aria-expanded={state.popover === 'inbox'}
  title={`${unread} unread notifications`}
  onclick={() => state.popover = state.popover === 'inbox' ? null : 'inbox'}
>
  Inbox
  {#if unread > 0}<span class="badge">{unread > 99 ? '99+' : unread}</span>{/if}
</button>

{#if state.popover === 'inbox'}
  <section class="inbox panel" aria-label="Notifications">
    <header>
      <div>
        <p class="eyebrow">Notification inbox</p>
        <h2>Keep up</h2>
      </div>
      <button class="quiet" disabled={unread === 0} onclick={() => state.markNotificationsRead({ all: true })}>Mark all read</button>
    </header>
    <div class="tabs" role="tablist" aria-label="Notification filters">
      {#each Object.entries(tabLabels) as [tab, label] (tab)}
        <button class:active={state.inboxTab === tab} role="tab" aria-selected={state.inboxTab === tab} onclick={() => state.inboxTab = tab as typeof state.inboxTab}>
          {label}{#if countFor(tab as keyof typeof tabLabels) > 0}<span>{countFor(tab as keyof typeof tabLabels) > 99 ? '99+' : countFor(tab as keyof typeof tabLabels)}</span>{/if}
        </button>
      {/each}
    </div>
    <div class="notification-list">
      {#each state.unreadBuckets[state.inboxTab] as notification (notification.id)}
        <button class:read={isRead(notification)} class:needs={notification.kind === 'reminder'} class="notification" onclick={() => openNotification(notification)}>
          <span class="dot" aria-hidden="true"></span>
          <span class="copy">
            <strong>{notificationTitle(notification)}</strong>
            {#if notificationBody(notification)}<span>{notificationBody(notification)}</span>{/if}
          </span>
          <time>{notificationTime(notification)}</time>
        </button>
      {:else}
        <p class="empty">{emptyCopy[state.inboxTab]}</p>
      {/each}
    </div>
  </section>
{/if}

<style>
  .bell, .quiet, .tabs button, .notification { border: 0; font: inherit; }
  .bell { border: 1px solid var(--border); background: var(--surface); color: var(--text); padding: .5rem .65rem; border-radius: var(--radius); display: inline-flex; align-items: center; gap: .4rem; }
  .badge { min-width: 1.35rem; padding: .08rem .3rem; border-radius: 999px; background: var(--accent); color: var(--text-on-accent); font-size: .72rem; font-weight: 700; }
  .inbox { position: absolute; z-index: 20; right: 1rem; top: 4.25rem; width: min(25rem, calc(100vw - 2rem)); padding: 1rem; box-shadow: var(--shadow); }
  header { display: flex; justify-content: space-between; gap: .75rem; align-items: start; }
  h2, p { margin: 0; }
  .eyebrow { color: var(--text-muted); font-size: .75rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  h2 { margin-top: .2rem; font-size: 1.15rem; }
  .quiet { color: var(--accent); background: transparent; padding: .25rem; white-space: nowrap; }
  .quiet:disabled { color: var(--text-muted); }
  .tabs { display: grid; grid-template-columns: repeat(3, 1fr); gap: .25rem; margin: 1rem 0 .6rem; background: var(--surface-muted); padding: .25rem; border-radius: calc(var(--radius) + 2px); }
  .tabs button { background: transparent; color: var(--text-muted); padding: .4rem .25rem; border-radius: 5px; font-size: .78rem; }
  .tabs button.active { background: var(--surface); color: var(--text); box-shadow: 0 1px 2px rgb(31 41 51 / .12); }
  .tabs span { margin-left: .28rem; color: var(--accent); font-weight: 700; }
  .notification-list { max-height: min(60vh, 34rem); overflow: auto; }
  .notification { width: 100%; display: grid; grid-template-columns: .7rem 1fr auto; gap: .55rem; align-items: start; padding: .72rem .2rem; color: var(--text); text-align: left; background: transparent; border-top: 1px solid var(--border); }
  .notification:first-child { border-top: 0; }
  .notification.read { color: var(--text-muted); }
  .notification.needs strong { color: var(--accent); }
  .dot { width: .42rem; height: .42rem; border-radius: 50%; background: var(--accent); margin-top: .38rem; }
  .read .dot { visibility: hidden; }
  .copy { display: grid; gap: .18rem; min-width: 0; }
  .copy span { color: var(--text-muted); font-size: .82rem; line-height: 1.35; }
  time { color: var(--text-muted); font-size: .75rem; white-space: nowrap; }
  .empty { color: var(--text-muted); padding: .85rem .2rem .25rem; line-height: 1.45; }
</style>
