# Search and AI discovery

ChasteBusinessOS is a private authenticated workspace. Its public discovery
surface is deliberately narrow: the sign-in entry, the static product metadata,
the crawler rules, and the machine-readable project summary.

## What is published

- `apps/web-vite/index.html` carries the product title, description, Open Graph
  and Twitter metadata, the web manifest, and `SoftwareApplication` structured
  data. The social image is the repository banner, served from GitHub so the
  static page does not depend on an unverified deployment domain.
- `apps/web-vite/src/seo.ts` keeps the document title, description, robots
  directive, Open Graph fields, Twitter fields, and canonical URL in sync with
  the current route. The sign-in page is `index,follow`; every workspace,
  portal, widget, invitation, reset, print, and onboarding page is
  `noindex,nofollow`.
- `apps/web-vite/public/robots.txt` allows `/login` and the discovery assets and
  disallows the private workspace.
- `apps/web-vite/public/llms.txt` gives assistants and retrieval systems a
  concise product summary with links to the source, architecture, roadmap,
  setup guide, ADRs, and changelog.
- `apps/web-vite/public/site.webmanifest` supplies install metadata and icons.

## Canonical domain and sitemap

The deployment domain is not assumed in the repository. The route helper writes
a canonical URL from the current origin, so a deployment gets the right canonical
without a hard-coded host. Add a deployment-specific `sitemap.xml` and the
`Sitemap:` line in `robots.txt` only after the public origin is known. Do not
invent a domain in this repository.

## Public-page content

The sign-in page is the only indexable route. Keep its title, description, and
visible copy aligned with the product description. Authenticated application
pages should remain noindex; they are not marketing pages and must not leak
workspace data into search results.

## Verification

- `src/seo.test.ts` pins the public/private route split and the metadata writer.
- `pnpm typecheck`, `pnpm lint`, and `pnpm test` cover the client changes.
- The static files are served from `apps/web-vite/public`.
