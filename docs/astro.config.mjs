import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://eigenwise.github.io',
  base: '/eigenwise-toolshed',
  redirects: {
    '/getting-started/codex-gateway': '/eigenwise-toolshed/getting-started/model-gateway',
    '/reference/codex-gateway': '/eigenwise-toolshed/reference/model-gateway',
  },
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
          label: 'Use the plugins',
          items: [
            { label: 'Workbench', slug: 'getting-started/workbench' },
            { label: 'Model Gateway', slug: 'getting-started/model-gateway' },
            { label: 'Codegraph', slug: 'getting-started/codegraph' },
            { label: 'Sidequest', slug: 'getting-started/sidequest' },
            { label: 'Codebase Mapper', slug: 'getting-started/codebase-mapper' },
            { label: 'Live Rules', slug: 'getting-started/live-rules' },
            { label: 'Quartermaster', slug: 'getting-started/quartermaster' },
            { label: 'Experiment loops', slug: 'getting-started/experiments' },
          ],
        },
        {
          label: 'Observability',
          items: [
            { label: 'Overview', slug: 'observability' },
            { label: 'Setup', slug: 'observability/setup' },
            { label: 'Dashboard', slug: 'observability/dashboard' },
            { label: 'Per-project opt-in', slug: 'observability/project-opt-in' },
          ],
        },
        {
          label: 'Maintainer docs',
          items: [
            { label: 'Architecture', slug: 'architecture' },
            { label: 'Modular Toolshed', slug: 'architecture/modular-architecture' },
            { label: 'Contributing to the docs', slug: 'contributing' },
            { label: 'Release process', slug: 'release-process' },
          ],
        },
        {
          label: 'Plugin reference',
          items: [
            { label: 'Overview', slug: 'reference' },
            { label: 'Workbench', slug: 'reference/workbench' },
            { label: 'Observability', slug: 'reference/observability' },
            { label: 'Model Gateway', slug: 'reference/model-gateway' },
            { label: 'Codebase Mapper', slug: 'reference/codebase-mapper' },
            { label: 'Live Rules', slug: 'reference/live-rules' },
            { label: 'Sidequest', slug: 'reference/sidequest' },
            { label: 'Quartermaster', slug: 'reference/quartermaster' },
            { label: 'Marketplace versions', slug: 'reference/marketplace' },
          ],
        },
      ],
    }),
  ],
});
