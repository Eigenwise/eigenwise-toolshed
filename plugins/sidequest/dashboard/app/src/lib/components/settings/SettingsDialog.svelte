<script lang="ts">
  import type { Category, JsonRecord, Project } from '../../types';
  import type { BoardState } from '../../state/board.svelte';

  let { state: board }: { state: BoardState } = $props();

  type CategoryScope = 'default' | 'board';
  type CategoryDraft = {
    id: string;
    name: string;
    description: string;
    model: string;
    effort: string;
    fallbackModel: string;
    fallbackEffort: string;
    contract: string;
    enabled: boolean;
  };

  let categoryScope = $state<CategoryScope>('default');
  let editingCategory = $state<Category | null>(null);
  let categoryDraft = $state<CategoryDraft>(emptyCategoryDraft());
  let draftSentence = $state('');
  let saving = $state(false);
  let categoryEditorOpen = $state(false);

  let selectedProject = $derived(board.currentProject);
  let boardScopeAvailable = $derived(board.selectedProject !== 'all');
  let categoryProject = $derived(categoryScope === 'board' && boardScopeAvailable ? board.selectedProject : undefined);
  let categories = $derived((board.raw?.categories ?? []).filter((category) => categoryScope === 'default' || !category.dangling));
  let models = $derived(modelOptions());
  let efforts = $derived(effortOptions());
  let globalFallback = $derived(record(board.routingCatalog.globalFallback));

  function record(value: unknown): JsonRecord {
    return value && typeof value === 'object' ? value as JsonRecord : {};
  }

  function text(value: unknown, fallback = '') {
    return typeof value === 'string' ? value : fallback;
  }

  function optionValues(value: unknown) {
    return Array.isArray(value) ? value.map((item) => typeof item === 'string' ? item : text(record(item).slug, text(record(item).k))).filter(Boolean) : [];
  }

  function modelOptions() {
    const catalog = board.routingCatalog;
    return [...new Set([...optionValues(catalog.models), ...optionValues(catalog.discovered), 'sonnet', 'opus', 'haiku'])];
  }

  function effortOptions() {
    return [...new Set([...optionValues(board.routingCatalog.efforts), 'low', 'medium', 'high', 'xhigh'])];
  }

  function emptyCategoryDraft(): CategoryDraft {
    return { id: '', name: '', description: '', model: 'sonnet', effort: 'high', fallbackModel: '', fallbackEffort: 'high', contract: '', enabled: true };
  }

  function routeValue(category: Category, field: 'route' | 'fallback', key: 'model' | 'effort', fallback: string) {
    return text(record(category[field])[key], fallback);
  }

  function startCategoryEdit(category: Category | null = null) {
    categoryEditorOpen = true;
    editingCategory = category;
    categoryDraft = category ? {
      id: category.id,
      name: category.name,
      description: text(category.description),
      model: routeValue(category, 'route', 'model', 'sonnet'),
      effort: routeValue(category, 'route', 'effort', 'high'),
      fallbackModel: routeValue(category, 'fallback', 'model', ''),
      fallbackEffort: routeValue(category, 'fallback', 'effort', 'high'),
      contract: text(category.contract),
      enabled: category.enabled !== false
    } : emptyCategoryDraft();
  }

  function categoryPayload(): JsonRecord {
    return {
      id: categoryDraft.id.trim().toLowerCase(),
      name: categoryDraft.name.trim(),
      description: categoryDraft.description.trim(),
      route: { model: categoryDraft.model, effort: categoryDraft.effort },
      fallback: categoryDraft.fallbackModel ? { model: categoryDraft.fallbackModel, effort: categoryDraft.fallbackEffort } : null,
      contract: categoryDraft.contract.trim(),
      enabled: categoryDraft.enabled,
      ...(categoryProject ? { project: categoryProject } : {})
    };
  }

  async function saveCategory() {
    const body = categoryPayload();
    if (!text(body.id) || !text(body.name)) {
      board.toast('Category ID and name are required.');
      return;
    }
    saving = true;
    try {
      if (editingCategory) await board.updateCategory(editingCategory, body, categoryProject);
      else await board.createCategory(body);
      board.toast(`Category ${editingCategory ? 'saved' : 'added'}.`);
      editingCategory = null;
      categoryEditorOpen = false;
    } finally {
      saving = false;
    }
  }

  async function createDraft() {
    if (!draftSentence.trim()) return;
    try {
      const response = await board.draftCategory(draftSentence, categoryProject);
      const draft = response.draft;
      categoryDraft.id = text(draft.id, categoryDraft.id);
      categoryDraft.name = text(draft.name, categoryDraft.name);
      categoryDraft.description = text(draft.description, categoryDraft.description);
      categoryDraft.contract = text(draft.contract, categoryDraft.contract);
      const route = record(draft.route);
      categoryDraft.model = text(route.model, categoryDraft.model);
      categoryDraft.effort = text(route.effort, categoryDraft.effort);
      board.toast('Draft ready for review.');
    } catch (error) {
      board.toast(error instanceof Error ? error.message : 'Unable to draft category.');
    }
  }

  async function updateFallback(event: Event) {
    const target = event.currentTarget as HTMLSelectElement;
    await board.setGlobalFallback({ model: target.value, effort: text(globalFallback.effort, 'high') });
    board.toast('Global fallback saved.');
  }

  async function updateFallbackEffort(event: Event) {
    const target = event.currentTarget as HTMLSelectElement;
    await board.setGlobalFallback({ model: text(globalFallback.model, 'sonnet'), effort: target.value });
    board.toast('Global fallback saved.');
  }

  async function requestDesktopNotifications() {
    if (!('Notification' in globalThis)) {
      board.setDesktopNotificationPermission('unsupported');
      return;
    }
    const permission = await globalThis.Notification.requestPermission();
    board.setDesktopNotificationPermission(permission);
    board.toast(permission === 'granted' ? 'Desktop notifications enabled.' : 'Desktop notifications remain off.');
  }

  async function setNotificationKind(kind: string, enabled: boolean) {
    await board.setNotifyPreferences({ ...board.notifyPreferences, [kind]: enabled });
    board.toast('Notification preferences saved.');
  }

  function inputValue(event: Event) {
    return (event.currentTarget as HTMLInputElement).value;
  }

  function checkboxValue(event: Event) {
    return (event.currentTarget as HTMLInputElement).checked;
  }

  function selectValue(event: Event) {
    return (event.currentTarget as HTMLSelectElement).value;
  }

  function ignoresShortcut(target: EventTarget | null) {
    const element = target instanceof Element ? target : null;
    return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'));
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      if (board.popover === 'project-menu') board.popover = null;
      else if (board.popover === 'settings') board.popover = null;
      else if (board.lightbox) board.closeLightbox();
      else if (board.openDialog) board.openDialog = null;
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      void board.saveDialogFromShortcut(event);
      return;
    }
    if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey && !board.openDialog && !ignoresShortcut(event.target)) {
      event.preventDefault();
      board.openDialog = 'create';
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<button class="settings-trigger" aria-expanded={board.popover === 'settings'} onclick={() => board.popover = board.popover === 'settings' ? null : 'settings'}>Settings</button>

{#if board.popover === 'settings'}
  <div class="backdrop" role="presentation" onclick={() => board.popover = null}>
    <dialog class="settings panel" open aria-label="Settings" onclick={(event) => event.stopPropagation()}>
      <header>
        <div><p class="eyebrow">Sidequest</p><h2>Settings</h2></div>
        <button class="close" aria-label="Close settings" onclick={() => board.popover = null}>Close</button>
      </header>
      <div class="settings-grid">
        <section class="routing-section">
          <p class="eyebrow">Execution</p>
          <h3>Board routing</h3>
          {#if selectedProject}
            <label class="switch"><input type="checkbox" checked={selectedProject.routing !== 'disabled'} onchange={(event) => board.setProjectRouting(selectedProject as Project, checkboxValue(event) ? 'enabled' : 'disabled')} /><span><strong>Routing enabled</strong><small>Direct claims still work when routing is off.</small></span></label>
          {:else}
            <p class="hint">Open a board to change its routing.</p>
          {/if}
          {#if selectedProject?.routing !== 'disabled'}
            <label class="field"><span>Global fallback model</span><select value={text(globalFallback.model, 'sonnet')} onchange={updateFallback}>{#each models as model (model)}<option value={model}>{model}</option>{/each}</select></label>
            <label class="field"><span>Global fallback effort</span><select value={text(globalFallback.effort, 'high')} onchange={updateFallbackEffort}>{#each efforts as effort (effort)}<option value={effort}>{effort}</option>{/each}</select></label>
          {/if}

          <div class="category-heading"><div><h3>Categories</h3><p class="hint">Routes for ticket work.</p></div><button onclick={() => startCategoryEdit()}>Add category</button></div>
          <div class="scope-tabs" role="tablist" aria-label="Category scope">
            <button class:active={categoryScope === 'default'} onclick={() => categoryScope = 'default'}>Default settings</button>
            <button class:active={categoryScope === 'board'} disabled={!boardScopeAvailable} title={boardScopeAvailable ? '' : 'Open a board to edit local categories'} onclick={() => categoryScope = 'board'}>Board settings</button>
          </div>
          {#if categoryEditorOpen}
            <form class="category-form" onsubmit={(event) => { event.preventDefault(); void saveCategory(); }}>
              <h4>{editingCategory ? `Edit ${editingCategory.name}` : `Add ${categoryScope === 'board' ? 'board' : 'default'} category`}</h4>
              {#if board.routingCatalog.categoryDraftAvailable}<label class="field"><span>Describe a category</span><div class="draft-row"><input value={draftSentence} oninput={(event) => draftSentence = inputValue(event)} placeholder="One sentence is enough" /><button type="button" onclick={() => void createDraft()}>Draft</button></div></label>{/if}
              <label class="field"><span>Category ID</span><input required disabled={Boolean(editingCategory)} value={categoryDraft.id} oninput={(event) => categoryDraft.id = inputValue(event)} /></label>
              <label class="field"><span>Name</span><input required value={categoryDraft.name} oninput={(event) => categoryDraft.name = inputValue(event)} /></label>
              <label class="field"><span>Classifier description</span><textarea value={categoryDraft.description} oninput={(event) => categoryDraft.description = inputValue(event)}></textarea></label>
              <div class="route-fields"><label class="field"><span>Primary model</span><select value={categoryDraft.model} onchange={(event) => categoryDraft.model = selectValue(event)}>{#each models as model (model)}<option value={model}>{model}</option>{/each}</select></label><label class="field"><span>Effort</span><select value={categoryDraft.effort} onchange={(event) => categoryDraft.effort = selectValue(event)}>{#each efforts as effort (effort)}<option value={effort}>{effort}</option>{/each}</select></label></div>
              <div class="route-fields"><label class="field"><span>Fallback model</span><select value={categoryDraft.fallbackModel} onchange={(event) => categoryDraft.fallbackModel = selectValue(event)}><option value="">Use global fallback</option>{#each models as model (model)}<option value={model}>{model}</option>{/each}</select></label><label class="field"><span>Fallback effort</span><select value={categoryDraft.fallbackEffort} disabled={!categoryDraft.fallbackModel} onchange={(event) => categoryDraft.fallbackEffort = selectValue(event)}>{#each efforts as effort (effort)}<option value={effort}>{effort}</option>{/each}</select></label></div>
              <label class="field"><span>Executor instructions</span><textarea value={categoryDraft.contract} oninput={(event) => categoryDraft.contract = inputValue(event)}></textarea></label>
              {#if categoryScope === 'default'}<label class="switch"><input type="checkbox" checked={categoryDraft.enabled} onchange={(event) => categoryDraft.enabled = checkboxValue(event)} /><span><strong>Enabled</strong><small>Available for ticket routing.</small></span></label>{/if}
              <div class="form-actions"><button type="button" onclick={() => categoryEditorOpen = false}>Cancel</button><button class="primary" disabled={saving} type="submit">{saving ? 'Saving…' : 'Save category'}</button></div>
            </form>
          {:else}
            <div class="category-list">
              {#each categories as category (category.id)}
                <article class:disabled={category.disabled || category.enabled === false} class="category-row">
                  <div><strong>{category.name}</strong><code>{category.id}</code><small>{text(category.description, 'No classifier description')}</small></div>
                  <div class="category-meta"><span>{text(record(category.resolved).model, text(record(category.route).model, 'default'))} · {text(record(category.resolved).effort, text(record(category.route).effort, 'high'))}</span><span>{text(category.usageCount, '0')} tickets</span></div>
                  <div class="category-actions"><button onclick={() => startCategoryEdit(category)}>Edit</button>{#if categoryScope === 'board'}{#if category.disabled}<button onclick={() => void board.deleteCategory(category, categoryProject)}>Re-enable</button>{:else}<button onclick={() => void board.detachCategory(category, board.selectedProject)}>Detach</button><button onclick={() => void board.disableCategory(category, board.selectedProject)}>Disable</button>{#if category.layer}<button onclick={() => void board.relinkCategory(category, board.selectedProject)}>Reset</button>{/if}{/if}{/if}{#if category.id !== 'general'}<button class="danger" onclick={() => void board.deleteCategory(category, categoryProject)}>Delete</button>{/if}</div>
                </article>
              {:else}
                <p class="hint">No categories in this scope.</p>
              {/each}
            </div>
          {/if}
        </section>

        <section class="notifications-section">
          <p class="eyebrow">Notifications</p>
          <h3>Keep the signal useful</h3>
          <button class="permission" onclick={() => void requestDesktopNotifications()}><strong>Desktop notifications</strong><span>{board.desktopNotificationPermission === 'granted' ? 'Enabled' : board.desktopNotificationPermission === 'unsupported' ? 'Unsupported here' : 'Click to enable'}</span></button>
          <div class="preference-list">
            {#each ['question', 'comment', 'created', 'status'] as kind (kind)}
              <label class="switch"><input type="checkbox" checked={board.notifyPreferences[kind] !== false} onchange={(event) => void setNotificationKind(kind, checkboxValue(event))} /><span><strong>{kind}</strong><small>{kind === 'question' ? 'Questions waiting for your reply.' : `Notify when a ticket is ${kind}.`}</small></span></label>
            {/each}
          </div>
          <h3>Per-board mute</h3>
          <div class="project-list">
            {#each board.raw?.projects ?? [] as project (project.slug)}
              <label class="switch"><input type="checkbox" checked={project.notify !== false} onchange={(event) => void board.setProjectMuted(project, !checkboxValue(event))} /><span><strong>{project.name}</strong><small>{project.notify === false ? 'Muted' : 'Notifications on'}</small></span></label>
            {:else}<p class="hint">No boards yet.</p>{/each}
          </div>
          <p class="shortcut-hint"><kbd>N</kbd> creates a ticket. <kbd>Ctrl</kbd> or <kbd>⌘</kbd> + <kbd>Enter</kbd> saves the current dialog. <kbd>Esc</kbd> closes the topmost panel.</p>
        </section>
      </div>
    </dialog>
  </div>
{/if}

<style>
  button, input, textarea, select { font: inherit; }
  button { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text); padding: .42rem .6rem; }
  button.primary { background: var(--accent); color: white; border-color: var(--accent); }
  button.danger { color: var(--danger); }
  button:disabled { cursor: not-allowed; opacity: .55; }
  .settings-trigger { padding: .5rem .65rem; }
  .backdrop { position: fixed; z-index: 30; inset: 0; display: grid; place-items: start center; padding: 3rem 1rem; background: rgb(31 41 51 / .18); overflow: auto; }
  .settings { width: min(66rem, 100%); padding: 1.25rem; box-shadow: var(--shadow); }
  header, .category-heading, .form-actions { display: flex; align-items: start; justify-content: space-between; gap: .75rem; }
  .eyebrow { color: var(--text-muted); font-size: .72rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; margin: 0; }
  h2, h3, h4, p { margin-top: 0; } h2 { margin-bottom: 0; } h3 { margin-bottom: .35rem; } h4 { margin-bottom: .65rem; }
  .close { border: 0; background: transparent; color: var(--text-muted); }
  .settings-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(15rem, .8fr); gap: 1.25rem; margin-top: 1.25rem; }
  .notifications-section { border-left: 1px solid var(--border); padding-left: 1.25rem; }
  .field { display: grid; gap: .3rem; margin: .65rem 0; font-size: .86rem; }
  .field > span { color: var(--text-muted); font-weight: 600; }
  input, textarea, select { width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); padding: .45rem; }
  textarea { min-height: 4.5rem; resize: vertical; }
  .switch { display: flex; gap: .6rem; align-items: start; padding: .6rem 0; border-bottom: 1px solid var(--border); }
  .switch input { width: auto; margin-top: .2rem; accent-color: var(--accent); }
  .switch span { display: grid; gap: .08rem; }
  .switch small, .hint, .shortcut-hint { color: var(--text-muted); line-height: 1.4; }
  .scope-tabs { display: flex; gap: .35rem; margin: .8rem 0; }
  .scope-tabs button.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
  .category-list { display: grid; gap: .55rem; }
  .category-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .4rem 1rem; border: 1px solid var(--border); border-radius: var(--radius); padding: .7rem; }
  .category-row.disabled { opacity: .62; }
  .category-row code, .category-row small, .category-meta { display: block; color: var(--text-muted); font-size: .78rem; margin-top: .16rem; }
  .category-meta { text-align: right; }
  .category-actions { grid-column: 1 / -1; display: flex; gap: .35rem; flex-wrap: wrap; }
  .category-form { border: 1px solid var(--border); border-radius: var(--radius); padding: .8rem; background: var(--surface-muted); }
  .route-fields, .draft-row { display: grid; grid-template-columns: 1fr 1fr; gap: .55rem; }
  .draft-row { grid-template-columns: 1fr auto; }
  .permission { width: 100%; text-align: left; display: grid; gap: .12rem; margin: .2rem 0 .65rem; background: var(--accent-soft); border-color: var(--accent); }
  .permission span { color: var(--accent); font-size: .82rem; }
  .preference-list, .project-list { margin-bottom: 1.25rem; }
  .shortcut-hint { font-size: .8rem; border-top: 1px solid var(--border); padding-top: .8rem; }
  kbd { border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; background: var(--surface-muted); padding: .05rem .22rem; font-family: var(--font-mono); }
  @media (max-width: 880px) { .settings-grid { grid-template-columns: 1fr; } .notifications-section { border-left: 0; border-top: 1px solid var(--border); padding: 1.25rem 0 0; } }
  @media (max-width: 560px) { .backdrop { padding: 0; } .settings { border-radius: 0; min-height: 100%; } .category-row { grid-template-columns: 1fr; } .category-meta { text-align: left; } .route-fields { grid-template-columns: 1fr; } }
</style>
