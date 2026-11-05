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

### Models and CLI version

Model list as of 2026-11-05 — source: [Codex models](https://learn.chatgpt.com/docs/models) and the [OpenAI models page](https://developers.openai.com/api/docs/models). Availability depends on your account/plan/region (ChatGPT sign-in follows your plan; API-key sessions follow your OpenAI organization and project); the picker accepts a custom model id and keeps existing saved selections.

| Model id        | Notes                                                                      |
| --------------- | -------------------------------------------------------------------------- |
| `gpt-6-astra`   | Flagship                                                                   |
| `gpt-6.1-sol`   | **Default** (Codex's own default since CLI 0.161.0)                        |
| `gpt-6.1-terra` | Lower cost                                                                 |
| `gpt-6-luna`    | Cost-sensitive, high volume                                                |
| `gpt-5.4`       | Legacy: still served by the API, not offered with ChatGPT sign-in any more |

`codex-mini-latest` (retired 2026-02-12) and `gpt-5.2-codex` (retired 2026-07-23) are no longer listed; a config that saved one keeps it as a custom id.

- **CLI version:** the plugin pins Codex CLI `0.166.0` ([`rust-v0.166.0`](https://github.com/openai/codex/releases/tag/rust-v0.166.0), latest stable on 2026-10-29; was `0.120.0`). On Linux it always downloads the static musl build, because openai/codex has published no `*-unknown-linux-gnu` assets since 0.128.0.
- **Sandbox:** sandboxed runs use `codex exec --sandbox workspace-write`; `--full-auto` was removed from `codex exec` in 0.147.0.

**Default shift (2026-11-05):** configs that never saved a model use the new defaults; saved selections are kept. The default moved from `gpt-5.4` to `gpt-6.1-sol`.

These values ship with the CLI-agents models refresh, [PR #3087](https://github.com/ever-co/ever-works/pull/3087).

## Related

- [Claude Code Plugin](./claude-code-plugin.md)
- [Gemini Plugin](./gemini-plugin.md)
- [OpenCode Plugin](./opencode-plugin.md)
- [Built-in Plugins](./built-in-plugins.md)
- [Pipeline Plugins overview](./pipeline-plugins.md)
