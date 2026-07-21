<script lang="ts">
  import type { BoardState } from '../../state/board.svelte';
  import type { Ticket } from '../../types';
  import { isStaleClaim, plainText, projectFor, relativeTime } from './surface';

  let { state, ticket, ondragging }: { state: BoardState; ticket: Ticket; ondragging: (value: boolean) => void } = $props();
  const data = $derived(ticket as Ticket & Record<string, unknown>);
  const story = $derived(data.storyId ? state.scopedStories.find((item) => item.id === data.storyId) : undefined);
  const category = $derived(typeof data.category === 'object' ? data.category as { name?: string; description?: string } : undefined);
  const project = $derived(state.raw?.projects.find((item) => item.slug === projectFor(ticket)));
  const assets = $derived(Array.isArray(data.assets) ? data.assets as string[] : []);
  const labels = $derived((data.labels ?? []).slice(0, 4) as string[]);
  const claim = $derived(data.claim as { by?: string; at?: string } | undefined);
  const files = $derived(Array.isArray(data.files) ? data.files as string[] : []);
  const comments = $derived(Array.isArray(data.comments) ? data.comments as unknown[] : []);

  function showImage(filename: string) { state.selectLightboxImage(ticket, filename); }

  function showPlaceholder(event: Event) {
    (event.currentTarget as HTMLImageElement).classList.add('unavailable');
  }

  function rejectTinyImage(event: Event) {
    const image = event.currentTarget as HTMLImageElement;
    if (image.naturalWidth <= 1 || image.naturalHeight <= 1) image.classList.add('unavailable');
  }
</script>

<article class:has-story={Boolean(story)} class="card" draggable="true" ondragstart={() => { ondragging(true); state.setDragging(true); }} ondragend={() => { ondragging(false); state.setDragging(false); }}>
  <button class="card-main" onclick={() => state.openDialog = ticket.id}>
    {#if story}<span class="story-rail" style:background={story.color}></span>{/if}
    <span class="topline"><code>{ticket.ref}</code>{#if state.selectedProject === 'all'}<span class="project">{project?.name ?? projectFor(ticket)}</span>{/if}{#if story}<span class="story" style:--story={story.color}>{story.title}</span>{/if}{#if category?.name}<span class="category">{category.name}</span>{/if}<span class={`priority ${ticket.priority ?? 'normal'}`}>{ticket.priority ?? 'normal'}</span></span>
    <strong>{ticket.title}</strong>
    {#if ticket.description}<span class="description">{plainText(ticket.description)}</span>{/if}
    <span class="footer">
      {#if data.needsReply}<span class="chip reply">needs reply</span>{/if}
      {#if data.blocked}<span class="chip blocked">blocked</span>{/if}
      {#if data.reminder}<span class="chip reminder">reminder</span>{/if}
      {#if data.assignee}<span class="chip assignee">{String(data.assignee).toLowerCase() === 'you' ? 'you' : String(data.assignee)}</span>{/if}
      {#if claim?.by}<span class:stale={isStaleClaim(claim)} class="chip claim">{claim.by}{isStaleClaim(claim) ? ' (stale)' : ''}</span>{/if}
      {#if data.model || data.effort}<span class="chip route">{String(data.model ?? 'any')}{data.effort ? ` · ${String(data.effort)}` : ''}{data.complexity ? ` · C${String(data.complexity)}` : ''}</span>{/if}
      {#each labels as label (label)}<span class="chip label">{label}</span>{/each}
      {#if files.length}<span class="meta" title={files.join(', ')}>files {files.length}</span>{/if}
      {#if comments.length}<span class="meta">comments {comments.length}</span>{/if}
      <time datetime={String(ticket.updatedAt ?? '')}>{relativeTime(ticket.updatedAt)}</time>
    </span>
  </button>
  {#if assets.length}<div class="thumbs">{#each assets.slice(0, 3) as filename (filename)}<button class="thumbnail" aria-label={`Open ${filename}`} onclick={() => showImage(filename)}><img loading="lazy" src={state.api.assetUrl(projectFor(ticket), ticket.id, filename)} alt="" onerror={showPlaceholder} onload={rejectTinyImage} /><span class="thumbnail-label" aria-hidden="true">▧</span></button>{/each}{#if assets.length > 3}<span>+{assets.length - 3}</span>{/if}</div>{/if}
</article>

<style>
  .card { position: relative; display: grid; gap: .45rem; overflow: hidden; padding: .75rem 0; border: 0; border-top: 1px solid var(--border); border-radius: var(--radius); background: transparent; cursor: grab; transition: border-color var(--motion-fast), background var(--motion-fast); } .card:hover { border-color: var(--border-strong); background: var(--bg-deep); } .card:active { cursor: grabbing; } .card-main { display: grid; gap: .45rem; width: 100%; padding: 0; border: 0; background: transparent; color: inherit; text-align: left; font: inherit; cursor: pointer; } .story-rail { position: absolute; inset: 0 auto 0 0; width: 3px; } .topline, .footer { display: flex; align-items: center; flex-wrap: wrap; gap: .35rem; } code { color: var(--text-muted); font: .69rem var(--font-mono); } .project, .priority, .story, .chip, .meta { padding: .2rem .55rem; border: 0; border-radius: 999px; color: var(--text-muted); font-size: .73rem; line-height: 1.25; } .project, .chip.label, .chip.claim.stale, .meta { background: var(--surface-muted); } .priority { margin-left: auto; background: var(--surface-muted); text-transform: uppercase; font-family: var(--font-mono); } .priority.urgent { color: var(--danger); background: color-mix(in oklch, var(--danger), var(--bg) 84%); } .priority.high { color: var(--warning); background: color-mix(in oklch, var(--warning), var(--bg) 84%); } .story { color: var(--story); background: color-mix(in oklch, var(--story), var(--bg) 86%); } .category { color: var(--accent); font-size: .72rem; } strong { font-size: .9rem; line-height: 1.28; } .description { display: -webkit-box; overflow: hidden; color: var(--text-muted); font-size: .76rem; line-height: 1.4; line-clamp: 2; -webkit-box-orient: vertical; -webkit-line-clamp: 2; } .thumbs { display: flex; gap: .35rem; } .thumbs button, .thumbs > span { display: grid; width: 2.75rem; height: 2.75rem; place-items: center; overflow: hidden; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface-muted); color: var(--text-muted); cursor: pointer; font-size: .7rem; } .thumbnail { position: relative; isolation: isolate; } .thumbnail::before { content: ''; position: absolute; z-index: 2; inset: .18rem; border: 1px solid color-mix(in srgb, var(--border), transparent 20%); border-radius: var(--radius); pointer-events: none; } img { position: relative; z-index: 1; width: 100%; height: 100%; object-fit: cover; transition: opacity var(--motion-fast); } img:global(.unavailable) { opacity: 0; } .thumbnail-label { position: absolute; z-index: 0; inset: 0; display: grid; place-items: center; color: color-mix(in srgb, var(--text-muted), transparent 15%); font: 1rem/1 var(--font-mono); } .footer { min-height: 1rem; } .chip.reply, .chip.reminder { color: var(--warning); background: color-mix(in oklch, var(--warning), var(--bg) 84%); } .chip.blocked { color: var(--danger); background: color-mix(in oklch, var(--danger), var(--bg) 84%); } .chip.claim { color: var(--accent); background: var(--accent-soft); } .chip.route { font-family: var(--font-mono); } .meta, time { color: var(--text-muted); font: .72rem var(--font-mono); } time { margin-left: auto; }
</style>
