---
id: claude-managed-agent-plugin
title: 'Claude Managed Agent Plugin'
sidebar_label: 'Claude Managed Agent'
sidebar_position: 65
---

# Claude Managed Agent Plugin

| Field              | Value                                     |
| ------------------ | ----------------------------------------- |
| Plugin ID          | `claude-managed-agent`                    |
| Package            | `@ever-works/claude-managed-agent-plugin` |
| Category           | `pipeline`                                |
| Capabilities       | `pipeline`, `form-schema-provider`        |
| Configuration Mode | `user-required`                           |
| Auto Enable        | No                                        |

## Overview

The Claude Managed Agent plugin delegates the **entire** work generation pipeline to [Anthropic's hosted Claude Managed Agent](https://docs.claude.com/) runtime. Unlike `claude-code` (which spawns the Claude Code CLI locally), this plugin sends generation requests to Anthropic's managed agent service and consumes the results, so there is nothing to install on your machine or server.

Use this plugin when you want a hosted, fully-managed generation pipeline backed by Claude — for example to offload long-running generation work to Anthropic's infrastructure rather than running it on your own workers.

## Selecting It

In the work edit screen, set **Generation Pipeline** to `Claude Managed Agent`. The plugin will only appear in the dropdown after it has been configured (it requires an Anthropic API key).

## Configuration

The plugin uses Anthropic's standard API authentication. The exact settings schema is defined in `packages/plugins/claude-managed-agent/src/` and is rendered automatically in the work settings UI; consult that source file for the up-to-date list of fields, defaults, and validation rules.

At a minimum you will need:

- An Anthropic API key with access to the Managed Agent endpoints.
- A model selection (default `claude-sonnet-5-5`; Claude Sonnet or Opus families are typical).

### Models

Model list as of 2026-11-05 — source: [Managed Agents agent setup](https://platform.claude.com/docs/en/managed-agents/agent-setup) and the [Claude models overview](https://platform.claude.com/docs/en/about-claude/models/overview). Availability depends on your account/plan/region; the picker accepts a custom model id and keeps existing saved selections.

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

**Default shift (2026-11-05):** configs that never saved a model use the new defaults; saved selections are kept. The default moved from `claude-sonnet-4-6` to `claude-sonnet-5-5`. The model is sent per session, so the switch does not recreate the persistent agent.

These values ship with the CLI-agents models refresh, [PR #3087](https://github.com/ever-co/ever-works/pull/3087).

## Related

- [Claude Code Plugin](./claude-code-plugin.md) — local CLI variant
- [Built-in Plugins](./built-in-plugins.md)
- [Pipeline Plugins overview](./pipeline-plugins.md)
