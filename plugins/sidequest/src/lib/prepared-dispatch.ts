export function canonicalPreparedDispatchExecutor(ticket?: any): string | null {
  const currentExecutor = String(ticket?.dispatch?.executor || '').trim();
  if (currentExecutor) return currentExecutor;
  const legacyExecutor = String(ticket?.dispatchExecutor || '').trim();
  if (legacyExecutor) return legacyExecutor;
  const routedExecutor = String(ticket?.exec?.agent || '').trim();
  return routedExecutor || null;
}

export function normalizePreparedDispatch(ticket?: any): any {
  if (!ticket || typeof ticket !== 'object') return ticket;
  const legacyExecutor = String(ticket.dispatchExecutor || '').trim();
  if (!legacyExecutor) return ticket;
  if (!ticket.dispatch || typeof ticket.dispatch !== 'object') {
    ticket.dispatch = { executor: legacyExecutor };
    return ticket;
  }
  if (!String(ticket.dispatch.executor || '').trim()) ticket.dispatch.executor = legacyExecutor;
  return ticket;
}
