'use strict';

const { commandLauncherPath } = require('../hooks/registry-writer.js');

function readinessCommand() {
  return `node "${commandLauncherPath()}" readiness-gate`;
}

function ownedReadinessHook(hook) {
  return hook?.type === 'command' && hook.command === readinessCommand();
}

function withoutReadinessHooks(groups) {
  return groups.flatMap((group) => {
    if (!Array.isArray(group.hooks)) return [group];
    if (!group.hooks.some(ownedReadinessHook)) return [group];
    const hooks = group.hooks.filter((hook) => !ownedReadinessHook(hook));
    return hooks.length ? [{ ...group, hooks }] : [];
  });
}

// No onFailure: 'block'. The gate blocks a prompt itself, with exit 2 and its guidance. A gate that
// could not run at all (killed while the app shuts down, node missing) used to eat the prompt with
// "No stderr output"; now that prompt goes through and a dead gateway answers with its own error.
function recoveryHookGroup(event) {
  const group = { hooks: [{ type: 'command', command: readinessCommand(), timeout: 35 }] };
  if (event === 'SessionStart') group.matcher = 'startup|resume';
  return group;
}

function syncEventReadinessHooks(hooks, event, enabled) {
  const groups = withoutReadinessHooks(hooks[event] || []);
  if (enabled) groups.push(recoveryHookGroup(event));
  if (groups.length) hooks[event] = groups;
  else delete hooks[event];
}

function syncReadinessHooks(settings, enabled) {
  const hooks = { ...settings.hooks };
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    syncEventReadinessHooks(hooks, event, enabled && settings.disableAllHooks !== true);
  }
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;
  return settings;
}

function readinessHookPresent(settings) {
  return ['SessionStart', 'UserPromptSubmit'].every((event) =>
    settings.hooks?.[event]?.some((group) => group.hooks?.some(ownedReadinessHook)));
}

module.exports = { ownedReadinessHook, readinessCommand, readinessHookPresent, syncReadinessHooks };
