<script lang="ts">
	import type { StoryCompletionRead } from '../../types';
	import { actionFact, stageTone, storyResultFact, uncertaintyChips } from '../ticket/completion';

	let { read }: { read: StoryCompletionRead | null } = $props();
	let view = $derived(read?.completion ?? null);
	let userBlocker = $derived(view?.blocker?.actor === 'user' ? view.blocker : null);
</script>

<section class="completion" aria-label="Story completion">
	<header><h3>Story completion</h3>{#if view}<span class={`stage ${stageTone(view.stage)}`} data-stage={view.stage}>{view.stage}</span>{/if}</header>
	{#if !read}
		<p class="muted">Loading story completion…</p>
	{:else if !view}
		<p class="muted">Story view not available.</p>
	{:else}
		{#if userBlocker}<p class="blocker" role="alert"><strong>Your action:</strong> {userBlocker.nextAction} <span class="muted">{userBlocker.reason}</span></p>{/if}
		<dl>
			<dt>Result</dt>
			<dd><p>{storyResultFact(view)}</p>{#if view.notYet.length}<p>Not yet: {view.notYet.map((entry) => `${entry.ref} (${entry.stage})`).join(', ')}.</p>{/if}</dd>
			<dt>Checked</dt>
			<dd>
				<ul class="children">
					{#each view.children as child (child.ref)}
						<li><code>{child.ref}</code><span class={`stage ${stageTone(child.stage)}`} data-stage={child.stage}>{child.stage}</span><span class="title">{child.title}</span>{#each uncertaintyChips(child) as chip (chip.label)}<span class={`chip ${chip.tone}`}>{chip.label}</span>{/each}</li>
					{:else}<li class="muted">No member tickets.</li>{/each}
				</ul>
			</dd>
			<dt>Still uncertain</dt>
			<dd>{#if view.uncertainties.length}<ul class="chips">{#each view.uncertainties as doubt (doubt)}<li class="chip warning">{doubt}</li>{/each}</ul>{:else}<p>Nothing flagged by the records.</p>{/if}</dd>
			<dt>Your action</dt>
			<dd><p>{actionFact(view)}</p></dd>
		</dl>
		<details>
			<summary>Decisions and member records</summary>
			<h4>Decisions</h4>
			<p>{view.decisions.count} recorded{view.decisions.latest ? `; latest: ${view.decisions.latest}` : ''}.</p>
			<h4>Member records</h4>
			<ul class="plain">{#each view.children as child (child.ref)}<li><code>{child.ref}</code> {child.blocker ? `${child.blocker.reason} Next (${child.blocker.actor}): ${child.blocker.nextAction}` : 'No blocker recorded.'}</li>{/each}</ul>
		</details>
	{/if}
</section>

<style>
	.completion { display:grid; gap:.55rem; } header { display:flex; justify-content:space-between; align-items:center; gap:.5rem; } h3 { margin:0; font-size:.82rem; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); } h4 { margin:.5rem 0 .25rem; font-size:.74rem; color:var(--text-muted); }
	.stage, .chip { display:inline-flex; align-items:center; padding:.12rem .45rem; border:1px solid var(--border); border-radius:999px; color:var(--text-muted); font:600 .68rem var(--font-mono); }
	.success { color:var(--success); border-color:color-mix(in oklch, var(--success), transparent 55%); } .warning { color:var(--warning); border-color:color-mix(in oklch, var(--warning), transparent 55%); } .danger { color:var(--danger); border-color:color-mix(in oklch, var(--danger), transparent 55%); } .accent { color:var(--accent); background:var(--accent-soft); }
	.blocker { margin:0; padding:.5rem .6rem; border-left:3px solid var(--warning); background:color-mix(in oklch, var(--warning), var(--bg) 88%); font-size:.84rem; }
	dl { display:grid; gap:.45rem; margin:0; } dt { font-size:.72rem; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--text); } dd { display:grid; gap:.2rem; margin:0; font-size:.83rem; } dd p { margin:0; overflow-wrap:anywhere; }
	.muted { color:var(--text-muted); } .chips, .plain { display:flex; flex-wrap:wrap; gap:.3rem; margin:0; padding:0; list-style:none; } .plain { display:grid; } .children { display:grid; gap:.3rem; margin:0; padding:0; list-style:none; } .children li { display:flex; flex-wrap:wrap; gap:.35rem; align-items:center; } .title { min-width:0; overflow-wrap:anywhere; }
	details { font-size:.8rem; } summary { cursor:pointer; color:var(--text-muted); } code { font:.72rem var(--font-mono); }
</style>
