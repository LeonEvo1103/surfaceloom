# Product adapters

SurfaceLoom does not include adapters for a specific application. Consumers can
keep product-owned locators, launch policy, fixtures, and scenarios under
`projects/<product>` or in a separate private repository.

An in-repository product can optionally expose `repository-checks.mjs` and
`contracts/**/*.contract.test.mjs`; the shared runners discover those files without
hard-coding product names.
