---
id: gemini-plugin
title: 'Gemini Generator Plugin'
sidebar_label: 'Gemini Generator'
sidebar_position: 67
---

# Gemini Generator Plugin

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `gemini`                           |
| Package            | `@ever-works/gemini-plugin`        |
| Category           | `pipeline`                         |
| Capabilities       | `pipeline`, `form-schema-provider` |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |

## Overview

The Gemini plugin is a **full pipeline plugin** that delegates the entire work generation flow to the [Gemini CLI](https://github.com/google/generative-ai-cli). It runs the Gemini agent autonomously and consumes the resulting items.

> Note: This is **distinct** from the [`google` AI provider plugin](./google-ai-plugin.md). The `google` plugin exposes Gemini models for use as a regular AI provider inside the Standard or Agent pipelines. This `gemini` plugin replaces the entire pipeline with a CLI-driven Gemini agent.

## Selecting It

In the work edit screen, set **Generation Pipeline** to `Gemini Generator`. The plugin appears once configured with a Google AI API key.

## Configuration

The settings schema is defined in `packages/plugins/gemini/src/` — see that source for the current set of fields and defaults.

You will typically need:

- A Google AI Studio (Gemini) API key.
- Optional model selection (Gemini 2.5 Pro / 2.5 Flash).

## Related

- [Google AI Plugin](./google-ai-plugin.md) — the AI-provider variant of Gemini
- [Claude Code Plugin](./claude-code-plugin.md)
- [Codex Plugin](./codex-plugin.md)
- [Built-in Plugins](./built-in-plugins.md)
- [Pipeline Plugins overview](./pipeline-plugins.md)
