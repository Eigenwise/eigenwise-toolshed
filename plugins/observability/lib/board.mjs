// shortcut: placeholder until the board page (SQ-3734) replaces this file; same export, same signature.
export function boardHtml(rows, now) {
  return `<!doctype html><meta charset="utf-8"><title>Observability</title><p>${rows.length} turns recorded as of ${new Date(now).toISOString()}.</p>`
}
