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

## Troubleshooting

| Symptom                                                          | Likely cause                                                                                        | Fix                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 Bad credentials` / `Resource not accessible by integration` | OAuth app misconfigured, token revoked, or the GitHub App is not installed on the target repository | Verify **Client ID** / **Client Secret** match the GitHub OAuth App, or install the GitHub App on the target repository; check `PLUGIN_GITHUB_CLIENT_ID` / `PLUGIN_GITHUB_CLIENT_SECRET` env-var fallbacks |
| OAuth login redirects loop or returns `state mismatch`           | Callback URL mismatch between the OAuth App and the configured `webAppUrl`                          | In the GitHub OAuth App settings, set the callback to `<webAppUrl>/api/auth/callback/github`; confirm `webAppUrl` in `apps/api` matches the URL used by the browser                                        |
| Repository creation fails with `name already exists`             | Slug collision in the user's namespace                                                              | Pick a unique slug or delete the conflicting repository in GitHub before re-running the work creation                                                                                                      |
| Webhook payloads not received                                    | Webhook signature secret mismatch or webhook URL not reachable                                      | Confirm `GITHUB_APP_WEBHOOK_SECRET` matches the value in the GitHub App settings; expose `/api/github-app/webhooks` to GitHub (use a tunnel for local dev)                                                 |
| GitHub Enterprise instance — calls fail with `404`               | API base URL still points to public GitHub                                                          | Set **API Base URL** to the GHES API endpoint, e.g. `https://github.example.com/api/v3`                                                                                                                    |

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
