# Claude Managed Agent Plugin

Full pipeline plugin that delegates work generation to Anthropic Claude Managed Agents.

This package is scaffolded for the Ever Works plugin runtime and uses the Managed Agents REST API directly.

Current scope:

- Creates or reuses a Managed Agent
- Creates or reuses a Managed Agents environment
- Starts a session and sends a generation request
- Collects the final `agent.message`
- Parses structured JSON into Ever Works pipeline outputs
- Optionally enriches items with screenshots via the existing screenshot facade

Notes:

- Managed Agents is currently in beta and requires the `managed-agents-2026-04-01` beta header.
- This plugin currently assumes the built-in `agent_toolset_20260401`.
- It intentionally fails fast if the session pauses for a custom tool result or tool confirmation, because those flows need first-class app orchestration outside a simple pipeline plugin.

## Models

Model list as of 2026-11-05 — source: [Managed Agents agent setup](https://platform.claude.com/docs/en/managed-agents/agent-setup)
and the [Claude models overview](https://platform.claude.com/docs/en/about-claude/models/overview). Availability depends
on your account, plan and region; the picker also accepts a custom model id and keeps existing saved selections.

| Model id                     | Context / output | Notes                                                    |
| ---------------------------- | ---------------- | -------------------------------------------------------- |
| `claude-opus-5-5`            | 1M / 128K        | Most capable                                             |
| `claude-sonnet-5-5`          | 1M / 128K        | **Default**                                              |
| `claude-haiku-5-5`           | 1M / 128K        | Fastest, lowest cost                                     |
| `claude-fable-5-1`           | 1M / 128K        | Frontier model, premium pricing ($10 / $50 per MTok)     |
| `claude-opus-4-7`            | 1M / 128K        | Legacy                                                   |
| `claude-opus-4-6`            | 1M / 128K        | Legacy                                                   |
| `claude-sonnet-4-6`          | 1M / 128K        | Legacy (previous default)                                |
| `claude-sonnet-4-5-20250929` | 200K / 64K       | Legacy, retires 2026-11-30                               |
| `claude-haiku-4-5`           | 200K / 64K       | Legacy API alias; Managed Agents lists only the dated id |
| `claude-haiku-4-5-20251001`  | 200K / 64K       | Legacy                                                   |

Limited-availability `claude-mythos-*` models are not listed.

**Default change (2026-11-05):** the default moved from `claude-sonnet-4-6` to `claude-sonnet-5-5`. A config that never
saved a model now runs on `claude-sonnet-5-5`; there is no backfill, because Ever Works has no real users yet. Saved
models are not changed. The model is sent per session (`agent_with_overrides`) and is not part of the agent config
hash, so the switch does not recreate the persistent agent.

## Troubleshooting

| Symptom                                                              | Likely cause                                                                                                    | Fix                                                                                                                                                                           |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generation never starts / stays at `0%`                              | `claude-managed-agent` not selected as the active pipeline plugin for this work                                 | Open the work → **Plugins** → `pipeline` capability and set `claude-managed-agent` as the active pipeline; or set it as the global pipeline default in **Settings → Plugins** |
| Step fails with `No AI / search / screenshot provider configured`    | Pipeline depends on capability plugins that are not enabled or have no credentials                              | Enable and configure the matching capability plugin (AI provider, search, screenshot, content-extractor) for the work or globally                                             |
| Step output looks wrong / generic                                    | Form-field tuning not set; pipeline using defaults that don't match the work's domain                           | Open the **Generator Form** for the work, set domain-specific fields (categories, target keywords, source URLs), and re-run the affected step                                 |
| `403 Forbidden` / `Managed Agents not enabled`                       | Managed Agents is in beta and requires explicit account access plus the `managed-agents-2026-04-01` beta header | Confirm the account is enrolled in the Managed Agents beta at console.anthropic.com; the plugin sends the required beta header automatically                                  |
| Run pauses with `requires custom tool result` or `tool confirmation` | Session is using a tool flow that needs orchestration outside this plugin                                       | Disable the offending tool in the agent profile, or switch to `claude-code` / `agent-pipeline` which support the full tool-loop                                               |
| Pipeline cannot resume after host restart                            | Checkpoint not persisted (only the standard pipeline persists checkpoints today)                                | Cancel the stuck run and re-trigger generation; for production reliability prefer `standard-pipeline`                                                                         |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/claude-managed-agent-plugin build
pnpm --filter @ever-works/claude-managed-agent-plugin test
```
