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
- A model selection (Claude Sonnet or Opus families are typical).

## Related

- [Claude Code Plugin](./claude-code-plugin.md) — local CLI variant
- [Built-in Plugins](./built-in-plugins.md)
- [Pipeline Plugins overview](./pipeline-plugins.md)
