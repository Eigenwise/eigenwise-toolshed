<script lang="ts">
	import type { BoardState } from '../../state/board.svelte';
	import type { Ticket } from '../../types';

	export interface PendingImage { name: string; base64: string; }
	let { board, ticket, pending = $bindable<PendingImage[]>([]) }: { board: BoardState; ticket?: Ticket; pending?: PendingImage[] } = $props();
	let assets = $derived((ticket?.assets as string[] | undefined) ?? []);

	function read(file: File) {
		if (!file.type.startsWith('image/')) return;
		const reader = new FileReader();
		reader.onload = async () => {
			const image = { name: file.name || 'pasted-image.png', base64: String(reader.result) };
			if (ticket) await board.uploadAttachments(ticket, [image]);
			else pending = [...pending, image];
		};
		reader.readAsDataURL(file);
	}

	function addFiles(files: FileList | null) {
		for (const file of Array.from(files ?? [])) read(file);
	}

	function drop(event: DragEvent) {
		event.preventDefault();
		addFiles(event.dataTransfer?.files ?? null);
	}

	function paste(event: ClipboardEvent) {
		if (ticket || pending) addFiles(event.clipboardData?.files ?? null);
	}
</script>

<svelte:document onpaste={paste} />
<section class="attachments" role="group" aria-label="Image attachments" ondragover={(event) => event.preventDefault()} ondrop={drop}>
	<h3>Images</h3>
	<label class="drop-zone">Drop or paste images here, or <input type="file" accept="image/*" multiple aria-label="Attachments" onchange={(event) => addFiles(event.currentTarget.files)} /></label>
	<div class="grid">
		{#each assets as filename (filename)}
			<figure><button type="button" onclick={() => board.selectLightboxImage(ticket!, filename)}><img src={board.api.assetUrl(String(ticket!.projectSlug ?? ticket!.project), ticket!.id, filename)} alt={filename} /></button><button type="button" aria-label={`Remove ${filename}`} onclick={() => board.removeAttachment(ticket!, filename)}>Remove</button></figure>
		{/each}
		{#each pending as image (image.base64)}
			<figure><img src={image.base64} alt={image.name} /><button type="button" aria-label={`Remove ${image.name}`} onclick={() => pending = pending.filter((entry) => entry !== image)}>Remove</button></figure>
		{/each}
	</div>
</section>

<style>
	.attachments { margin-top:1rem; } h3 { margin:0 0 .4rem; font-size:.9rem; } .drop-zone { display:block; padding:.7rem; border:1px dashed var(--border); border-radius:var(--radius); color:var(--text-muted); } input { max-width:100%; } .grid { display:flex; flex-wrap:wrap; gap:.6rem; margin-top:.6rem; } figure { margin:0; width:7rem; } figure img { display:block; width:100%; height:5rem; object-fit:cover; border-radius:var(--radius); } figure button { max-width:100%; margin-top:.25rem; }
</style>
