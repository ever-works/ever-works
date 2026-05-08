# @ever-works/claude-code-plugin

Claude Code Generator Plugin - Full pipeline plugin that delegates generation to Claude Code.

## Plugin metadata

| Field        | Value                              |
| ------------ | ---------------------------------- |
| ID           | `claude-code`                      |
| Category     | `pipeline`                         |
| Capabilities | `pipeline`, `form-schema-provider` |
| Author       | Ever Works Team                    |
| License      | AGPL-3.0                           |
| Built-in     | yes                                |
| Auto-enable  | no                                 |

## Claude Code Generator Plugin

Full pipeline plugin that delegates the entire work generation to Claude Code. This plugin runs a single Claude Code session that autonomously handles web search, content creation, and file generation.

## How it works

The plugin runs 6 sequential steps:

1. **Setup Claude Code** - Downloads and caches the Claude Code CLI binary
2. **Prepare Context** - Creates a temporary workspace and seeds it with existing items and metadata
3. **Generate Items** - Executes Claude Code CLI to research and generate work items as JSON files
4. **Collect Results** - Reads the generated JSON files back to build the pipeline result
5. **Capture Screenshots** - Takes screenshots for items that need images
6. **Cleanup** - Removes the temporary workspace

## Settings

| Setting      | Description             |
| ------------ | ----------------------- |
| `oauthToken` | Claude Code OAuth token |
| `apiKey`     | Anthropic API key       |

### Authentication

At least one of `oauthToken` or `apiKey` must be provided. OAuth token takes precedence.

**OAuth Token** (recommended):

```bash
claude setup-token
```

**API Key**:
Get one from [console.anthropic.com](https://console.anthropic.com)

## Usage

Enable the plugin for a work and trigger generation with `providers.pipeline: 'claude-code'`.

## Settings

The `settingsSchema` exposes:

- `oauthToken` (user, secret) — Claude Code OAuth token from `claude setup-token`. Read from env `PLUGIN_CLAUDE_CODE_OAUTH_TOKEN`.
- `apiKey` (user, secret) — Anthropic API key from console.anthropic.com.
- `model` (global) — Model alias (`sonnet`, `opus`, `haiku`) or explicit version (e.g. `claude-sonnet-4-5-20250929`). Defaults to `sonnet`.
- `version` (hidden) — Claude Code CLI version pinned by the plugin; the binary is downloaded and cached on first use.
- `maxTurns` (hidden) — maximum agentic turns per session (default 50, range 1–100).
- `maxBudgetUsd` (hidden) — optional USD budget per generation.

The plugin's **CLI binary** is managed automatically and stored under the platform's temp directory; users do not configure a binary path. **Auth mode** is implicit: if `oauthToken` is set the plugin uses OAuth, otherwise it falls back to the Anthropic API key.

## Troubleshooting

| Symptom                                                           | Likely cause                                                                          | Fix                                                                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generation never starts / stays at `0%`                           | `claude-code` not selected as the active pipeline plugin for this work                | Open the work → **Plugins** → `pipeline` capability and set `claude-code` as the active pipeline; or set it as the global pipeline default in **Settings → Plugins** |
| Step fails with `No AI / search / screenshot provider configured` | Pipeline depends on capability plugins that are not enabled or have no credentials    | Enable and configure the matching capability plugin (AI provider, search, screenshot, content-extractor) for the work or globally                                    |
| Step output looks wrong / generic                                 | Form-field tuning not set; pipeline using defaults that don't match the work's domain | Open the **Generator Form** for the work, set domain-specific fields (categories, target keywords, source URLs), and re-run the affected step                        |
| Subprocess error: `command not found`                             | `Claude Code Generator` CLI not installed on the host running the API                 | Install the Claude Code Generator CLI on the API host and ensure it is on `PATH`; verify by running `which <cli>` from the same shell that launches `pnpm dev:api`   |
| Authentication / device-auth flow stalls                          | Device-auth code never confirmed in the upstream IDE / browser                        | Re-run the device-auth flow from **Settings → Plugins → claude-code → Connect**, then complete the prompt in the upstream service before the code expires            |
| Pipeline cannot resume after host restart                         | Checkpoint not persisted (only the standard pipeline persists checkpoints today)      | Cancel the stuck run and re-trigger generation; for production reliability prefer `standard-pipeline`                                                                |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/claude-code-plugin build
pnpm --filter @ever-works/claude-code-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Claude Code homepage](https://github.com/anthropics/claude-code)
- [Anthropic console](https://console.anthropic.com)
- This plugin implements the `pipeline` capability defined in `@ever-works/plugin`.

## License

AGPL-3.0
