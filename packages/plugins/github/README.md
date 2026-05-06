# @ever-works/github-plugin

GitHub git provider plugin for Ever Works - repository management, git operations, and GitHub Actions

## Plugin metadata

| Field        | Value                   |
| ------------ | ----------------------- |
| ID           | `github`                |
| Category     | `git-provider`          |
| Capabilities | `git-provider`, `oauth` |
| Author       | Ever Works Team         |
| License      | AGPL-3.0                |
| Built-in     | yes                     |
| Auto-enable  | yes                     |

## What does the GitHub plugin do?

This plugin provides the Git operations and OAuth integration that underpin the deployment pipeline. It manages repositories, branches, commits, and pull requests on GitHub, and enables GitHub-based authentication.

## Key features

- **OAuth authentication** — sign in to Ever Works using a GitHub account
- **Repository management** — automatically creates and manages repositories for deployed works
- **Git operations** — handles cloning, committing, pushing, and branch management
- **Pull request workflow** — creates and merges pull requests as part of the deployment process

## How it works in Ever Works

GitHub is a core component of the deployment pipeline. When a work is deployed, Ever Works creates or updates a GitHub repository with the generated site, commits the changes, and triggers a GitHub Actions workflow that builds and deploys to the hosting provider. The OAuth facade also uses this plugin to handle GitHub-based sign-in.

## Getting started

The GitHub plugin is managed by the platform administrator. If you signed in with GitHub, it is already connected. The admin configures GitHub OAuth app credentials at the platform level.

## Settings

- **Client ID** (admin-only, global) — GitHub OAuth App Client ID; falls back to `PLUGIN_GITHUB_CLIENT_ID`.
- **Client Secret** (admin-only, secret) — GitHub OAuth App Client Secret; falls back to `PLUGIN_GITHUB_CLIENT_SECRET`.
- **API Base URL** (hidden, global) — defaults to `https://api.github.com`; override for GitHub Enterprise installations.

This plugin uses `admin-only` configuration mode — settings are managed at the platform level and not per user.

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/github-plugin build
pnpm --filter @ever-works/github-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [GitHub homepage](https://github.com)

## License

AGPL-3.0
