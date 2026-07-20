import path from 'node:path';

export function pluginRoot(): string {
  return process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
}

export function runtimeModule(name: string): string {
  return path.join(pluginRoot(), 'lib', `${name}.js`);
}
