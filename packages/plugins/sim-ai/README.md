# @ever-works/sim-ai-plugin

SIM AI Workflow Pipeline Plugin - Delegates Work generation to SIM AI workflows

## Plugin metadata

| Field         | Value                                                  |
| ------------- | ------------------------------------------------------ |
| ID            | `sim-ai`                                               |
| Category      | `pipeline`                                             |
| Capabilities  | `pipeline`, `form-schema-provider`                     |
| Author        | Ever Works Team                                        |
| License       | MIT                                                    |
| Built-in      | yes                                                    |
| Auto-enable   | no                                                     |

## What does the Sim AI plugin do?

This plugin lets Ever Works delegate the work-generation pipeline to [Sim AI](https://sim.ai), an open-source AI agent workflow builder. Instead of running the built-in pipeline, Ever Works hands each generation request off to a deployed Sim workflow that you design visually in the Sim builder.

You author a workflow in Sim, deploy it, and generate an API key for it. The plugin (using the official `simstudio-ts-sdk`) executes that workflow during work generation, passing in the work context, the request, and a summary of existing items. The workflow runs in Sim — optionally chaining LLM agents, tool calls, search APIs, and custom logic — and returns structured JSON that Ever Works converts into pipeline outputs (the work draft, items list, categories, tags, brands).

## Why use it?

- Build multi-step AI agent workflows visually without managing your own orchestration layer.
- Compose AI providers, tools, and custom blocks inside Sim's agent-native workflow editor.
- Self-host Sim or use the hosted offering — your choice of deployment model.
- Swap in custom logic, change models, or add tool calls without touching Ever Works code.
- Reuse the same Sim workflows across Ever Works and other applications via the Sim SDK.

## How it works in Ever Works

When this plugin is selected as the active pipeline, the platform sends each generation request to Sim through the official Sim Studio TypeScript SDK, identifying the workflow by ID and authenticating with your API key. The workflow runs in Sim — optionally calling AI providers, search APIs, tools, etc. — and the plugin polls until completion, then collects the structured JSON response. That response is parsed back into Ever Works pipeline outputs (the work draft, items list, categories, tags). The required output schema is documented in the Ever Works docs.

## Getting started

1. Sign up at [sim.ai](https://sim.ai) (or self-host Sim) and create a new workflow in the builder.
2. Deploy the workflow and generate an API key for it from the deployment dialog.
3. Copy the workflow ID from the Sim dashboard.
4. Open the Sim AI plugin settings in Ever Works, paste the API key, the workflow ID as the default workflow, and (optionally) a custom base URL if you are self-hosting Sim. Save.
5. Trigger a run from the **Generate** flow.

## Settings

- `apiKey` (**secret**) — Sim API key generated when deploying the workflow. Required.
- `baseUrl` — Custom Sim instance URL. Leave empty to use the default Sim cloud endpoint.
- `defaultWorkflowId` — Default Sim workflow to invoke when not specified in the generator form. Required.

The generator form additionally exposes per-run options including a workflow ID override, target item count, workflow timeout, repository access pass-through, and screenshot capture.

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/sim-ai-plugin build
pnpm --filter @ever-works/sim-ai-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Sim AI homepage](https://sim.ai)
- [Sim AI documentation](https://docs.sim.ai)

## License

MIT
