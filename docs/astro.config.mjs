import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://eigenwise.github.io',
  base: '/eigenwise-toolshed',
  integrations: [
    starlight({
      title: 'Eigenwise Toolshed',
      description: 'Sharp little tools for Claude Code, kept in one shed.',
      customCss: ['./src/styles/custom.css'],
      head: [
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&family=JetBrains+Mono:wght@400;500;600&display=swap',
          },
        },
      ],
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/Eigenwise/eigenwise-toolshed',
        },
      ],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Overview', slug: 'index' },
            { label: 'Getting started', slug: 'getting-started' },
          ],
        },
        {
          label: 'Setup guides',
          items: [
            { label: 'Workbench', slug: 'getting-started/workbench' },
            { label: 'Sidequest', slug: 'getting-started/sidequest' },
            { label: 'Codex Gateway', slug: 'getting-started/codex-gateway' },
          ],
        },
        {
          label: 'Observability',
          items: [
            { label: 'Overview', slug: 'observability' },
            { label: 'Dashboard', slug: 'observability/dashboard' },
            { label: 'Per-project opt-in', slug: 'observability/project-opt-in' },
          ],
        },
        {
          label: 'Architecture',
          items: [
            { label: 'Overview', slug: 'architecture' },
            { label: 'Modular toolshed', slug: 'architecture/modular-architecture' },
          ],
        },
        {
          label: 'Plugin reference',
          items: [
            { label: 'Overview', slug: 'reference' },
            { label: 'Workbench', slug: 'reference/workbench' },
            { label: 'Codebase Mapper', slug: 'reference/codebase-mapper' },
            { label: 'Live Rules', slug: 'reference/live-rules' },
            { label: 'Sidequest', slug: 'reference/sidequest' },
          ],
        },
      ],
    }),
  ],
});
