import { defineConfig } from 'vitepress';

const origin = 'https://leonevo1103.github.io';
const base = '/surfaceloom/';
const repository = 'https://github.com/LeonEvo1103/surfaceloom';

export default defineConfig({
  title: 'SurfaceLoom',
  description: 'Test AI agent approvals, tool calls, and side effects with repeatable browser workflows and verifiable evidence.',
  lang: 'en-US',
  base,
  srcDir: './content',
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}mark.svg` }],
    ['meta', { name: 'theme-color', content: '#0d766e' }],
  ],
  sitemap: { hostname: `${origin}${base}` },
  transformHead({ pageData }) {
    if (pageData.relativePath === '404.md') return [['meta', { name: 'robots', content: 'noindex' }]];
    const path = pageData.relativePath.replace(/index\.md$/, '').replace(/\.md$/, '.html');
    const url = `${origin}${base}${path}`;
    return [
      ['link', { rel: 'canonical', href: url }],
      ['meta', { property: 'og:type', content: 'website' }],
      ['meta', { property: 'og:site_name', content: 'SurfaceLoom' }],
      ['meta', { property: 'og:title', content: `${pageData.title} | SurfaceLoom` }],
      ['meta', { property: 'og:description', content: pageData.description }],
      ['meta', { property: 'og:url', content: url }],
      ['meta', { name: 'twitter:card', content: 'summary' }],
    ];
  },
  themeConfig: {
    logo: '/mark.svg',
    nav: [
      { text: 'Quick start', link: '/guide/quick-start' },
      { text: 'Tutorials', link: '/tutorials/approval-testing' },
      { text: 'Capabilities', link: '/guide/capabilities' },
      { text: 'Reference', link: '/guide/reference' },
    ],
    sidebar: [
      { text: 'Start here', items: [
        { text: 'Run your first example', link: '/guide/quick-start' },
        { text: 'Support & limitations', link: '/guide/capabilities' },
      ] },
      { text: 'Test agent behavior', items: [
        { text: 'Verify approval rejection', link: '/tutorials/approval-testing' },
        { text: 'Catch duplicate tool effects', link: '/tutorials/tool-side-effects' },
      ] },
      { text: 'Build with SurfaceLoom', items: [
        { text: 'Timeouts & runtime helpers', link: '/guide/runtime-helpers' },
        { text: 'API & architecture reference', link: '/guide/reference' },
      ] },
    ],
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: repository }],
    editLink: { pattern: `${repository}/edit/main/website/content/:path` },
    outline: [2, 3],
    footer: {
      message: 'Experimental framework · MIT licensed · No stable API guarantee',
      copyright: 'SurfaceLoom contributors',
    },
  },
});
