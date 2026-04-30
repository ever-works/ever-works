---
id: linkup-plugin
title: 'Linkup Plugin'
sidebar_label: 'Linkup'
sidebar_position: 26
---

# Linkup Plugin

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `linkup`                           |
| Package            | `@ever-works/linkup-plugin`        |
| Category           | `search`                           |
| Capabilities       | `search`, `content-extractor`      |
| Configuration Mode | `hybrid`                           |
| Auto Enable        | No                                 |

## Overview

The Linkup plugin provides web search and content extraction via the [Linkup API](https://www.linkup.so/). Linkup is optimized for AI agents: results are scored for precision and the API can return clean, agent-ready content directly from the search call without a separate fetch step.

Because the plugin advertises both `search` and `content-extractor` capabilities, it can serve as a one-stop alternative to combinations like `tavily` + `local-content-extractor`.

## Configuration

The settings schema is defined in `packages/plugins/linkup/src/` — see that source for current fields and defaults. At a minimum you will need a Linkup API key (set via the directory settings UI or the `PLUGIN_LINKUP_API_KEY` environment variable, depending on the resolved configuration mode).

## When to Use

- You want a single provider that handles both search and clean content extraction.
- You need higher-precision results than generic SERP APIs return.
- You want AI-optimized content that's already cleaned of nav/ads/boilerplate.

## Related

- [Tavily Plugin](./tavily-plugin.md) — default search provider with a similar combined capability
- [Built-in Plugins](./built-in-plugins.md)
- [Search Plugins overview](./search-plugins.md)
