---
id: opencode-plugin
title: 'OpenCode Generator Plugin'
sidebar_label: 'OpenCode Generator'
sidebar_position: 68
---

# OpenCode Generator Plugin

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `opencode`                         |
| Package            | `@ever-works/opencode-plugin`      |
| Category           | `pipeline`                         |
| Capabilities       | `pipeline`, `form-schema-provider` |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |

## Overview

The OpenCode plugin is a **full pipeline plugin** that delegates the entire work generation flow to [OpenCode](https://github.com/anomalyco/opencode), an open-source coding agent. Like the other CLI-driven generators (Claude Code, Codex, Gemini), it packages the agent binary so users do not need to install it separately.

OpenCode is a good choice when you want to keep generation costs down by running against a self-hosted or open-weight model, while still getting an autonomous agent's tool-using behaviour.

## Selecting It

In the work edit screen, set **Generation Pipeline** to `OpenCode Generator`. The plugin appears in the dropdown once configured.

## Configuration

The settings schema is defined in `packages/plugins/opencode/src/` — see that source for current fields and defaults. OpenCode supports multiple AI provider backends, so you will typically configure both an agent runtime and an underlying provider.

### Models and CLI version

OpenCode has no model list of its own: it runs the work's active AI provider model (its complex-tier model, else its default), as of 2026-11-05 — see that provider plugin's page for its current list and default (for example [OpenRouter](./openrouter-plugin.md)). Availability depends on your account/plan/region; the provider's picker accepts a custom model id and keeps existing saved selections. When a provider plugin's default moves, OpenCode follows it; the 2026-11-05 refresh changes no OpenCode setting.

- **CLI version:** the plugin pins OpenCode `v1.19.5` ([release](https://github.com/anomalyco/opencode/releases/tag/v1.19.5), GitHub "Latest" v1 release on 2026-10-28; was `v1.0.223`). Releases come from `anomalyco/opencode`, where the project moved from `sst/opencode`. The SHA-256 checksum check fails closed when a release publishes no checksum.

These values ship with the CLI-agents models refresh, [PR #3087](https://github.com/ever-co/ever-works/pull/3087).

## Related

- [Claude Code Plugin](./claude-code-plugin.md)
- [Codex Plugin](./codex-plugin.md)
- [Gemini Plugin](./gemini-plugin.md)
- [Built-in Plugins](./built-in-plugins.md)
- [Pipeline Plugins overview](./pipeline-plugins.md)
