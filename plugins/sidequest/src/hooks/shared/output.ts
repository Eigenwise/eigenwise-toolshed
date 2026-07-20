export function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value));
}

export function writeContext(hookEventName: string, additionalContext: string): void {
  writeJson({ hookSpecificOutput: { hookEventName, additionalContext } });
}

export function writeDeny(hookEventName: string, permissionDecisionReason: string): void {
  writeJson({
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: 'deny',
      permissionDecisionReason,
    },
  });
}
