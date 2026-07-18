(function (root, factory) {
  const panel = factory();
  if (typeof module === 'object' && module.exports) module.exports = panel;
  root.SwitchboardPanel = panel;
}(window, function () {
  'use strict';

  const effortOptions = ['low', 'medium', 'high', 'xhigh', 'max'];
  const escape = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const routeLabel = (route) => route ? `${route.model}${route.effort ? ` · ${route.effort}` : ''}` : 'No fallback';

  function styles() {
    if (document.getElementById('switchboard-panel-styles')) return;
    const style = document.createElement('style');
    style.id = 'switchboard-panel-styles';
    style.textContent = `
      :root { --bg:#f7f3eb; --bg-deep:#ede7db; --panel:#f1ece1; --panel-2:#e8e1d3; --card:#fffdf9; --card-2:#fbf7ee; --line:#c9c1af; --line-soft:#dad3c4; --text:#1c1e2b; --text-dim:#52545f; --text-faint:#8b8d97; --indigo:#404683; --indigo-bright:#2b2f62; --indigo-soft:#e0e3f6; --indigo-line:#a6acd9; --mint:#4c8b6e; --warn:#a8672e; --danger:#b23b3b; --radius:4px; --mono:ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace; --sans:-apple-system, BlinkMacSystemFont, "Segoe UI", Verdana, sans-serif; --serif:Georgia, "Iowan Old Style", serif; }
      * { box-sizing:border-box; } body { margin:0; min-width:320px; color:var(--text); background:var(--bg); font-family:var(--sans); -webkit-font-smoothing:antialiased; } button, input, select, textarea { font:inherit; } button { cursor:pointer; } button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline:2px solid var(--indigo); outline-offset:2px; }
      .sb-shell { min-height:100vh; display:grid; grid-template-columns:minmax(245px, 300px) 1fr; background:var(--bg); }
      .sb-rail { background:var(--bg-deep); border-right:1px solid var(--line-soft); padding:18px 10px; display:flex; flex-direction:column; gap:14px; }
      .sb-brand { padding:2px 8px 10px; border-bottom:1px solid var(--line-soft); } .sb-brand h1 { margin:0; font:500 21px var(--serif); letter-spacing:-.02em; } .sb-brand h1 em { color:var(--indigo); font-weight:500; } .sb-brand p, .sb-meta, .sb-eyebrow { margin:4px 0 0; color:var(--text-faint); font:10.5px var(--mono); letter-spacing:.08em; text-transform:uppercase; }
      .sb-scope { display:grid; gap:7px; padding:0 8px; } .sb-label { color:var(--text-faint); font:10.5px var(--mono); letter-spacing:.08em; text-transform:uppercase; } .sb-scope-row { display:flex; gap:4px; } .sb-scope-row button { flex:1; min-height:36px; border:1px solid transparent; border-radius:2px; background:transparent; color:var(--text-dim); font:11px var(--mono); text-transform:uppercase; letter-spacing:.04em; } .sb-scope-row button.active { color:var(--bg); background:var(--indigo); border-color:var(--indigo); }
      .sb-project { width:100%; border:1px solid var(--line); border-radius:2px; background:var(--card); color:var(--text-dim); padding:8px; font:11px var(--mono); } .sb-project[hidden] { display:none; }
      .sb-category-list { overflow:auto; flex:1; display:grid; align-content:start; gap:3px; } .sb-category { width:100%; display:grid; grid-template-columns:1fr auto; gap:7px; text-align:left; padding:9px 10px; border:1px solid transparent; background:transparent; border-radius:2px; color:var(--text-dim); } .sb-category:hover { background:var(--panel-2); color:var(--text); } .sb-category.active { background:var(--card); border-color:var(--line); color:var(--text); } .sb-category strong { font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .sb-state { align-self:center; color:var(--text-faint); font:9px var(--mono); text-transform:uppercase; letter-spacing:.04em; } .sb-state.disabled { color:var(--danger); } .sb-state.detached { color:var(--warn); }
      .sb-main { min-width:0; } .sb-top { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:16px 22px; border-bottom:1px solid var(--line-soft); background:color-mix(in srgb, var(--bg) 85%, white); } .sb-top h2 { margin:0; font:500 clamp(20px, 2.2vw, 28px) var(--serif); letter-spacing:-.025em; } .sb-health { color:var(--mint); font:10px var(--mono); text-transform:uppercase; letter-spacing:.08em; } .sb-health.warn { color:var(--warn); }
      .sb-content { max-width:1200px; margin:0 auto; padding:22px; display:grid; grid-template-columns:minmax(0, 1.3fr) minmax(285px, .7fr); gap:16px; } .sb-stack { display:grid; gap:16px; align-content:start; } .sb-card { background:var(--card); border:1px solid var(--line-soft); border-radius:var(--radius); } .sb-card-head { padding:14px 16px 11px; border-bottom:1px solid var(--line-soft); display:flex; justify-content:space-between; align-items:start; gap:8px; } .sb-card-head h3 { margin:0; font:500 18px var(--serif); } .sb-card-head p { margin:4px 0 0; color:var(--text-faint); font-size:12px; line-height:1.4; }
      .sb-form { padding:16px; display:grid; gap:13px; } .sb-field { display:grid; gap:6px; } .sb-field label { color:var(--text-dim); font-size:12px; font-weight:600; } .sb-field input, .sb-field select, .sb-field textarea { width:100%; border:1px solid var(--line); border-radius:2px; color:var(--text); background:var(--card-2); padding:9px; } .sb-field textarea { resize:vertical; min-height:84px; line-height:1.45; } .sb-route { display:grid; grid-template-columns:1fr 120px; gap:8px; } .sb-caption { margin:0; color:var(--text-faint); font-size:11px; line-height:1.45; } .sb-actions { display:flex; flex-wrap:wrap; justify-content:space-between; gap:8px; align-items:center; padding-top:3px; } .sb-action-group { display:flex; gap:6px; flex-wrap:wrap; } .sb-button { min-height:35px; padding:0 10px; border:1px solid var(--line); border-radius:2px; background:var(--card); color:var(--text-dim); font:10.5px var(--mono); letter-spacing:.04em; text-transform:uppercase; } .sb-button:hover { border-color:var(--indigo-line); color:var(--indigo-bright); background:var(--indigo-soft); } .sb-button.primary { color:var(--bg); border-color:var(--indigo); background:var(--indigo); } .sb-button.danger:hover { border-color:#dba8a0; color:var(--danger); background:#f8e5e2; }
      .sb-pill { display:inline-flex; padding:3px 6px; border:1px solid var(--line); border-radius:10px; color:var(--text-faint); font:9px var(--mono); text-transform:uppercase; letter-spacing:.05em; } .sb-pill.warning { border-color:#d7b991; color:var(--warn); background:#fff4e5; } .sb-warning { margin:0 16px 16px; padding:10px; border-left:3px solid var(--warn); background:#fff4e5; color:#73410d; font-size:12px; line-height:1.45; } .sb-warning[hidden] { display:none; }
      .sb-resolution { padding:14px 16px 16px; display:grid; gap:10px; } .sb-resolution-toolbar { display:flex; gap:7px; } .sb-resolution-toolbar select { flex:1; min-width:0; border:1px solid var(--line); border-radius:2px; background:var(--card-2); padding:7px; color:var(--text); } .sb-attempt { border-left:2px solid var(--line); padding:7px 9px; display:grid; gap:3px; } .sb-attempt.success { border-left-color:var(--mint); background:#f0f7f3; } .sb-attempt.failed { border-left-color:var(--warn); background:#fff8ed; } .sb-attempt strong { font:11px var(--mono); } .sb-attempt span { color:var(--text-faint); font-size:11px; line-height:1.4; } .sb-empty { color:var(--text-faint); font-size:12px; padding:5px 0; }
      .sb-contract { padding:15px 16px; display:grid; gap:10px; } .sb-contract code { color:var(--indigo-bright); font:11px var(--mono); overflow-wrap:anywhere; } .sb-status { min-height:18px; color:var(--mint); font-size:12px; } .sb-status.error { color:var(--danger); }
      @media (max-width:820px) { .sb-shell { grid-template-columns:1fr; } .sb-rail { border-right:0; border-bottom:1px solid var(--line-soft); max-height:none; } .sb-category-list { max-height:180px; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); } .sb-content { grid-template-columns:1fr; padding:14px; } } @media (max-width:480px) { .sb-top { padding:14px; align-items:flex-start; flex-direction:column; } .sb-route { grid-template-columns:1fr; } .sb-actions { align-items:stretch; } .sb-button { flex:1; } }
    `;
    document.head.append(style);
  }

  function createPanel(options) {
    const state = { settings: null, selected: null, scope: options.scope || 'project', projectPath: options.projectPath || '', resolution: null };
    const request = options.request || ((url, init) => fetch(url, init).then(async (response) => {
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || 'Request failed');
      return value;
    }));

    function api(path, init) { return request(path, init); }
    function effective() { return state.settings[state.scope === 'global' ? 'global' : 'effective']; }
    function category() { return effective().categories.find((item) => item.id === state.selected) || effective().categories[0]; }
    function modelOptions(selected) { return state.settings.availability.models.map((item) => `<option value="${escape(item.model)}" ${item.model === selected ? 'selected' : ''}>${escape(item.label || item.model)}${item.available ? '' : ' (unavailable)'}</option>`).join(''); }
    function effortSelect(name, value) { return `<select name="${name}" aria-label="${name}"><option value="">none</option>${effortOptions.map((effort) => `<option value="${effort}" ${effort === value ? 'selected' : ''}>${effort}</option>`).join('')}</select>`; }

    function render() {
      styles();
      const data = state.settings;
      const item = category();
      if (!data || !item) { options.element.innerHTML = '<main class="sb-shell"><div class="sb-main"><div class="sb-top"><h2>Loading routing settings…</h2></div></div></main>'; return; }
      const warnings = [...(data.availability.warnings || []), ...(effective().warnings || [])];
      const currentState = effective().states[item.id] || 'inherited';
      const unavailable = data.availability.models.filter((model) => !model.available);
      options.element.innerHTML = `<main class="sb-shell" aria-label="Switchboard routing settings">
        <aside class="sb-rail"><div class="sb-brand"><h1>switch<em>board</em></h1><p>routing settings</p></div>
          <div class="sb-scope"><span class="sb-label">editing scope</span><div class="sb-scope-row"><button data-scope="global" class="${state.scope === 'global' ? 'active' : ''}">Global</button><button data-scope="project" class="${state.scope === 'project' ? 'active' : ''}">Project</button></div><input class="sb-project" data-project placeholder="project path" value="${escape(state.projectPath)}" ${state.scope === 'global' ? 'hidden' : ''}></div>
          <nav class="sb-category-list" aria-label="Routing categories">${effective().categories.map((row) => `<button class="sb-category ${row.id === item.id ? 'active' : ''}" data-category="${escape(row.id)}"><strong>${escape(row.name)}</strong><span class="sb-state ${escape(effective().states[row.id] || '')}">${escape(effective().states[row.id] || 'inherited')}</span></button>`).join('')}</nav>
        </aside>
        <div class="sb-main"><header class="sb-top"><div><h2>Routing policy</h2><p class="sb-meta">primary route, fallback chain, and executor contract</p></div><span class="sb-health ${data.doctor.ok ? '' : 'warn'}">${data.doctor.ok ? 'catalog ready' : 'catalog needs attention'}</span></header>
          <div class="sb-content"><div class="sb-stack"><section class="sb-card"><div class="sb-card-head"><div><h3>${escape(item.name)}</h3><p><span class="sb-pill ${currentState === 'detached' ? 'warning' : ''}">${escape(currentState)}</span> Effective values are what consumers receive.</p></div></div>
            <form class="sb-form" data-editor><div class="sb-field"><label for="description">Classifier description</label><textarea id="description" name="description">${escape(item.description)}</textarea><p class="sb-caption">This decides when the category fits.</p></div><div class="sb-field"><label for="contract">Executor contract</label><textarea id="contract" name="contract">${escape(item.contract)}</textarea></div>
              <div class="sb-field"><label>Primary route</label><div class="sb-route"><select name="routeModel">${modelOptions(item.route.model)}</select>${effortSelect('routeEffort', item.route.effort)}</div></div>
              <div class="sb-field"><label>Category fallback</label><div class="sb-route"><select name="fallbackModel"><option value="">No category fallback</option>${modelOptions(item.fallback && item.fallback.model)}</select>${effortSelect('fallbackEffort', item.fallback && item.fallback.effort)}</div><p class="sb-caption">Falls through to the global fallback when this route cannot run.</p></div>
              <div class="sb-actions"><div class="sb-action-group"><button class="sb-button primary" type="submit">Save ${state.scope === 'project' ? 'effective values' : 'global policy'}</button>${state.scope === 'project' ? '<button class="sb-button" type="button" data-action="detach">Detach</button><button class="sb-button" type="button" data-action="relink">Relink</button><button class="sb-button" type="button" data-action="reset">Reset</button>' : ''}</div><button class="sb-button danger" type="button" data-action="disable">Disable</button></div><div class="sb-status" role="status"></div></form>
            ${warnings.length || unavailable.length ? `<div class="sb-warning"><strong>Availability notes</strong><br>${escape([...warnings, ...unavailable.map((model) => `${model.label || model.model} is unavailable`)].join(' · '))}</div>` : ''}
          </section>
          <section class="sb-card"><div class="sb-card-head"><div><h3>Global fallback</h3><p>Last available route after primary and category fallback fail.</p></div></div><form class="sb-form" data-global-fallback><div class="sb-route"><select name="model"><option value="">No global fallback</option>${modelOptions(data.fallback.fallback && data.fallback.fallback.model)}</select>${effortSelect('effort', data.fallback.fallback && data.fallback.fallback.effort)}</div><div class="sb-actions"><span class="sb-caption">${escape(routeLabel(data.fallback.fallback))}</span><button class="sb-button" type="submit">Save fallback</button></div></form></section></div>
          <aside class="sb-stack"><section class="sb-card"><div class="sb-card-head"><div><h3>Resolution preview</h3><p>Every attempt for the current availability catalog.</p></div></div><div class="sb-resolution"><div class="sb-resolution-toolbar"><select data-preview-category>${data.effective.categories.map((row) => `<option value="${escape(row.id)}" ${row.id === item.id ? 'selected' : ''}>${escape(row.name)}</option>`).join('')}</select><button class="sb-button" data-preview>Preview</button></div><div data-attempts>${renderResolution(state.resolution)}</div></div></section>
          <section class="sb-card"><div class="sb-card-head"><div><h3>Contract</h3><p>Shared routing surface for consumer integrations.</p></div></div><div class="sb-contract"><code>${escape(data.contract.path || data.contract.contract || JSON.stringify(data.contract))}</code><span class="sb-caption">The panel reads and writes the Switchboard contract directly. Sidequest can mount this panel without duplicating resolution logic.</span></div></section></aside></div>
        </div></main>`;
      bind();
    }

    function renderResolution(resolution) {
      if (!resolution) return '<div class="sb-empty">Choose a category and preview its fallback chain.</div>';
      const attempted = (resolution.attempts || []).map((attempt) => `<div class="sb-attempt failed"><strong>${escape(attempt.source)} · ${escape(routeLabel(attempt.route))}</strong><span>${escape(attempt.reason)}</span></div>`).join('');
      const selected = resolution.route ? `<div class="sb-attempt success"><strong>${escape(resolution.route.source)} · ${escape(routeLabel(resolution.route))}</strong><span>Selected for dispatch${resolution.dispatch ? ` · ${escape(resolution.dispatch.kind)}` : ''}</span></div>` : '<div class="sb-empty">No available route resolved.</div>';
      return attempted + selected;
    }

    function payload(form) {
      const data = new FormData(form);
      const fallbackModel = data.get('fallbackModel');
      return { projectPath: state.scope === 'project' ? state.projectPath : undefined, scope: state.scope, name: category().name, description: data.get('description'), contract: data.get('contract'), route: { model: data.get('routeModel'), effort: data.get('routeEffort') || null }, fallback: fallbackModel ? { model: fallbackModel, effort: data.get('fallbackEffort') || null } : null, enabled: true };
    }

    async function refresh() {
      const query = state.projectPath ? `?projectPath=${encodeURIComponent(state.projectPath)}` : '';
      state.settings = await api(`/api/settings${query}`);
      if (!state.selected || !state.settings.effective.categories.some((row) => row.id === state.selected)) state.selected = state.settings.effective.categories[0] && state.settings.effective.categories[0].id;
      render();
    }

    async function mutate(action, body) {
      const result = await api(`/api/categories/${encodeURIComponent(category().id)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      state.settings = result.settings;
      render();
      const status = options.element.querySelector('.sb-status');
      if (status) status.textContent = `${action} applied. Showing ${state.scope === 'project' ? 'effective values' : 'global policy'}.`;
    }

    function bind() {
      options.element.querySelectorAll('[data-scope]').forEach((button) => button.addEventListener('click', () => { state.scope = button.dataset.scope; render(); }));
      const project = options.element.querySelector('[data-project]');
      if (project) project.addEventListener('change', async () => { state.projectPath = project.value.trim(); await refresh(); });
      options.element.querySelectorAll('[data-category]').forEach((button) => button.addEventListener('click', () => { state.selected = button.dataset.category; state.resolution = null; render(); }));
      options.element.querySelector('[data-editor]').addEventListener('submit', async (event) => { event.preventDefault(); try { await mutate('save', payload(event.currentTarget)); } catch (error) { const status = event.currentTarget.querySelector('.sb-status'); status.textContent = error.message; status.classList.add('error'); } });
      options.element.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', async () => { try { await mutate(button.dataset.action, { projectPath: state.projectPath, scope: state.scope }); } catch (error) { const status = options.element.querySelector('.sb-status'); status.textContent = error.message; status.classList.add('error'); } }));
      options.element.querySelector('[data-preview]').addEventListener('click', async () => { const id = options.element.querySelector('[data-preview-category]').value; try { state.resolution = await api(`/api/resolve?category=${encodeURIComponent(id)}${state.projectPath ? `&projectPath=${encodeURIComponent(state.projectPath)}` : ''}`); render(); } catch (error) { state.resolution = { attempts: [{ source: 'preview', route: {}, reason: error.message }] }; render(); } });
      options.element.querySelector('[data-global-fallback]').addEventListener('submit', async (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); const model = data.get('model'); try { await api('/api/fallback', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectPath: state.projectPath, scope: state.scope, route: model ? { model, effort: data.get('effort') || null } : null }) }); await refresh(); } catch (error) { const status = options.element.querySelector('.sb-status'); status.textContent = error.message; status.classList.add('error'); } });
    }

    return { refresh, state };
  }

  return { createPanel };
}));
