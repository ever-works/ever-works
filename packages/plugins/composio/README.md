# @ever-works/composio-plugin

Composio Integrations Pipeline Plugin - Executes Composio tools across 500+ third-party apps during Work generation.

## Plugin metadata

| Field        | Value                              |
| ------------ | ---------------------------------- |
| ID           | `composio`                         |
| Category     | `pipeline`                         |
| Capabilities | `pipeline`, `form-schema-provider` |
| Author       | Ever Works Team                    |
| License      | AGPL-3.0                           |
| Built-in     | yes                                |
| Auto-enable  | no                                 |

## What does the Composio plugin do?

This plugin lets Ever Works call any of [Composio](https://composio.dev)'s 500+ third-party integrations (Gmail, Slack, GitHub, Notion, Linear, Salesforce, HubSpot, Stripe, Shopify, Airtable, …) during work generation. Composio brokers OAuth on your behalf — each user connects an app once through Composio's hosted flow, and the platform reuses that connection to execute tools.

Instead of writing a per-app connector for every service your users want to integrate, you ship one plugin (this one) and your users get the entire Composio catalog. The plugin invokes tools through the official [`@composio/core`](https://www.npmjs.com/package/@composio/core) SDK (per Workspace AGENTS.md NN #22 — always use the official vendor SDK) and returns the result as pipeline outputs in one of three shapes: structured `{ items: [...] }`, native records with a field mapping, or side-effect only (fire-and-forget).

## Why use it?

- Get 500+ integrations without writing connector code.
- OAuth handled for you: Composio manages tokens, refresh, scopes, and rate limits.
- Per-user accounts: every user connects their own Gmail / Slack / GitHub without sharing credentials.
- Three execution shapes — structured items, native records via field mapping, or side-effect — to match different use cases.
- Coexists with native Ever Works plugins (github, notion-extractor, …) — use the dedicated plugin where it exists, Composio for everything else.

## How it works in Ever Works

When this plugin is selected as the active pipeline, the platform drives a `Composio` client from `@composio/core` through 6 sequential steps:

1. **Validate Composio Connection** — `composio.toolkits.get(...)` confirms the API key is accepted, then `composio.connectedAccounts.list({ userIds, toolkitSlugs })` confirms the user has an ACTIVE connected account for the requested toolkit.
2. **Prepare Tool Payload** — builds the `arguments` object with work metadata, an optional existing-items summary, an optional GitHub data repository, and any user-supplied tool params.
3. **Execute Composio Tool** — `composio.tools.execute(toolSlug, { userId, arguments })`. The SDK unwraps the v3 response envelope (`{ successful, data, error, log_id }`) for us.
4. **Collect & Validate Results** — parses the response, projects records onto work items if needed, deduplicates against existing items.
5. **Capture Screenshots** (optional) — uses the configured screenshot plugin to fetch images for items without them.
6. **Cleanup** — releases resources.

The plugin treats the **tool slug** as the unique identifier of an action (`GMAIL_SEND_EMAIL`, `GITHUB_CREATE_ISSUE`, …). The toolkit slug is informational and used for connected-account validation.

## Getting started

1. Sign up at [composio.dev](https://composio.dev) and grab your API key from **Settings → API Keys**.
2. Connect at least one toolkit (Gmail, GitHub, Slack, …) under your Composio `user_id` via the Composio dashboard.
3. Open the Composio plugin settings in Ever Works and paste the API key. If the upstream account is connected under a different identifier (typically an email), set **Default Composio User ID** to that value.
4. In the **Generate** flow, set the toolkit (e.g. `GMAIL`), the tool slug (e.g. `GMAIL_SEND_EMAIL`), the result shape, any custom tool arguments, then trigger a run.

## Settings

- `apiKey` (**secret**, required) — Composio API key, passed to the `@composio/core` SDK at construction time.
- `baseUrl` — Override the Composio API base URL (leave empty for the default `https://backend.composio.dev/api/v3`).
- `defaultUserId` — Composio `user_id` to run tools against. Defaults to your Ever Works user id.
- `defaultToolkit` — Default toolkit slug (e.g. `GMAIL`).
- `defaultToolSlug` — Default Composio tool slug (e.g. `GMAIL_SEND_EMAIL`).

The generator form additionally exposes per-run options including the toolkit, tool slug, Composio user id override, result shape, field mapping for native records, custom tool arguments, and tool timeout.

## Result modes

- **Structured items** — use when the tool already returns an `items` array that matches the work-item shape.
- **Native records** — use when the tool returns raw records (Gmail messages, Notion pages, GitHub issues, …) and you want to map fields such as name, URL, description, category, tags, image, brand, or content.
- **Side-effect only** — use when the tool should send a message, create a task, update another system, or trigger another workflow without adding work items.

## Composio vs. native Ever Works plugins

Ever Works ships some native plugins (`github`, `notion-extractor`, …) that integrate directly with specific services. Composio gives you the rest of the catalog. They coexist: keep the native plugin for the apps it covers, and use Composio for everything else. The native plugin usually offers tighter integration (richer extraction, custom UI hints, OAuth via Ever Works' own callbacks); Composio offers breadth.

## Troubleshooting

| Symptom                                                                      | Likely cause                                                                                 | Fix                                                                                                                                                               |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generation never starts / stays at `0%`                                      | `composio` not selected as the active pipeline plugin for this work                          | Open the work → **Plugins** → `pipeline` capability and set `composio` as the active pipeline; or set it as the global pipeline default in **Settings → Plugins** |
| `Composio rejected the API key (HTTP 401/403)`                               | API key missing or invalid                                                                   | Regenerate at https://app.composio.dev/settings/api-keys and paste into plugin settings                                                                           |
| `No active Composio connected account found for user "..." on toolkit "..."` | The user has not connected the requested toolkit, or the connection is `EXPIRED` / `REVOKED` | Open https://app.composio.dev/connections and complete (or re-initiate) the OAuth flow for the toolkit                                                            |
| `Composio returned 404 for /tools/execute/...`                               | Tool slug is wrong or has been renamed                                                       | Browse https://app.composio.dev/tools to find the current slug; tool slugs are uppercase and toolkit-prefixed                                                     |
| Tool succeeds but returns no items                                           | Tool returns native records, not structured items                                            | Switch **Result Shape** to "Native records" and set the field mapping (at minimum `name_field`)                                                                   |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/composio-plugin build
pnpm --filter @ever-works/composio-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Composio homepage](https://composio.dev)
- [Composio v3 docs](https://docs.composio.dev)

## License

AGPL-3.0
