# @ever-works/vercel-plugin

Vercel deployment plugin for Ever Works - deploy works to Vercel

## Plugin metadata

| Field        | Value           |
| ------------ | --------------- |
| ID           | `vercel`        |
| Category     | `deployment`    |
| Capabilities | `deployment`    |
| Author       | Ever Works Team |
| License      | AGPL-3.0             |
| Built-in     | yes             |
| Auto-enable  | yes             |

## What does the Vercel plugin do?

This plugin deploys your work as a live, publicly accessible website on Vercel. Once configured, publishing a work produces a shareable URL backed by a global CDN.

## Why use it?

- **One-click publish** — deploy a work as a live website directly from Ever Works
- **Global CDN** — Vercel serves your site from edge locations worldwide for fast load times
- **Automatic HTTPS** — every deployment receives a secure URL by default
- **Custom domains** — connect your own domain through the Vercel dashboard

## How it works in Ever Works

When you deploy a work, Ever Works pushes the generated site to a GitHub repository and triggers a Vercel build through a GitHub Actions workflow. Vercel builds and hosts the site as a static website. The deployment facade tracks build status and provides the resulting deployment URL.

## Getting started

1. Create a Vercel account at [vercel.com](https://vercel.com)
2. Generate an API token from [vercel.com/account/tokens](https://vercel.com/account/tokens)
3. Enter your token in the settings below
4. Save settings to verify the token before using it for deployments

## Settings

- **Vercel API Token** (required, secret, user-scoped) — your personal Vercel API token; the plugin uses `user-required` configuration mode, so each user must supply their own token.

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/vercel-plugin build
pnpm --filter @ever-works/vercel-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Vercel homepage](https://vercel.com/account/tokens)
- [Vercel dashboard / API docs](https://vercel.com/account/tokens)

## License

AGPL-3.0
