---
id: composio-plugin
title: 'Composio Plugin'
sidebar_label: 'Composio Integrations'
sidebar_position: 71
---

# Composio Plugin

| Field              | Value                              |
| ------------------ | ---------------------------------- |
| Plugin ID          | `composio`                         |
| Package            | `@ever-works/composio-plugin`      |
| Category           | `pipeline`                         |
| Capabilities       | `pipeline`, `form-schema-provider` |
| Configuration Mode | `user-required`                    |
| Auto Enable        | No                                 |

## Overview

The Composio plugin executes [Composio](https://composio.dev/) tools during work generation, giving Ever Works access to 500+ third-party app integrations (Gmail, Slack, GitHub, Notion, Linear, Salesforce, HubSpot, Stripe, Shopify, Airtable, …) without writing per-app connector code.

Composio brokers OAuth on your behalf: each user connects an app once through Composio's hosted flow, and the platform reuses that connection on subsequent tool calls. Unlike a single platform-wide API key, Composio scopes credentials to a `user_id` so every user can connect their own accounts safely.

## Selecting It

In the work edit screen, set **Generation Pipeline** to `Composio Integrations`. The plugin appears in the dropdown after the Composio API key has been configured in plugin settings.

## Configuration

The settings schema is defined in `packages/plugins/composio/src/` — see that source for current fields. You will typically need:

- A Composio API key (generate at [app.composio.dev/settings/api-keys](https://app.composio.dev/settings/api-keys)).
- A Composio `user_id` (defaults to your Ever Works user id; override via **Default Composio User ID** if the upstream account is connected under a different identifier — typically an email).
- Optional default `toolkit` and `tool_slug` (e.g. `GMAIL` / `GMAIL_SEND_EMAIL`).

Per-run options are exposed on the generator form: toolkit, tool slug, Composio user id override, result shape (`structured` / `native` / `side-effect`), field mapping for native records, custom tool arguments, and tool timeout.

## How it differs from Zapier and Activepieces

| Concern           | Composio                            | Zapier                                      | Activepieces                 |
| ----------------- | ----------------------------------- | ------------------------------------------- | ---------------------------- |
| Catalog scope     | 500+ apps                           | 9000+ apps                                  | ~200 apps                    |
| OAuth model       | Per-user, brokered by Composio      | Per-Zap connection                          | Per-project credentials      |
| Action identifier | Tool slug (`GMAIL_SEND_EMAIL`)      | App + action type + action key + connection | Flow ID                      |
| Best for          | Agent-style multi-user tool calling | Webhook chaining + multi-step automations   | Self-hosted automation flows |

Native Ever Works plugins (`github`, `notion-extractor`, …) still beat Composio for the apps they cover (richer extraction, custom UI hints, our own OAuth callbacks). Use those where they exist, and use Composio for the long tail.

## Use Cases

- Sending generation completion emails via `GMAIL_SEND_EMAIL`.
- Posting work updates to `SLACK_SEND_MESSAGE` or `DISCORD_POST_MESSAGE`.
- Creating GitHub issues via `GITHUB_CREATE_ISSUE` when items need follow-up.
- Filing Linear tickets via `LINEAR_CREATE_ISSUE` for editorial review.
- Pulling research from Notion via `NOTION_QUERY_DATABASE` to seed items.
- Logging generation runs to a Google Sheet via `GOOGLESHEETS_APPEND_VALUES`.

## Related

- [Zapier Plugin](./zapier-plugin.md) — alternative integration platform with a larger catalog
- [Activepieces Plugin](./activepieces-plugin.md) — alternative for self-hosted automation flows
- [Built-in Plugins](./built-in-plugins.md)
- [Pipeline Plugins overview](./pipeline-plugins.md)
