// The page each picture is taken of: a terminal window in the docs' own mock colours, holding what the plugin drew.
// The window, the pane's border and the prompt box are ours, drawn plainly; the desktop app's own chrome is never
// imitated here.

const STYLE = `
:root { --bg: #0f1419; --bar: #1a212a; --text: #c5ced9; --strong: #f3f6f9; --dim: #7c8896; --accent: #2dd4bf; --rail: #4b5766; --row: 20px; }
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; }
.shot { display: inline-block; padding: 0; }
.window { background: var(--bg); color: var(--text); border: 1px solid #26303b; border-radius: 10px; overflow: hidden;
  font: 14px/var(--row) Consolas, "Cascadia Mono", "DejaVu Sans Mono", monospace; font-variant-ligatures: none; }
.bar { display: flex; align-items: center; gap: 12px; height: 32px; padding: 0 14px; background: var(--bar); color: var(--dim);
  font: 12px/32px system-ui, sans-serif; }
.dots { display: flex; gap: 6px; } .dots i { width: 10px; height: 10px; border-radius: 50%; background: var(--rail); display: block; }
.window-body { padding: 14px 16px 16px; }
.split { display: flex; gap: 2ch; align-items: stretch; }
.chat { display: flex; flex-direction: column; justify-content: space-between; gap: var(--row); }
.chat-rows { display: flex; flex-direction: column; gap: 6px; }
.said { color: var(--strong); } .said::before { content: "> "; color: var(--dim); }
.band { margin-top: var(--row); }
.prompt { border: 1px solid var(--rail); border-radius: 6px; padding: 0 1ch; color: var(--dim); }
.pane { border: 1px solid var(--rail); border-radius: 6px; padding: calc(var(--row) / 2) 1ch; position: relative; margin-top: calc(var(--row) / 2); }
.pane-title { position: absolute; top: calc(var(--row) / -2); left: 1ch; padding: 0 1ch; background: var(--bg); color: var(--strong); }
.terminal-lines { white-space: pre-wrap; margin: 0; font: inherit; width: 100ch; }
.terminal-lines .typed { color: var(--strong); } .terminal-lines .typed::before { content: "$ "; color: var(--dim); }
.notice { border-left: 3px solid var(--accent); padding: 4px 0 4px 1.5ch; color: var(--strong); white-space: pre-wrap; }
.box { display: flex; min-width: 0; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.text .text { white-space: inherit; }
.truncate { white-space: pre; overflow: hidden; text-overflow: ellipsis; }
.button { white-space: pre-wrap; color: var(--strong); min-width: 0; }
.button.plain { white-space: pre-wrap; color: inherit; min-width: 0; overflow: hidden; }
.button.primary, .accent { color: var(--accent); }
.dim { color: var(--dim); }
.input { white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.input-label { color: var(--strong); }
.markdown { display: flex; flex-direction: column; min-width: 0; }
.md-heading { font-weight: 700; color: var(--strong); }
.md-gap { height: var(--row); }
.md-item { padding-left: 2ch; text-indent: -2ch; }
.code-span { color: var(--accent); }
.code { display: flex; flex-direction: column; border-left: 1px solid var(--rail); padding-left: 1ch; white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.line-number { display: inline-block; min-width: 4ch; color: var(--dim); }
.diff-added { color: #4eba65; } .diff-removed { color: #ff6b80; } .diff-hunk { color: var(--dim); } .diff-file { color: var(--strong); }
`

// Read back by the pipeline from the page's DOM, so the picture is cut to the drawing and not to a guessed size.
const MEASURE = `<script>
const box = document.querySelector('.shot').getBoundingClientRect()
document.title = Math.ceil(box.right) + 'x' + Math.ceil(box.bottom)
</script>`

export const pageOf = (inside: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>-</title><style>${STYLE}</style></head><body><div class="shot">${inside}</div>${MEASURE}</body></html>`

export const terminalWindow = (title: string, inside: string): string =>
  `<div class="window"><div class="bar"><span class="dots"><i></i><i></i><i></i></span><span>${title}</span></div><div class="window-body">${inside}</div></div>`

// The pane's body is exactly as many cells wide as the plugin was told it has.
export const paneFrame = (title: string, columns: number, inside: string): string =>
  `<div class="pane" style="width: calc(${columns + 2}ch + 2px)"><span class="pane-title">${title}</span>${inside}</div>`

export type SessionParts = { chatRows: readonly string[]; band: string; pane: string; chatColumns: number }

export const sessionLayout = (parts: SessionParts): string =>
  `<div class="split"><div class="chat" style="width: ${parts.chatColumns}ch"><div class="chat-rows">${parts.chatRows.join('')}</div>` +
  `<div><div class="band">${parts.band}</div><div class="prompt">&gt;&nbsp;</div></div></div>${parts.pane}</div>`

export const saidByThePerson = (escapedWords: string): string => `<div class="said">${escapedWords}</div>`

export const escapedText = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export const terminalLines = (typed: string, printed: string): string =>
  `<pre class="terminal-lines"><span class="typed">${escapedText(typed)}</span>\n${escapedText(printed)}</pre>`

export const noticeLines = (text: string, columns: number): string =>
  `<div class="notice" style="width: ${columns}ch">${escapedText(text)}</div>`
