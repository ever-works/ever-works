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

The OpenCode plugin is a **full pipeline plugin** that delegates the entire work generation flow to [OpenCode](https://github.com/opencode-ai/opencode), an open-source coding agent. Like the other CLI-driven generators (Claude Code, Codex, Gemini), it packages the agent binary so users do not need to install it separately.

OpenCode is a good choice when you want to keep generation costs down by running against a self-hosted or open-weight model, while still getting an autonomous agent's tool-using behaviour.

## Selecting It

In the work edit screen, set **Generation Pipeline** to `OpenCode Generator`. The plugin appears in the dropdown once configured.

## Configuration

The settings schema is defined in `packages/plugins/opencode/src/` — see that source for current fields and defaults. OpenCode supports multiple AI provider backends, so you will typically configure both an agent runtime and an underlying provider.

## Related

- [Claude Code Plugin](./claude-code-plugin.md)
- [Codex Plugin](./codex-plugin.md)
- [Gemini Plugin](./gemini-plugin.md)
- [Built-in Plugins](./built-in-plugins.md)
- [Pipeline Plugins overview](./pipeline-plugins.md)
