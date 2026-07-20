<script lang="ts">
	let {
		value = $bindable(''),
		label,
		placeholder = 'YYYY-MM-DD 09:00',
		onchange
	}: {
		value?: string;
		label: string;
		placeholder?: string;
		onchange?: (value: string) => void;
	} = $props();

	function update(next: string) {
		value = next.replace(' ', 'T');
		onchange?.(value);
	}
</script>

<label class="date-picker">
	<span class="calendar" aria-hidden="true">□</span>
	<input aria-label={label} type="text" inputmode="numeric" value={value.replace('T', ' ')} {placeholder} oninput={(event) => update(event.currentTarget.value)} />
</label>

<style>
	.date-picker { display:flex; min-height:2.45rem; align-items:center; gap:.45rem; padding:0 .65rem; border:1px solid var(--border); border-radius:calc(var(--radius) - .1rem); background:var(--surface-muted); } .date-picker:focus-within { border-color:var(--accent); box-shadow:var(--focus-ring); } .calendar { color:var(--accent); font-family:var(--font-mono); font-size:.9rem; } input { width:100%; border:0; outline:0; background:transparent; color:var(--text); } input::placeholder { color:var(--text-muted); }
</style>
