<script lang="ts">
	import type { CompletionView } from '../../types';
	import { actionFact, checkedFacts, evidenceHref, resultFact, stageTone, uncertaintyChips } from './completion';

	let { view, anchors = [] }: { view: CompletionView | null; anchors?: string[] } = $props();
	let chips = $derived(view ? uncertaintyChips(view) : []);
	let summary = $derived(view?.summary ?? null);
	let userBlocker = $derived(view?.blocker?.actor === 'user' ? view.blocker : null);
</script>

<section class="completion" aria-label="Completion">
	<header><h3>Completion</h3>{#if view}<span class={`stage ${stageTone(view.stage)}`} data-stage={view.stage}>{view.stage}</span>{/if}</header>
	{#if !view}
		<p class="muted">Completion view not loaded.</p>
	{:else}
		{#if userBlocker}<p class="blocker" role="alert"><strong>Your action:</strong> {userBlocker.nextAction} <span class="muted">{userBlocker.reason}</span></p>{/if}
		<dl>
			<dt>Result</dt>
			<dd>
				<p class="fact">{resultFact(view)}</p>
				{#if summary}<p class="agent"><span class="tag">agent-reported</span> {summary.result}</p>{:else}<p class="muted">No summary recorded.</p>{/if}
			</dd>
			<dt>Checked</dt>
			<dd>
				{#each checkedFacts(view.facts) as fact (fact)}<p class="fact">{fact}</p>{/each}
				{#if summary?.checked}<p class="agent"><span class="tag">agent-reported</span> {summary.checked}</p>{/if}
			</dd>
			<dt>Still uncertain</dt>
			<dd>
				{#if chips.length}<ul class="chips">{#each chips as chip (chip.label)}<li class={`chip ${chip.tone}`}>{chip.label}</li>{/each}</ul>{:else}<p class="fact">Nothing flagged by the records.</p>{/if}
				{#if summary?.uncertain}<p class="agent"><span class="tag">agent-reported</span> {summary.uncertain}</p>{/if}
			</dd>
			<dt>Your action</dt>
			<dd>
				<p class="fact">{actionFact(view)}</p>
				{#if summary?.action}<p class="agent"><span class="tag">agent-reported</span> {summary.action}</p>{/if}
			</dd>
		</dl>
		{#if view.evidence.length}
			<ul class="evidence" aria-label="Evidence">
				{#each view.evidence as entry, index (`${entry.kind}-${index}`)}
					{@const href = evidenceHref(entry.path)}
					<li><span class="kind">{entry.kind}</span>{#if href}<a {href} title={entry.path}>{entry.label}</a>{:else}<span>{entry.label}</span>{/if}</li>
				{/each}
			</ul>
		{/if}
		<details>
			<summary>Anchors, decisions and raw evidence</summary>
			{#if anchors.length}<h4>Anchors</h4><ul class="plain">{#each anchors as anchor (anchor)}<li><code>{anchor}</code></li>{/each}</ul>{/if}
			{#if summary}<h4>Summary record</h4><p class="muted">Written by {summary.by || 'an unrecorded actor'}{summary.at ? ` at ${new Date(summary.at).toLocaleString()}` : ''} for {summary.candidate ? summary.candidate.slice(0, 9) : 'no recorded candidate'}.</p>{/if}
			<h4>Raw evidence</h4>
			<ul class="raw">
				{#if view.facts.verify?.logPath}<li><span class="kind">verify log</span><code>{view.facts.verify.logPath}</code></li>{/if}
				{#each view.evidence as entry, index (`raw-${entry.kind}-${index}`)}<li><span class="kind">{entry.kind}</span><code>{entry.path}</code></li>{:else}<li class="muted">No evidence paths under an approved root.</li>{/each}
			</ul>
		</details>
	{/if}
</section>

<style>
	.completion { display:grid; gap:.55rem; } header { display:flex; justify-content:space-between; align-items:center; gap:.5rem; } h3 { margin:0; font-size:.82rem; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); } h4 { margin:.5rem 0 .25rem; font-size:.74rem; color:var(--text-muted); }
	.stage, .chip { display:inline-flex; align-items:center; padding:.12rem .45rem; border:1px solid var(--border); border-radius:999px; color:var(--text-muted); font:600 .68rem var(--font-mono); }
	.success { color:var(--success); border-color:color-mix(in oklch, var(--success), transparent 55%); } .warning { color:var(--warning); border-color:color-mix(in oklch, var(--warning), transparent 55%); } .danger { color:var(--danger); border-color:color-mix(in oklch, var(--danger), transparent 55%); } .accent { color:var(--accent); background:var(--accent-soft); }
	.blocker { margin:0; padding:.5rem .6rem; border-left:3px solid var(--warning); background:color-mix(in oklch, var(--warning), var(--bg) 88%); font-size:.84rem; }
	dl { display:grid; gap:.45rem; margin:0; } dt { font-size:.72rem; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--text); } dd { display:grid; gap:.2rem; margin:0; font-size:.83rem; } dd p { margin:0; overflow-wrap:anywhere; }
	.agent { padding-left:.5rem; border-left:2px solid var(--border-strong); color:var(--text-muted); } .tag { padding:.05rem .35rem; border-radius:999px; background:var(--surface-card); color:var(--text-muted); font:600 .62rem var(--font-mono); }
	.muted { color:var(--text-muted); } .chips, .evidence, .plain { display:flex; flex-wrap:wrap; gap:.3rem; margin:0; padding:0; list-style:none; } .evidence { display:grid; gap:.25rem; font-size:.8rem; } .evidence li { display:flex; gap:.4rem; align-items:baseline; min-width:0; } .evidence a, .evidence span:last-child { overflow-wrap:anywhere; } .kind { flex:none; color:var(--text-muted); font:.66rem var(--font-mono); }
	details { font-size:.8rem; } summary { cursor:pointer; color:var(--text-muted); } .raw { display:grid; gap:.2rem; margin:0; padding:0; list-style:none; } .raw li { display:flex; gap:.4rem; align-items:baseline; } code { font:.72rem var(--font-mono); overflow-wrap:anywhere; }
</style>
