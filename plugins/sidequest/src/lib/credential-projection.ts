// Dispatch credentials are capabilities, not board state. Only the explicit
// dispatch response may hand them to the caller starting that executor.
export function redactDispatchCredentials(value: any): any {
  if (Array.isArray(value)) return value.map(redactDispatchCredentials);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['dispatchNonce', 'tokenFile', 'token'].includes(key))
    .map(([key, entry]) => [key, redactDispatchCredentials(entry)]));
}
