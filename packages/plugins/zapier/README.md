# @ever-works/zapier-plugin

Zapier Automation Pipeline Plugin - Triggers Zapier actions during Work generation

## Plugin metadata

| Field        | Value                              |
| ------------ | ---------------------------------- |
| ID           | `zapier`                           |
| Category     | `pipeline`                         |
| Capabilities | `pipeline`, `form-schema-provider` |
| Author       | Ever Works Team                    |
| License      | AGPL-3.0                           |
| Built-in     | yes                                |
| Auto-enable  | no                                 |

## What does the Zapier plugin do?

This plugin lets Ever Works delegate the work-generation pipeline to [Zapier](https://zapier.com), the workflow-automation platform with connectors for thousands of apps. Instead of running the built-in pipeline, Ever Works invokes a Zapier action — through the official Zapier SDK — during each generation request.

You pick any Zapier action (search, create, or fire-and-forget), connect it to one of your Zapier authentications, and the plugin executes that action with the work context payload. Zapier returns the action result, which Ever Works converts into pipeline outputs in one of two shapes: a structured `{ items: [...] }` contract for custom Zaps, or a native-record mode where raw Zapier output is projected onto work items via a configurable field mapping. Side-effect actions (send email, post a message, create a task) are also supported and complete with zero items.

## Why use it?

- Trigger any of Zapier's integrations across thousands of apps without writing connector code.
- Three execution shapes — structured items, native record with field mapping, or fire-and-forget side effect — to match different use cases.
- Reuse existing Zapier authentications, app connections, and Zaps you already maintain.
- Swap in different actions or remap fields without touching Ever Works code.
- Use long-lived OAuth client credentials in production and short-lived access tokens for local development.

## How it works in Ever Works

When this plugin is selected as the active pipeline, the platform invokes a Zapier action through the official `@zapier/zapier-sdk`, identifying it by `appKey`, `actionType` (search/create/etc.), and `actionKey`, paired with one of your Zapier authentications. The action runs on Zapier's infrastructure and returns its result. Depending on the configured result shape, the plugin either expects a structured `{ items: [...] }` JSON object, projects raw record fields onto work items using your field mapping, or treats the action as a side effect that produces no items. The structured output is parsed back into Ever Works pipeline outputs (the work draft, items list, categories, tags). The required output schema is documented in the Ever Works docs.

## Getting started

1. Sign up at [zapier.com](https://zapier.com) and identify the action you want Ever Works to trigger (note its `app_key`, `action_type`, and `action_key`).
2. In the Zapier UI, connect the authentication you want the action to use and copy its authentication ID.
3. Run `npx zapier-sdk create-client-credentials` to mint long-lived Client ID and Client Secret values for production use, or `npx zapier-sdk login` to obtain a short-lived access token for local development.
4. Open the Zapier plugin settings in Ever Works and paste either the Client ID + Client Secret or the access token. Save.
5. In the **Generate** flow, set the action reference (`app_key`, `action_type`, `action_key`, `authentication_id`) and the result shape, then trigger a run.

## Settings

- `clientId` — Long-lived OAuth Client ID from `npx zapier-sdk create-client-credentials`. Recommended for production.
- `clientSecret` (**secret**) — Long-lived Client Secret paired with `clientId`. Shown only once during creation.
- `accessToken` (**secret**) — Short-lived bearer token from `npx zapier-sdk login`. Use for local development only.
- `baseUrl` — Override the Zapier SDK base URL (leave empty for the SDK default).

Authentication requires either `accessToken` _or_ both `clientId` and `clientSecret`. The generator form additionally exposes per-run options including the action reference (app key, action type, action key, authentication ID), the result shape (`structured` / native record / `side-effect`), the field mapping for native records, and the action timeout.

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/zapier-plugin build
pnpm --filter @ever-works/zapier-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Zapier homepage](https://zapier.com)
- [Zapier SDK documentation](https://docs.zapier.com/sdk)

## License

AGPL-3.0
