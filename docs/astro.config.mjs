// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLlmsTxt from 'starlight-llms-txt';
import remarkPrefixBase from './src/remark/prefix-base.mjs';

// The address the repository's Pages site has. It does not change when the Toolshed's version does.
const site = 'https://eigenwise.github.io';
const base = '/eigenwise-toolshed';

export default defineConfig({
  site,
  base,
  trailingSlash: 'ignore',
  devToolbar: { enabled: false },
  markdown: {
    // Commands and file names must stay exactly as typed, so no curly quotes.
    smartypants: false,
    remarkPlugins: [[remarkPrefixBase, { base }]],
  },
  integrations: [
    starlight({
      title: 'Toolshed',
      description: 'Five Claude Code plugins that make a project easier to work in, with you deciding every change.',
      logo: { src: './src/assets/toolshed-mark.svg', alt: '' },
      favicon: '/favicon.svg',
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      customCss: ['./src/styles/theme.css', './src/styles/mocks.css'],
      pagination: true,
      plugins: [
        starlightLlmsTxt({
          projectName: 'Toolshed',
          description:
            'Toolshed is a marketplace of five Claude Code plugins: Sidequest (a work board in plain files, with model routing), Quartermaster (workspace setup and a one-change-at-a-time improvement loop), Codebase Mapper, Live Rules and Observability (a local record of what each turn cost). Every plugin works alone. State lives in plain files in the project.',
          details: [
            '## For agents reading this file',
            '',
            'The reference pages are generated from the plugin manifests, skill frontmatter and tool specs in the repository, so they match the plugins in the checkout the site was built from.',
            '',
            'Start with the reference pages for exact names. Read the guides for how the pieces fit: a task from start to pull request, working in a team, upgrading, and how routing picks a model.',
          ].join('\n'),
          promote: ['index*', 'start/**', 'reference/**'],
        }),
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'What is the Toolshed?', link: '/' },
            { label: 'Quick start', link: '/start/quick-start/' },
            { label: 'Walk-through: one task', link: '/start/walk-through/' },
            { label: 'Words used here', link: '/start/words/' },
          ],
        },
        {
          label: 'Why',
          items: [
            { label: 'Why the Toolshed', link: '/why/' },
            { label: 'Sidequest', link: '/why/sidequest/' },
            {
              label: 'Quartermaster',
              collapsed: false,
              items: [
                { label: 'Why Quartermaster', link: '/why/quartermaster/' },
                { label: 'Outfit: set up a project', link: '/why/quartermaster/outfit/' },
                { label: 'Resupply: one change at a time', link: '/why/quartermaster/resupply/' },
                { label: 'Review: did it help?', link: '/why/quartermaster/review/' },
                { label: 'Inspect: is it working?', link: '/why/quartermaster/inspect/' },
                { label: 'Where it stops', link: '/why/quartermaster/boundaries/' },
              ],
            },
            { label: 'Codebase Mapper', link: '/why/codebase-mapper/' },
            { label: 'Live Rules', link: '/why/live-rules/' },
            { label: 'Observability', link: '/why/observability/' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'A task, start to pull request', link: '/guides/task-to-pull-request/' },
            { label: 'Working in a team', link: '/guides/teams/' },
            { label: 'Coming from the older version', link: '/guides/upgrading/' },
            { label: 'How routing picks a model', link: '/guides/routing/' },
            { label: 'How quality is checked', link: '/guides/quality/' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Overview', link: '/reference/' },
            { label: 'Plugins', link: '/reference/plugins/' },
            { label: 'Skills', link: '/reference/skills/' },
            { label: 'Tools', link: '/reference/tools/' },
            { label: 'Agents', link: '/reference/agents/' },
            { label: 'Commands and scripts', link: '/reference/commands/' },
            { label: 'Files each plugin writes', link: '/reference/files/' },
            { label: 'Routing defaults', link: '/reference/routing-defaults/' },
          ],
        },
      ],
    }),
  ],
});
