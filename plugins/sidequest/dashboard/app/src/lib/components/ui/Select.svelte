<script lang="ts">
	import { tick } from 'svelte';

	export type SelectOption = { value: string; label: string; disabled?: boolean };

	let {
		value = $bindable(''),
		options,
		label,
		placeholder = 'Select an option',
		disabled = false,
		onchange
	}: {
		value?: string;
		options: SelectOption[];
		label: string;
		placeholder?: string;
		disabled?: boolean;
		onchange?: (value: string) => void | Promise<unknown>;
	} = $props();

	let open = $state(false);
	let trigger = $state<HTMLButtonElement>();
	let selected = $derived(options.find((option) => option.value === value));

	async function choose(next: string) {
		value = next;
		open = false;
		await onchange?.(next);
		await tick();
		trigger?.focus();
	}

	function selectOption(event: MouseEvent, value: string) {
		event.stopPropagation();
		void choose(value);
	}

	function keydown(event: KeyboardEvent) {
		if (event.key === 'Escape') open = false;
		if ((event.key === 'Enter' || event.key === ' ') && !disabled) {
			event.preventDefault();
			open = !open;
		}
	}
</script>

<div class="select">
	<button bind:this={trigger} class:open type="button" role="combobox" aria-label={label} aria-expanded={open} aria-controls={`${label}-options`} {disabled} onclick={() => open = !open} onkeydown={keydown}>
		<span class:placeholder={!selected}>{selected?.label ?? placeholder}</span><span class="chevron" aria-hidden="true">⌄</span>
	</button>
	{#if open}
		<div class="options" id={`${label}-options`} role="listbox" aria-label={label}>
			{#each options as option (option.value)}
				<button class:selected={option.value === value} type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} onclick={(event) => selectOption(event, option.value)}>{option.label}</button>
			{/each}
		</div>
	{/if}
</div>

<style>
	.select { position:relative; min-width:0; } .select > button { display:flex; width:100%; min-height:2.45rem; align-items:center; justify-content:space-between; gap:.5rem; padding:.5rem .65rem; border:1px solid var(--border); border-radius:calc(var(--radius) - .1rem); background:var(--surface-muted); color:var(--text); text-align:left; } .select > button:hover, .select > button.open { border-color:var(--accent); background:color-mix(in srgb, var(--accent-soft) 65%, var(--surface-muted)); } .select > button:disabled { cursor:not-allowed; opacity:.55; } .placeholder { color:var(--text-muted); } .chevron { color:var(--accent); font-family:var(--font-mono); font-size:1rem; line-height:1; } .options { position:absolute; z-index:50; top:calc(100% + .35rem); right:0; left:0; display:grid; max-height:15rem; overflow:auto; padding:.25rem; border:1px solid var(--border-strong); border-radius:var(--radius); background:var(--bg-deep); } .options button { min-height:2.25rem; padding:.45rem .55rem; border:0; border-radius:calc(var(--radius) - .2rem); background:transparent; color:var(--text); text-align:left; } .options button:hover, .options button.selected { background:var(--accent-soft); color:var(--accent); } .options button:disabled { cursor:not-allowed; opacity:.45; }
</style>
