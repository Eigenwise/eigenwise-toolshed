import { expect, test } from 'claude-code/testing';

test('compose section reaches a teammate subagent render', {
  plugins: [{
    name: 'compose-probe',
    register(on) {
      on('prompt.compose', async ($, event, next) => {
        const result = await next(event);
        return { sections: [...result.sections, { id: 'compose-probe:persona', text: 'probe persona', scope: 'session' }] };
      });
    },
  }],
}, async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }));
  const result = await $.prompt.compose({ model: 'claude-sonnet-4-6', promptModel: 'claude-sonnet-4-6', surfaces: [], tools: [], outputStyle: null, traits: ['teammate'] });
  expect(result.sections.find(section => section.id === 'compose-probe:persona')?.text).toBe('probe persona');
});
