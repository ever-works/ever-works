---
id: zapier-plugin
title: 'Zapier Plugin'
sidebar_label: 'Zapier Automation'
sidebar_position: 70
---

# Zapier Plugin

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `zapier`                           |
| Package            | `@ever-works/zapier-plugin`        |
| Category           | `pipeline`                         |
| Capabilities       | `pipeline`, `form-schema-provider` |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |

## Overview

The Zapier plugin triggers [Zapier](https://zapier.com/) actions during directory generation. Unlike Make.com which can drive an entire generation flow, Zapier is most often used to wire generation events into Zapier's 7000+ integrations — for example, posting "directory generation finished" notifications to Slack, archiving generated items in Airtable, or kicking off downstream marketing workflows.

## Selecting It

In the directory edit screen, set **Generation Pipeline** to `Zapier Automation`. The plugin appears in the dropdown after a Zap webhook URL has been configured.

## Configuration

The settings schema is defined in `packages/plugins/zapier/src/` — see that source for current fields. You will typically need:

- A Zap webhook URL.
- Optional secret for verifying webhook payloads.

## Use Cases

- Notifying teammates in Slack/Teams when a directory finishes generating.
- Archiving generated items to Airtable, Notion, or Google Sheets.
- Triggering email campaigns or social posts when new items are published.
- Logging generation runs to an internal dashboard.

## Related

- [Make.com Plugin](./make-plugin.md) — alternative no-code automation platform
- [Built-in Plugins](./built-in-plugins.md)
- [Pipeline Plugins overview](./pipeline-plugins.md)
