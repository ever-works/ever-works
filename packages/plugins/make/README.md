# @ever-works/make-plugin

Make.com Workflow Pipeline Plugin - Delegates Work generation to Make.com scenarios and webhooks

## Plugin metadata

| Field        | Value                              |
| ------------ | ---------------------------------- |
| ID           | `make`                             |
| Category     | `pipeline`                         |
| Capabilities | `pipeline`, `form-schema-provider` |
| Author       | Ever Works Team                    |
| License      | AGPL-3.0                           |
| Built-in     | yes                                |
| Auto-enable  | no                                 |

## What does the Make.com plugin do?

This plugin lets Ever Works delegate the work-generation pipeline to [Make.com](https://www.make.com) (formerly Integromat), a visual workflow automation platform. Instead of running the built-in pipeline, Ever Works hands each generation request off to a Make.com scenario you design in the Make scenario editor.

You author a scenario with either a **Custom Webhook** trigger (for direct webhook-mode execution) or any trigger plus a **Webhook Response** module (for REST-triggered runs), connect whatever modules you need — AI providers, search APIs, HTTP requests, the 1500+ Make app modules — and the plugin invokes that scenario during work generation. The scenario returns structured JSON that Ever Works converts into pipeline outputs (the work draft, items list, categories, tags, brands).

## Why use it?

- Connect to Make.com's library of 1500+ app integrations without writing any integration code.
- No-code visual scenario editor with branching, error handling, iterators, and aggregators.
- Two execution modes — REST API scenario runs (with polling) or direct webhook URL invocation — pick whichever matches your scenario design.
- Swap in custom logic, change AI providers, or add data-enrichment steps without touching Ever Works code.
- Reuse existing Make scenarios, connections, and data stores you already maintain for other automations.

## How it works in Ever Works

When this plugin is selected as the active pipeline, the platform sends each generation request to Make either via a scenario REST run (`POST /scenarios/{id}/run` with polling on `/executions/{id}` when needed) or directly to a webhook URL. The scenario runs in Make — optionally calling AI providers, search APIs, scrapers, etc. — and returns a structured JSON response, either inline in the run response (when using `responsive: true` synchronous runs with a Webhook Response module) or via the webhook reply. The plugin parses that response back into Ever Works pipeline outputs (the work draft, items list, categories, tags). The required output schema is documented in the Ever Works docs.

## Getting started

1. Sign up at [make.com](https://www.make.com) and note your zone (e.g. `us2`, `eu1`).
2. Create a new scenario with either a Custom Webhook trigger or a Webhook Response module that emits the JSON shape Ever Works expects.
3. Generate an API token in your Make profile (with the scopes required for scenarios and hooks) and copy your scenario ID — and the webhook URL if you plan to use webhook-mode execution.
4. Open the Make.com plugin settings in Ever Works, paste the API key, set the zone-specific base URL (e.g. `https://us2.make.com/api/v2`), and provide the default scenario ID, hook ID, or webhook URL. Save.
5. Trigger a run from the **Generate** flow.

## Settings

- `apiKey` (**secret**) — Make.com API token. Required.
- `baseUrl` — Zone-specific API base URL (e.g. `https://us2.make.com/api/v2`).
- `teamId` — Optional team ID used to scope scenario and hook queries.
- `organizationId` — Optional organization ID used when no team ID is provided.
- `defaultScenarioId` — Default scenario invoked when the generator form does not specify one.
- `defaultHookId` — Optional default hook (webhook) ID to ping during the pipeline.
- `defaultWebhookUrl` — Default webhook URL for webhook-mode execution.

The generator form additionally exposes per-run options including execution mode (scenario vs. webhook), scenario/hook/webhook overrides, target item count, scenario timeout, repository access pass-through, and custom scenario parameters.

## Troubleshooting

| Symptom                                                           | Likely cause                                                                          | Fix                                                                                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generation never starts / stays at `0%`                           | `make` not selected as the active pipeline plugin for this work                       | Open the work → **Plugins** → `pipeline` capability and set `make` as the active pipeline; or set it as the global pipeline default in **Settings → Plugins** |
| Step fails with `No AI / search / screenshot provider configured` | Pipeline depends on capability plugins that are not enabled or have no credentials    | Enable and configure the matching capability plugin (AI provider, search, screenshot, content-extractor) for the work or globally                             |
| Step output looks wrong / generic                                 | Form-field tuning not set; pipeline using defaults that don't match the work's domain | Open the **Generator Form** for the work, set domain-specific fields (categories, target keywords, source URLs), and re-run the affected step                 |
| Webhook returns `404` / `Not Found`                               | Scenario / Zap not enabled or webhook URL stale                                       | In the Make.com Workflows dashboard verify the scenario is **active**, copy a fresh webhook URL into the plugin settings, and trigger a test run              |
| Pipeline cannot resume after host restart                         | Checkpoint not persisted (only the standard pipeline persists checkpoints today)      | Cancel the stuck run and re-trigger generation; for production reliability prefer `standard-pipeline`                                                         |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/make-plugin build
pnpm --filter @ever-works/make-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Make.com homepage](https://www.make.com)
- [Make.com API documentation](https://developers.make.com/api-documentation)

## License

AGPL-3.0
