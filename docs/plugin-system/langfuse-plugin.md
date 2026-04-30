---
id: langfuse-plugin
title: 'Langfuse Plugin'
sidebar_label: 'Langfuse'
sidebar_position: 71
---

# Langfuse Plugin

| Field              | Value                          |
| ------------------ | ------------------------------ |
| Plugin ID          | `langfuse`                     |
| Package            | `@ever-works/langfuse-plugin`  |
| Category           | `utility`                      |
| Capabilities       | `prompt-provider`              |
| Auto Enable        | No                             |

## Overview

The Langfuse plugin externalizes prompt management to [Langfuse](https://langfuse.com/) — an open-source LLM observability and prompt-management platform. Instead of shipping prompt templates inside the codebase, prompts are stored in your Langfuse project where you can:

- **Version** prompts and roll back changes.
- **Label** prompts (`production`, `staging`, etc.) and switch labels without redeploys.
- **A/B test** prompt variants with traffic splits.
- **Trace** every generation back to the exact prompt version that produced it.

When the plugin is enabled and configured, the platform's `prompt-provider` capability fetches prompts from Langfuse at runtime instead of reading them from disk. If Langfuse is unavailable or a prompt is missing, the platform falls back to its built-in defaults.

## Configuration

The settings schema is defined in `packages/plugins/langfuse/src/` — see that source for current fields. You will typically need:

- A Langfuse public key and secret key.
- The Langfuse host URL (cloud or self-hosted).
- Optional default label (e.g. `production`) for prompt resolution.

## When to Use

- You want non-engineers (e.g. content / prompt engineers) to ship prompt changes without a code deploy.
- You need full observability over which prompt produced which generation.
- You want to A/B-test prompt variants in production traffic.

## Related

- [Plugin Categories](./plugin-categories.md)
- [Built-in Plugins](./built-in-plugins.md)
