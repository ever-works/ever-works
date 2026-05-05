# @ever-works/activepieces-plugin

Activepieces Automation Pipeline Plugin - Delegates Work generation steps to Activepieces flows

## Plugin metadata

| Field         | Value                                                  |
| ------------- | ------------------------------------------------------ |
| ID            | `activepieces`                                         |
| Category      | `pipeline`                                             |
| Capabilities  | `pipeline`, `form-schema-provider`                     |
| Author        | Ever Works Team                                        |
| License       | MIT                                                    |
| Built-in      | yes                                                    |
| Auto-enable   | no                                                     |

## What does the Activepieces plugin do?

This plugin lets Ever Works delegate the work-generation pipeline to [Activepieces](https://www.activepieces.com), an open-source, AI-first automation platform available as both a managed cloud service and a self-hosted deployment. Instead of running the built-in pipeline, Ever Works hands each generation request off to an Activepieces flow that you design visually in the Activepieces builder.

You author a flow with a webhook trigger (and a Return Response action for synchronous output), wire up whatever pieces you need — AI providers, search APIs, scrapers, databases, custom code blocks — and the plugin invokes that flow during work generation. The flow returns structured JSON that Ever Works converts into pipeline outputs (the work draft, items list, categories, tags, brands).

## Why use it?

- Tap into Activepieces' library of pre-built pieces for hundreds of SaaS apps, databases, and AI services without writing integration code.
- No-code visual flow builder — non-developers on your team can iterate on the generation logic.
- Self-host Activepieces alongside Ever Works for full data residency and zero per-task vendor cost, or use Activepieces Cloud.
- Swap in custom logic, branching, retries, or human-in-the-loop steps without touching Ever Works code or redeploying.
- Reuse existing Activepieces flows, pieces, and connections you already maintain for other automations.

## How it works in Ever Works

When this plugin is selected as the active pipeline, the platform sends each generation request to your configured Activepieces flow via its webhook trigger (using the Activepieces REST API and your platform API key). The flow runs in Activepieces — optionally calling AI providers, search APIs, scrapers, etc. — and returns a structured JSON response through its Return Response action. The plugin parses that response back into Ever Works pipeline outputs (the work draft, items list, categories, tags). The required output schema is documented in the Ever Works docs.

## Getting started

1. Sign up for [Activepieces Cloud](https://www.activepieces.com) or deploy a self-hosted instance (Platform or Enterprise edition is required to issue API keys).
2. In your Activepieces dashboard, create a new flow with a **Webhook** trigger and a **Return Response** action that emits the JSON shape Ever Works expects.
3. Generate a Platform API key from the Activepieces dashboard and note your project ID and the flow ID.
4. Open the Activepieces plugin settings in Ever Works and paste the API key, project ID, and default flow ID. Save.
5. Trigger a run from the **Generate** flow and inspect the run record in the Activepieces dashboard if anything goes wrong.

## Settings

- `apiKey` (**secret**) — Activepieces Platform API key. Required.
- `baseUrl` — Activepieces API base URL. Defaults to Activepieces Cloud; override for self-hosted instances.
- `projectId` — Default project ID used to scope flow listings and run inspection.
- `defaultFlowId` — Flow ID invoked when the generator form does not specify one.

The generator form additionally exposes per-run options including the flow ID override, sync/async webhook mode, target item count, flow timeout, repository access pass-through, and custom flow parameters.

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/activepieces-plugin build
pnpm --filter @ever-works/activepieces-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Activepieces homepage](https://www.activepieces.com)
- [Activepieces API documentation](https://www.activepieces.com/docs/endpoints/overview)

## License

MIT
