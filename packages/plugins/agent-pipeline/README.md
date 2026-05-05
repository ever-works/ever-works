# @ever-works/agent-pipeline-plugin

Autonomous tool-based pipeline that researches and generates Work items using an AI agent.

## Plugin metadata

| Field        | Value                              |
| ------------ | ---------------------------------- |
| ID           | `agent-pipeline`                   |
| Category     | `pipeline`                         |
| Capabilities | `pipeline`, `form-schema-provider` |
| Author       | Ever Works Team                    |
| License      | AGPL-3.0                                |
| Built-in     | yes                                |
| Auto-enable  | yes                                |

## Agent Pipeline Plugin

Autonomous tool-based pipeline that researches and generates work items.

## How it works

1. **Prepare Context** - Loads existing items, queries data sources
2. **Generate Items** - AI agent researches and creates items
3. **Collect Results** - Gathers generated items
4. **Capture Screenshots** - Takes screenshots for items that need images
5. **Cleanup** - Releases resources

## Settings

Agent Pipeline derives almost all configuration from the active Ever Works AI provider plus per-work form fields. The minimal `settingsSchema` exposes:

- `maxSteps` — maximum number of agent tool-calling steps (default 50, range 10–500; hidden by default).

Per-work form fields cover the rest, including `max_pages_to_process`, `references_ttl_days`, `capture_screenshots`, and `target_items`. The plugin uses the OpenAI-compatible AI SDK (`@ai-sdk/openai-compatible`) and routes parent (orchestrator) and worker (extraction) calls through the AI provider's `complexModel` and `defaultModel`.

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/agent-pipeline-plugin build
pnpm --filter @ever-works/agent-pipeline-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Vercel AI SDK](https://ai-sdk.dev/)
- This plugin implements the `pipeline` capability defined in `@ever-works/plugin`.

## License

AGPL-3.0
