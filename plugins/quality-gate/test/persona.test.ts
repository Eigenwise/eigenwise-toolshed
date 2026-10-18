import type { On } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';

function personaFile(on: On): void {
  on('fs.read', ($, event) => {
    expect(event.path.replaceAll('\\', '/')).toEndWith('/skills/quality/PERSONA.md');
    return { value: 'CRAP below 6\nA shortcut fixture `shortcut:`\n' };
  });
}

const composeInput = { model: 'claude-sonnet-4-6', promptModel: 'claude-sonnet-4-6', surfaces: [], tools: [], outputStyle: null, traits: [] } as const;

for (const traits of [[], ['teammate']] as const) {
  test(`enabled persona is last and session scoped (${traits.join() || 'lead'})`, async ($, on) => {
    mock.store(on);
    personaFile(on);
    on('prompt.compose', () => ({ sections: [{ id: 'existing', text: 'existing', scope: 'session' }] }));
    const result = await $.prompt.compose({ ...composeInput, traits });
    expect(result.sections.at(-1)?.id).toBe('quality-gate:persona');
    expect(result.sections.at(-1)?.scope).toBe('session');
    expect(result.sections.at(-1)?.text).toMatch('CRAP below 6');
  });
}

test('off leaves compose sections unchanged', async ($, on) => {
  mock.store(on, { enabled: false });
  on('prompt.compose', () => ({ sections: [] }));
  expect((await $.prompt.compose(composeInput)).sections).toEqual([]);
});

test('markers off replaces source marker with reply guidance', async ($, on) => {
  mock.store(on, { markers: false });
  personaFile(on);
  on('prompt.compose', () => ({ sections: [] }));
  const text = (await $.prompt.compose(composeInput)).sections.at(-1)?.text;
  expect(text).toMatch('never as a source comment');
  expect(text).not.toMatch('`shortcut:');
});

test('commands persist both switches and status is one line', async ($, on) => {
  mock.store(on);
  on('command.run', () => ({ text: 'unchanged command' }));
  await $.command.run({ command: 'quality-gate', args: 'off' });
  await $.command.run({ command: 'quality-gate', args: 'markers off' });
  expect((await $.command.run({ command: 'quality-gate', args: 'status' })).text).toBe('quality-gate off; markers off');
  await $.command.run({ command: 'quality-gate', args: 'on' });
  expect((await $.command.run({ command: 'quality-gate', args: 'markers on' })).text).toBe('quality-gate on; markers on');
  expect((await $.command.run({ command: 'quality-gate', args: 'unknown' })).text).toMatch('Usage:');
});

for (const outcome of ['success', 'failed', 'missing'] as const) {
  test(`session inventory runs once and handles ${outcome}`, async ($, on) => {
    let inventoryCalls = 0;
    mock.store(on);
    personaFile(on);
    on('session.start', ($, event) => ({ cwd: event.cwd }));
    on('command.register', () => ({ value: { command: 'quality-gate' } }));
    on('process.run', ($, event) => {
      expect(event.argv[0]).toBe('node');
      expect(event.argv[1]).toMatch(/[\/]bin[\/]quality-gate\.js$/);
      if (event.argv[2] === 'provision') {
        expect(event.init?.timeoutMs).toBe(180000);
        return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
      }
      inventoryCalls++;
      expect(event.argv.slice(2)).toEqual(['inventory', '--project', '/project', '--bytes', '2048']);
      expect(event.init?.timeoutMs).toBe(10000);
      if (outcome === 'missing') throw new Error('missing CLI');
      return { value: { exitCode: outcome === 'failed' ? 1 : 0, stdout: 'exportedName', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } };
    });
    on('prompt.compose', () => ({ sections: [] }));
    await $.session.start({ cwd: '/project', surface: null, isInteractive: false });
    await $.session.start({ cwd: '/project', surface: null, isInteractive: false });
    const text = (await $.prompt.compose(composeInput)).sections.at(-1)?.text ?? '';
    expect(text.includes('exportedName')).toBe(outcome === 'success');
    expect(inventoryCalls).toBe(1);
  });
}
