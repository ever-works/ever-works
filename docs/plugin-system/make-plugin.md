---
id: make-plugin
title: 'Make.com Plugin'
sidebar_label: 'Make.com Workflows'
sidebar_position: 69
---

# Make.com Plugin

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `make`                             |
| Package            | `@ever-works/make-plugin`          |
| Category           | `pipeline`                         |
| Capabilities       | `pipeline`, `form-schema-provider` |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |

## Overview

The Make.com plugin lets you swap the standard generation pipeline for a [Make.com](https://www.make.com/) (formerly Integromat) scenario. When generation runs, the plugin POSTs the directory's prompt and metadata to a Make webhook and waits for the scenario to return generated items.

This is a no-code/low-code escape hatch — if your team already runs sophisticated Make scenarios for content generation, scraping, or third-party integrations, you can plug those directly into Ever Works without writing a custom plugin.

## Selecting It

In the directory edit screen, set **Generation Pipeline** to `Make.com Workflows`. The plugin appears once a webhook URL has been configured.

## Configuration

The settings schema is defined in `packages/plugins/make/src/` — see that source for current fields. At a minimum you will need:

- A Make.com webhook URL.
- The expected response schema for items (Make scenario must produce items in the agreed shape).

## Use Cases

- Routing generation through existing internal tooling that's already wired up in Make.
- Combining web scraping modules, transformations, and external APIs in a visual editor.
- Delegating to Make's queue for slow third-party calls.

## Related

- [Zapier Plugin](./zapier-plugin.md) — similar automation-platform integration
- [SIM AI Workflows Plugin](./sim-ai-plugin.md) — workflow-driven pipeline alternative
- [Built-in Plugins](./built-in-plugins.md)
- [Pipeline Plugins overview](./pipeline-plugins.md)
