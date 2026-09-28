# Documentation website

The public site is https://leonevo1103.github.io/surfaceloom/.
It uses VitePress; the framework runtime has no dependency on the site tooling.
Vite is pinned to patched 6.4.3 through an override because VitePress 1.6.4's
default Vite 5 dependency retains development-server security advisories. The
Vue plugin supports Vite 6; validate build, preview, and development mode when
changing this override.

```bash
npm --prefix website ci
npm --prefix website run dev
npm --prefix website run build
npm --prefix website run preview
```

Edit pages in `content/`. Keep claims aligned with `docs/framework/capabilities.md`
and `docs/FRAMEWORK_SSOT.md`; link to detailed source guides instead of duplicating
their APIs. Every page needs an accurate title and description. VitePress checks
internal links during builds and generates static HTML, a local search index, and
`sitemap.xml`. The site uses the `/surfaceloom/` project prefix, including canonical
URLs, navigation, and assets. Update the hostname/base together if it moves.
The `public/` asset directory is excluded from page discovery so asset README
files are not compiled into documentation pages or listed in the sitemap.

The Pages workflow builds pull requests without deployment permissions. Pushes to
`main` build and deploy to the `github-pages` environment. Repository Settings →
Pages must use GitHub Actions as its source. A manual workflow dispatch can rebuild
the main branch. Only the generated `.vitepress/dist` directory is uploaded.

Search-engine ownership verification and sitemap submission are separate account
operations. This repository does not claim that deployment guarantees indexing.
The `google-site-verification` meta tag in `.vitepress/config.mts` is the public
ownership proof for this URL-prefix property; keep it after verification.
A project-level `robots.txt` cannot govern the hostname root; do not add one here
and assume it controls `leonevo1103.github.io/robots.txt`.
