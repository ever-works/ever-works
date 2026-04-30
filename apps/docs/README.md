# Ever Works Documentation Site

This is the [Docusaurus 3](https://docusaurus.io/) documentation site for the Ever Works Platform. It is a workspace package inside the Ever Works monorepo.

## Layout

- **App (this folder)** — `platform/apps/docs/`
  - `docusaurus.config.ts` — site config (Algolia, Sentry, Mermaid, etc.)
  - `sidebarsPlatform.ts` — sidebar configuration
  - `src/` — custom React pages, components, theme, CSS
  - `static/` — static assets (images, CNAME)
  - `i18n/` — translations (13 locales)
  - `blog/` — blog content
- **Docs content** — `platform/docs/`
  - All markdown files served by this site live here, NOT inside the app folder.
  - The Docusaurus `docs.path` is set to `../../docs/`.
  - Internal `specs/` folder is also rendered (not part of the sidebar).

## Local Development

All commands run from the **monorepo root** unless noted:

```bash
# From repo root — install once for the whole monorepo
pnpm install

# Run docs dev server (port 3000 by default)
pnpm --filter ever-works-docs dev

# Build production bundle
pnpm --filter ever-works-docs build

# Serve a built bundle
pnpm --filter ever-works-docs serve

# Type-check
pnpm --filter ever-works-docs type-check

# Spell-check
pnpm --filter ever-works-docs spellcheck
```

You can also `cd apps/docs` and run `pnpm dev`, `pnpm build`, etc. directly.

## Editing Docs

To add or edit a documentation page:

1. Edit/create the `.md` or `.mdx` file under `platform/docs/`.
2. If it should appear in the sidebar, add an entry to `sidebarsPlatform.ts`.
3. Internal links should use relative paths (e.g. `./getting-started`, `./plugin-system/`), not absolute `/docs/` prefixed paths.

## Environment Variables

| Variable                              | Required | Description                       |
| ------------------------------------- | -------- | --------------------------------- |
| `ALGOLIA_APP_ID`                      | No       | Algolia search app ID             |
| `ALGOLIA_API_KEY`                     | No       | Algolia search API key            |
| `ALGOLIA_INDEX_NAME`                  | No       | Algolia index name                |
| `NEXT_PUBLIC_SENTRY_DNS`              | No       | Sentry DSN for error tracking     |
| `EVER_WORKS_WEBSITE_TEMPLATE_API_URL` | No       | API URL custom field              |

When Algolia env vars are unset, search falls back to `@easyops-cn/docusaurus-search-local`.

## Deployment

The site is deployed to `docs.ever.works` (see `static/CNAME`). The repo URL configured in `editUrl` points to this monorepo.
