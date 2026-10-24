import type { EngineInterface, Register } from 'claude-code';
import type { QualityGateStore } from '../types';
import { registerMeasurement } from './measure.ts';
import { registerBand } from './band.tsx';

async function readSettings($: EngineInterface): Promise<QualityGateStore> {
  return {
    enabled: (await $.store.get('enabled')) !== false,
    markers: (await $.store.get('markers')) !== false,
  };
}

async function inventory($: EngineInterface, cwd: string): Promise<string> {
  try {
    const result = await $.process.run(['node', `${$.plugin.root}/bin/quality-gate.js`, 'inventory', '--project', cwd, '--bytes', '2048'], { timeoutMs: 10000 });
    return result.exitCode === 0 ? result.stdout.trim() : '';
  } catch {
    return '';
  }
}

async function status($: EngineInterface): Promise<string> {
  const settings = await readSettings($);
  return `quality-gate ${settings.enabled ? 'on' : 'off'}; markers ${settings.markers ? 'on' : 'off'}`;
}

export const register: Register = (on) => {
  registerMeasurement(on);
  registerBand(on);
  let reuseInventory = '';
  let inventoryStarted = false;

  on('session.start', async ($, event, next) => {
    const result = await next(event);
    await $.command.register({ name: 'quality-gate', description: 'Switch quality guidance and shortcut markers on or off.', argumentHint: 'on|off|markers on|markers off|status' });
    if (!inventoryStarted) {
      inventoryStarted = true;
      void $.process.run(['node', `${$.plugin.root}/bin/quality-gate.js`, 'provision'], { timeoutMs: 180000 }).catch(() => undefined);
      reuseInventory = await inventory($, event.cwd);
    }
    return result;
  });

  on('prompt.compose', async ($, event, next) => {
    const result = await next(event);
    const settings = await readSettings($);
    if (!settings.enabled) return result;
    let text = await $.fs.read(`${$.plugin.root}/skills/quality/PERSONA.md`);
    if (!settings.markers) text = text.replace(/^A shortcut[^\n]*$/m, 'List each shortcut and its limit at the end of your reply, never as a source comment.');
    if (reuseInventory) text += `\nReuse inventory:\n${reuseInventory}`;
    return { sections: [...result.sections, { id: 'quality-gate:persona', text, scope: 'session' }] };
  });

  on('command.run', { command: 'quality-gate' }, async ($, event) => {
    const argument = event.args.trim();
    const changes: Record<string, readonly [keyof QualityGateStore, boolean]> = {
      on: ['enabled', true], off: ['enabled', false],
      'markers on': ['markers', true], 'markers off': ['markers', false],
    };
    const change = changes[argument];
    if (change) await $.store.set(change[0], change[1]);
    else if (argument !== 'status') return { text: 'Usage: /quality-gate on|off|markers on|markers off|status' };
    return { text: await status($) };
  });
};
