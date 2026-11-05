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

The Gemini plugin is a **full pipeline plugin** that delegates the entire work generation flow to the [Gemini CLI](https://github.com/google-gemini/gemini-cli). It runs the Gemini agent autonomously and consumes the resulting items.

> Note: This is **distinct** from the [`google` AI provider plugin](./google-ai-plugin.md). The `google` plugin exposes Gemini models for use as a regular AI provider inside the Standard or Agent pipelines. This `gemini` plugin replaces the entire pipeline with a CLI-driven Gemini agent.

## Selecting It

In the work edit screen, set **Generation Pipeline** to `Gemini Generator`. The plugin appears once configured with a Google AI API key.

## Configuration

The settings schema is defined in `packages/plugins/gemini/src/` — see that source for the current set of fields and defaults.

You will typically need:

- A Google AI Studio (Gemini) API key.
- Optional model selection (default `gemini-3.8-flash`).

### Models and CLI version

Model list as of 2026-11-05 — source: [Gemini API models](https://aistudio.google.com/docs/models) and [deprecations](https://aistudio.google.com/docs/deprecations). Availability depends on your account/plan/region; the picker accepts a custom model id and keeps existing saved selections.

| Model id                 | Notes                                                                           |
| ------------------------ | ------------------------------------------------------------------------------- |
| `gemini-4-argon`         | Flagship. The Gemini CLI README says the CLI is not optimized for Gemini 4+ yet |
| `gemini-3.8-flash`       | **Default.** Most intelligent Flash                                             |
| `gemini-3.6-flash`       | Previous Flash release                                                          |
| `gemini-3.5-flash-lite`  | Fastest, most cost-effective                                                    |
| `gemini-3.1-pro-preview` | Preview                                                                         |
| `gemini-3-flash-preview` | Preview                                                                         |
| `gemini-2.5-pro`         | Legacy: deprecated 2026-11-02, existing users only, re-routed from 2026-12-01   |
| `gemini-2.5-flash`       | Legacy: deprecated 2026-11-02, existing users only, re-routed from 2026-12-01   |
| `gemini-2.5-flash-lite`  | Legacy: past users only                                                         |

`gemini-3.1-flash-lite-preview` (shut down 2026-05-25) is no longer listed; a config that saved it keeps it as a custom id. Gemini 2.0 Flash shut down on 2026-06-01.

- **CLI version:** the plugin runs `npx --yes @google/gemini-cli@<version>` with `0.67.0` pinned (was `0.45.2`, which rewrote any model id ending in "flash" to its own default: [google-gemini/gemini-cli#28859](https://github.com/google-gemini/gemini-cli/issues/28859), fixed in 0.61.0). `latest` is an explicit opt-in.

**Default shift (2026-11-05):** configs that never saved a model use the new defaults; saved selections are kept. The default moved from `gemini-2.5-flash` to `gemini-3.8-flash`.

These values ship with the CLI-agents models refresh, [PR #3087](https://github.com/ever-co/ever-works/pull/3087).

## Related

- [Google AI Plugin](./google-ai-plugin.md) — the AI-provider variant of Gemini
- [Claude Code Plugin](./claude-code-plugin.md)
- [Codex Plugin](./codex-plugin.md)
- [Built-in Plugins](./built-in-plugins.md)
- [Pipeline Plugins overview](./pipeline-plugins.md)
