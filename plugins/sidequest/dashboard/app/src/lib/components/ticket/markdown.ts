function escapeHtml(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

function safeHref(value: string) {
	const href = value.trim();
	const scheme = href.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
	return !scheme || ['http', 'https', 'mailto'].includes(scheme) ? href : null;
}

function renderInline(value: string) {
	const escaped = escapeHtml(value);
	return escaped
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\[([^\]]+)]\(([^\s)]+)\)/g, (_match, label, href) => {
			const safe = safeHref(href);
			if (!safe) return label;
			const external = /^https?:/i.test(safe) ? ' target="_blank" rel="noopener noreferrer"' : '';
			return `<a href="${safe}"${external}>${label}</a>`;
		})
		.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
		.replace(/(^|[\s([])\*([^*\n]+)\*(?=[\s).,!?:;\]]|$)/g, '$1<em>$2</em>')
		.replace(/(^|[\s([])_([^_\n]+)_(?=[\s).,!?:;\]]|$)/g, '$1<em>$2</em>');
}

export function renderMarkdown(value: string | undefined) {
	const lines = String(value ?? '').split(/\r\n|\r|\n/);
	const blocks: string[] = [];
	let paragraph: string[] = [];
	let code: string[] | null = null;
	let list: { type: 'ul' | 'ol'; items: string[] } | null = null;

	const flushParagraph = () => {
		if (paragraph.length) blocks.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
		paragraph = [];
	};
	const flushList = () => {
		if (list) blocks.push(`<${list.type}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${list.type}>`);
		list = null;
	};

	for (const line of lines) {
		if (code) {
			if (/^```\s*$/.test(line)) {
				blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
				code = null;
			} else code.push(line);
			continue;
		}
		if (/^```/.test(line)) {
			flushParagraph();
			flushList();
			code = [];
			continue;
		}
		const heading = line.match(/^(#{1,6})\s+(.+)$/);
		const listItem = line.match(/^\s*([-*+]|\d+\.)\s+(.+)$/);
		if (heading) {
			flushParagraph();
			flushList();
			blocks.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`);
		} else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			flushParagraph();
			flushList();
			blocks.push('<hr>');
		} else if (line.startsWith('>')) {
			flushParagraph();
			flushList();
			blocks.push(`<blockquote><p>${renderInline(line.replace(/^>\s?/, ''))}</p></blockquote>`);
		} else if (listItem) {
			flushParagraph();
			const type = /\d+\./.test(listItem[1]) ? 'ol' : 'ul';
			if (!list || list.type !== type) {
				flushList();
				list = { type, items: [] };
			}
			list.items.push(listItem[2]);
		} else if (!line.trim()) {
			flushParagraph();
			flushList();
		} else {
			flushList();
			paragraph.push(line);
		}
	}
	if (code) blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
	flushParagraph();
	flushList();
	return blocks.join('');
}
