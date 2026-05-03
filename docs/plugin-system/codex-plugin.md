---
id: codex-plugin
title: 'Codex Generator Plugin'
sidebar_label: 'Codex Generator'
sidebar_position: 66
---

# Codex Generator Plugin

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `codex`                            |
| Package            | `@ever-works/codex-plugin`         |
| Category           | `pipeline`                         |
| Capabilities       | `pipeline`, `form-schema-provider` |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |

## Overview

The Codex plugin is a **full pipeline plugin** that delegates the entire work generation flow to OpenAI's Codex agent. It is one of several CLI-driven generators (alongside `claude-code`, `gemini`, and `opencode`) that run an autonomous coding agent locally to produce work data.

The plugin packages the Codex CLI binary so users do not need to install it separately; the binary is fetched and unpacked at runtime.

## Selecting It

In the work edit screen, set **Generation Pipeline** to `Codex Generator`. The plugin appears in the dropdown once it has been configured with an API key.

## Configuration

Configuration is provided through the work settings UI. The settings schema is defined in `packages/plugins/codex/src/` — see that source for the current set of fields and defaults.

You will typically need:

- An OpenAI API key with Codex access.
- Optional model and budget overrides.

## Related

- [Claude Code Plugin](./claude-code-plugin.md)
- [Gemini Plugin](./gemini-plugin.md)
- [OpenCode Plugin](./opencode-plugin.md)
- [Built-in Plugins](./built-in-plugins.md)
- [Pipeline Plugins overview](./pipeline-plugins.md)
