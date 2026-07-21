<script lang="ts">
  import { onMount } from 'svelte';
  import type { Category, JsonRecord, Project, RoutingPreview, RoutingProfile } from '../../types';
  import type { BoardState } from '../../state/board.svelte';
  import Dialog from '../ui/Dialog.svelte';
  import Select, { type SelectOption } from '../ui/Select.svelte';

  let { state: board }: { state: BoardState } = $props();

  type CategoryScope = 'profile' | 'board';
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

  let categoryScope = $state<CategoryScope>('profile');
  let selectedProfileId = $state('');
  let profileInfo = $state<RoutingProfile | null>(null);
  let profileCategories = $state.raw<Category[]>([]);
  let profileBoardCount = $state(0);
  let boardProfile = $state<RoutingProfile | null>(null);
  let repointTarget = $state('');
  let routingPreview = $state<RoutingPreview | null>(null);
  let previewLoading = $state(false);
  let editingCategory = $state<Category | null>(null);
  let categoryDraft = $state<CategoryDraft>(emptyCategoryDraft());
  let draftSentence = $state('');
  let saving = $state(false);
  let categoryEditorOpen = $state(false);
  let theme = $state<'light' | 'dark'>('light');

  function setTheme(value: 'light' | 'dark') {
    theme = value;
    document.documentElement.dataset.theme = value;
    localStorage.setItem('sq_theme', value);
  }

  onMount(() => {
    const storedTheme = localStorage.getItem('sq_theme');
    setTheme(storedTheme === 'dark' ? 'dark' : 'light');
  });

  let selectedProject = $derived(board.currentProject);
  let boardScopeAvailable = $derived(board.selectedProject !== 'all');
  let categoryProject = $derived(categoryScope === 'board' && boardScopeAvailable ? board.selectedProject : undefined);
  let categories = $derived(categoryScope === 'profile' ? profileCategories : (board.raw?.categories ?? []).filter((category) => !category.dangling));
  let profileOptions = $derived<SelectOption[]>(board.routingProfiles.map((profile) => ({ value: profile.id, label: `${profile.name} · r${profile.revision}` })));
  let models = $derived(modelOptions());
  let efforts = $derived(effortOptions());
  let modelSelectOptions = $derived<SelectOption[]>(models.map((value) => ({ value, label: value })));
  let effortSelectOptions = $derived<SelectOption[]>(efforts.map((value) => ({ value, label: value })));
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
      if (categoryScope === 'profile') {
        if (!selectedProfileId) throw new Error('Choose a routing profile first.');
        if (editingCategory) await board.updateProfileCategory(selectedProfileId, editingCategory, body);
        else await board.createProfileCategory(selectedProfileId, body);
        await loadProfile(selectedProfileId);
        board.toast(`Saved profile changes for ${profileBoardCount} board${profileBoardCount === 1 ? '' : 's'}.`);
      } else {
        if (editingCategory) await board.updateCategory(editingCategory, body, categoryProject);
        else await board.createCategory(body);
        board.toast(`Category ${editingCategory ? 'saved' : 'added'}.`);
      }
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

  async function updateFallback(value: string) {
    await board.setGlobalFallback({ model: value, effort: text(globalFallback.effort, 'high') });
    board.toast('Global fallback saved.');
  }

  async function updateFallbackEffort(value: string) {
    await board.setGlobalFallback({ model: text(globalFallback.model, 'sonnet'), effort: value });
    board.toast('Global fallback saved.');
  }

  async function loadProfile(id: string) {
    if (!id) return;
    const [detail, categories] = await Promise.all([board.api.routingProfile(id), board.api.categories('all', id)]);
    selectedProfileId = id;
    profileInfo = detail.profile;
    profileBoardCount = detail.boardCount;
    profileCategories = categories.categories;
  }

  async function loadBoardRouting() {
    if (!boardScopeAvailable) { boardProfile = null; routingPreview = null; return; }
    const selected = await board.api.projectRoutingProfile(board.selectedProject);
    boardProfile = selected.profile;
    repointTarget = selected.profile.id;
    await previewRepoint(selected.profile.id);
  }

  async function previewRepoint(profileId: string) {
    repointTarget = profileId;
    if (!boardScopeAvailable || !profileId) return;
    previewLoading = true;
    try { routingPreview = await board.routingPreview(board.selectedProject, profileId); }
    catch (error) { board.toast(error instanceof Error ? error.message : 'Unable to preview this profile.'); }
    finally { previewLoading = false; }
  }

  async function applyRepoint() {
    if (!boardScopeAvailable || !repointTarget || repointTarget === boardProfile?.id) return;
    await board.setProjectRoutingProfile(board.selectedProject, repointTarget);
    await loadBoardRouting();
    board.toast('Board routing profile updated.');
  }

  async function openSettings() {
    board.popover = 'settings';
    try {
      await board.loadRoutingProfiles();
      const first = board.routingProfiles.find((profile) => profile.id === selectedProfileId) || board.routingProfiles[0];
      if (first) await loadProfile(first.id);
      await loadBoardRouting();
    } catch (error) { board.toast(error instanceof Error ? error.message : 'Unable to load routing settings.'); }
  }

  function rowBadge(category: Category) {
    if (category.disabled || category.origin === 'disabled') return 'Disabled';
    if (category.layer?.kind === 'ADD' || category.origin === 'added') return 'Board-only';
    if (category.layer?.kind === 'DETACH' || category.origin === 'detached') return 'Pinned';
    if (category.layer?.kind === 'OVERRIDE' || category.origin === 'override') return 'Override';
    return 'Profile';
  }

  function foreignBase(category: Category) {
    return (Array.isArray(category.warnings) ? category.warnings : []).find((warning) => record(warning).kind === 'foreign-base') as JsonRecord | undefined;
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

<button class="settings-trigger" aria-expanded={board.popover === 'settings'} onclick={() => board.popover === 'settings' ? board.popover = null : void openSettings()}>Settings</button>

{#if board.popover === 'settings'}
  <Dialog open={true} wide label="Settings" onclose={() => board.popover = null}>
    <div class="settings-frame">
      <header>
        <div><p class="eyebrow">Sidequest</p><h2>Settings</h2></div>
        <button class="close" aria-label="Close settings" onclick={() => board.popover = null}>Close</button>
      </header>
      <div class="settings-body">
      <div class="settings-grid">
        <section class="routing-section">
          <p class="eyebrow">Execution</p>
          <h3>Availability fallback</h3>
          <p class="hint">Used after a category route and category fallback are unavailable.</p>
          <label class="field"><span>Global fallback model</span><Select label="Global fallback model" value={text(globalFallback.model, 'sonnet')} options={modelSelectOptions} onchange={updateFallback} /></label>
          <label class="field"><span>Global fallback effort</span><Select label="Global fallback effort" value={text(globalFallback.effort, 'high')} options={effortSelectOptions} onchange={updateFallbackEffort} /></label>

          <div class="routing-panel">
            <div class="category-heading"><div><p class="eyebrow">Board routing</p><h3>{selectedProject?.name ?? 'Choose a board'}</h3><p class="hint">A board follows one routing profile, then applies its own local changes.</p></div>{#if board.raw?.categories.some((category) => category.layer)}<span class="change-badge">{board.raw?.categories.filter((category) => category.layer).length} local changes</span>{/if}</div>
            {#if selectedProject}
              <label class="switch"><input type="checkbox" checked={selectedProject.routing !== 'disabled'} onchange={(event) => void board.setProjectRouting(selectedProject as Project, checkboxValue(event) ? 'enabled' : 'disabled')} /><span><strong>Routing enabled</strong><small>Direct claims still work when routing is off.</small></span></label>
              <label class="field"><span>Routing profile</span><Select label="Routing profile" value={repointTarget} options={profileOptions} onchange={(value) => void previewRepoint(value)} /></label>
              {#if boardProfile}<p class="routing-note">Following <strong>{boardProfile.name}</strong> · revision {boardProfile.revision} · {boardProfile.entryCount} categories</p>{/if}
              {#if routingPreview && routingPreview.to.id !== routingPreview.from.id}
                <div class="preview" aria-live="polite"><strong>Repoint preview</strong><span>{routingPreview.drift.changed.length} changed · {routingPreview.drift.missing.length} missing · {routingPreview.drift.added.length} added</span>{#if routingPreview.addCollisions.length}<small>ADD collisions: {routingPreview.addCollisions.join(', ')}</small>{/if}{#if routingPreview.foreignBase.length}<small>Foreign-base rows: {routingPreview.foreignBase.map((row) => row.id).join(', ')}</small>{/if}{#if routingPreview.preparedDispatches.length}<small>{routingPreview.preparedDispatches.length} prepared dispatches will be superseded.</small>{/if}<button class="primary" disabled={previewLoading} onclick={() => void applyRepoint()}>Use this profile</button></div>
              {/if}
            {:else}<p class="hint">Open a board to preview or change its routing profile.</p>{/if}
          </div>

          <div class="profile-library">
            <div class="category-heading"><div><p class="eyebrow">Profile library</p><h3>{profileInfo?.name ?? 'Routing profiles'}</h3><p class="hint">Saving profile changes updates {profileBoardCount} board{profileBoardCount === 1 ? '' : 's'}.</p></div><button onclick={() => startCategoryEdit()}>Add category</button></div>
            <label class="field"><span>Profile</span><Select label="Profile library" value={selectedProfileId} options={profileOptions} onchange={(value) => void loadProfile(value)} /></label>
            <div class="scope-tabs" role="tablist" aria-label="Routing category view">
              <button class:active={categoryScope === 'profile'} onclick={() => categoryScope = 'profile'}>Profile library</button>
              <button class:active={categoryScope === 'board'} disabled={!boardScopeAvailable} title={boardScopeAvailable ? '' : 'Open a board to inspect local categories'} onclick={() => categoryScope = 'board'}>Board changes</button>
            </div>
            {#if categoryEditorOpen}
              <form class="category-form" onsubmit={(event) => { event.preventDefault(); void saveCategory(); }}>
                <h4>{editingCategory ? `Edit ${editingCategory.name}` : `Add ${categoryScope === 'board' ? 'board-only' : profileInfo?.name ?? 'profile'} category`}</h4>
                {#if board.routingCatalog.categoryDraftAvailable}<label class="field"><span>Describe a category</span><div class="draft-row"><input value={draftSentence} oninput={(event) => draftSentence = inputValue(event)} placeholder="One sentence is enough" /><button type="button" onclick={() => void createDraft()}>Draft</button></div></label>{/if}
                <label class="field"><span>Category ID</span><input required disabled={Boolean(editingCategory)} value={categoryDraft.id} oninput={(event) => categoryDraft.id = inputValue(event)} /></label>
                <label class="field"><span>Name</span><input required value={categoryDraft.name} oninput={(event) => categoryDraft.name = inputValue(event)} /></label>
                <label class="field"><span>Classifier description</span><textarea value={categoryDraft.description} oninput={(event) => categoryDraft.description = inputValue(event)}></textarea></label>
                <div class="route-fields"><label class="field"><span>Primary model</span><Select label="Primary model" value={categoryDraft.model} options={modelSelectOptions} onchange={(value) => { categoryDraft.model = value; }} /></label><label class="field"><span>Effort</span><Select label="Effort" value={categoryDraft.effort} options={effortSelectOptions} onchange={(value) => { categoryDraft.effort = value; }} /></label></div>
                <div class="route-fields"><label class="field"><span>Fallback model</span><Select label="Fallback model" value={categoryDraft.fallbackModel} options={[{ value: '', label: 'Use global fallback' }, ...modelSelectOptions]} onchange={(value) => { categoryDraft.fallbackModel = value; }} /></label><label class="field"><span>Fallback effort</span><Select label="Fallback effort" value={categoryDraft.fallbackEffort} options={effortSelectOptions} disabled={!categoryDraft.fallbackModel} onchange={(value) => { categoryDraft.fallbackEffort = value; }} /></label></div>
                <label class="field"><span>Executor instructions</span><textarea value={categoryDraft.contract} oninput={(event) => categoryDraft.contract = inputValue(event)}></textarea></label>
                <label class="switch"><input type="checkbox" checked={categoryDraft.enabled} onchange={(event) => categoryDraft.enabled = checkboxValue(event)} /><span><strong>Enabled</strong><small>Available for ticket routing.</small></span></label>
                <div class="form-actions"><button type="button" onclick={() => categoryEditorOpen = false}>Cancel</button><button class="primary" disabled={saving} type="submit">{saving ? 'Saving…' : `Save, updates ${profileBoardCount} board${profileBoardCount === 1 ? '' : 's'}`}</button></div>
              </form>
            {:else}
              <div class="category-list">
                {#each categories as category (category.id)}
                  <article class:disabled={category.disabled || category.enabled === false} class="category-row">
                    <div><strong>{category.name}</strong><span class="row-badge">{rowBadge(category)}</span><code>{category.id}</code><small>{text(category.description, 'No classifier description')}</small>{#if foreignBase(category)}<small class="foreign">Based on {text(foreignBase(category)?.baseProfileId)}, board now uses {text(foreignBase(category)?.profileId)}.</small>{/if}</div>
                    <div class="category-meta"><span>{text(record(category.resolved).model, text(record(category.route).model, 'default'))} · {text(record(category.resolved).effort, text(record(category.route).effort, 'high'))}</span><span>{text(category.usageCount, '0')} tickets</span></div>
                    <div class="category-actions"><button onclick={() => startCategoryEdit(category)}>Edit</button>{#if categoryScope === 'board'}{#if category.disabled}<button onclick={() => void board.relinkCategory(category, board.selectedProject)}>Re-enable</button>{:else}{#if rowBadge(category) === 'Pinned'}<button disabled>Pinned</button>{:else}<button onclick={() => void board.detachCategory(category, board.selectedProject)}>Keep pinned</button>{/if}<button onclick={() => void board.relinkCategory(category, board.selectedProject)}>Relink</button><button onclick={() => void board.disableCategory(category, board.selectedProject)}>Disable</button>{/if}{:else}{#if category.id !== 'general'}<button class="danger" onclick={() => void board.deleteProfileCategory(selectedProfileId, category)}>Delete</button>{/if}{/if}</div>
                  </article>
                {:else}<p class="hint">No categories in this view.</p>{/each}
              </div>
            {/if}
          </div>
        </section>

        <section class="notifications-section">
          <p class="eyebrow">Appearance</p>
          <h3>Theme</h3>
          <label class="switch"><input type="checkbox" checked={theme === 'dark'} onchange={(event) => setTheme(checkboxValue(event) ? 'dark' : 'light')} /><span><strong>Dark theme</strong><small>Use the Eigenwise dark palette.</small></span></label>
          <p class="eyebrow">Notifications</p>
          <h3>Keep the signal useful</h3>
          <button class="permission" onclick={() => void requestDesktopNotifications()}><strong>Desktop notifications</strong><span>{board.desktopNotificationPermission === 'granted' ? 'Enabled' : board.desktopNotificationPermission === 'unsupported' ? 'Unsupported here' : 'Click to enable'}</span></button>
          <div class="preference-list">
            {#each ['comment', 'created', 'status'] as kind (kind)}
              <label class="switch"><input type="checkbox" checked={board.notifyPreferences[kind] !== false} onchange={(event) => void setNotificationKind(kind, checkboxValue(event))} /><span><strong>{kind}</strong><small>Notify when a ticket is {kind}.</small></span></label>
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
      </div>
    </div>
  </Dialog>
{/if}

<style>
  button, input, textarea { font: inherit; }
  button { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text); padding: .42rem .6rem; }
  button.primary { background: var(--accent); color: var(--text-on-accent); border-color: var(--accent); }
  button.danger { color: var(--danger); }
  button:disabled { cursor: not-allowed; opacity: .55; }
  .settings-trigger { box-sizing: border-box; height: var(--control-height); min-height: var(--control-height); padding: .5rem .65rem; }
  .settings-frame { display: grid; grid-template-rows: auto minmax(0, 1fr); max-block-size: inherit; padding: 1.25rem 1.25rem 0; }
  .settings-body { min-block-size: 0; overflow: auto; padding: 1.25rem .15rem 1.25rem 0; scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
  .settings-body::-webkit-scrollbar { width: .55rem; }
  .settings-body::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 999px; }
  header, .category-heading, .form-actions { display: flex; align-items: start; justify-content: space-between; gap: .75rem; }
  .eyebrow { color: var(--text-muted); font-size: .72rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; margin: 0; }
  h2, h3, h4, p { margin-top: 0; } h2 { margin-bottom: 0; } h3 { margin-bottom: .35rem; } h4 { margin-bottom: .65rem; }
  .close { border: 0; background: transparent; color: var(--text-muted); }
  .settings-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(15rem, .8fr); gap: 1.25rem; margin-top: 1.25rem; }
  .notifications-section { border-left: 1px solid var(--border); padding-left: 1.25rem; }
  .field { display: grid; gap: .3rem; margin: .65rem 0; font-size: .86rem; }
  .field > span { color: var(--text-muted); font-weight: 600; }
  input, textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text); padding: .45rem; }
  textarea { min-height: 4.5rem; resize: vertical; }
  .switch { display: flex; gap: .6rem; align-items: start; padding: .6rem 0; border-bottom: 1px solid var(--border); }
  .switch input { width: auto; margin-top: .2rem; accent-color: var(--accent); }
  .switch span { display: grid; gap: .08rem; }
  .switch small, .hint, .shortcut-hint { color: var(--text-muted); line-height: 1.4; }
  .scope-tabs { display: flex; gap: .35rem; margin: .8rem 0; }
  .routing-panel, .profile-library { border-top: 1px solid var(--border); margin-top: 1rem; padding-top: 1rem; }
  .routing-note { color: var(--text-muted); font-size: .82rem; }
  .change-badge, .row-badge { display: inline-flex; align-items: center; width: fit-content; border: 1px solid var(--border-strong); background: var(--accent-soft); color: var(--accent); font-size: .7rem; font-weight: 700; letter-spacing: .04em; padding: .1rem .3rem; text-transform: uppercase; }
  .preview { display: grid; gap: .35rem; margin-top: .8rem; padding: .7rem; border: 1px solid var(--border-strong); background: var(--surface-muted); font-size: .82rem; }
  .preview small, .foreign { color: var(--text-muted); }
  .foreign { color: var(--accent); }
  .scope-tabs button.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
  .category-list { display: grid; gap: .55rem; }
  .category-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: .35rem 1rem; border: 1px solid var(--border); border-radius: 3px; padding: .6rem .7rem; background: var(--surface-muted); }
  .category-row.disabled { opacity: .62; }
  .category-row code, .category-row small, .category-meta { display: block; color: var(--text-muted); font-size: .78rem; margin-top: .16rem; }
  .category-row small { display: -webkit-box; overflow: hidden; line-height: 1.35; line-clamp: 2; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
  .category-meta { align-self: start; min-inline-size: 9rem; text-align: right; font-family: var(--font-mono); }
  .category-actions { grid-column: 1 / -1; display: flex; gap: .35rem; flex-wrap: wrap; }
  .category-form { border: 1px solid var(--border); border-radius: var(--radius); padding: .8rem; background: var(--surface-muted); }
  .route-fields, .draft-row { display: grid; grid-template-columns: 1fr 1fr; gap: .55rem; }
  .draft-row { grid-template-columns: 1fr auto; }
  .permission { width: 100%; text-align: left; display: grid; gap: .12rem; margin: .2rem 0 .65rem; background: var(--accent-soft); border-color: var(--accent); }
  .permission span { color: var(--accent); font-size: .82rem; }
  .preference-list, .project-list { margin-bottom: 1.25rem; }
  .shortcut-hint { font-size: .8rem; border-top: 1px solid var(--border); padding-top: .8rem; }
  kbd { border: 1px solid var(--border); border-bottom-width: 2px; border-radius: var(--radius); background: var(--surface-muted); padding: .05rem .22rem; font-family: var(--font-mono); }
  @media (max-width: 880px) { .settings-grid { grid-template-columns: 1fr; } .notifications-section { border-left: 0; border-top: 1px solid var(--border); padding: 1.25rem 0 0; } }
  @media (max-width: 560px) { .settings-frame { padding: 1rem 1rem 0; } .category-row { grid-template-columns: 1fr; } .category-meta { min-inline-size: 0; text-align: left; } .route-fields { grid-template-columns: 1fr; } }
</style>
