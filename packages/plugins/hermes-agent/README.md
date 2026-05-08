# @ever-works/hermes-agent-plugin

Hermes Agent pipeline plugin for Ever Works.

## Plugin metadata

| Field        | Value                              |
| ------------ | ---------------------------------- |
| ID           | `hermes-agent`                     |
| Category     | `pipeline`                         |
| Capabilities | `pipeline`, `form-schema-provider` |
| Author       | Ever Works Team                    |
| License      | AGPL-3.0                           |
| Built-in     | yes                                |
| Auto-enable  | no                                 |

## Hermes Agent Plugin

Use a preconfigured Hermes Agent installation on the backend machine as the work generation engine for Ever Works.

## How it works

- Ever Works creates an isolated workspace for the work run.
- Hermes is launched in one-shot CLI mode against that workspace.
- Hermes researches the topic and writes a structured result file back into the workspace.
- Ever Works validates the result and stores the generated items.

## Backend prerequisites

1. Install Hermes Agent on the machine running Ever Works.
2. Run `hermes model` for the profile you want to use.
3. Enter the Hermes profile name in this plugin settings page.

This plugin does not manage Hermes provider secrets directly in v1. Hermes profile configuration remains the source of truth.

## Settings

Configured via `settingsSchema`:

- `profile` (required, user-scoped) — Hermes profile already configured on the backend via `hermes model`.
- `binaryPath` — override the Hermes CLI executable path if it is not available as `hermes` (hidden, global scope).
- `provider`, `model` — optional Hermes provider/model overrides passed to the CLI for each run.
- `toolsets` — comma-separated Hermes toolsets to enable for generation.
- `skills` — optional comma-separated Hermes skills to preload.
- `maxTurns` — maximum Hermes tool-calling turns per run (default 30, range 1–500).
- `yolo` — bypass Hermes approval prompts for automated runs (default `true`).

The CLI binary location is taken from the `binaryPath` setting and resolved against the host PATH; the plugin runs Hermes in one-shot mode against an isolated workspace per generation.

## Troubleshooting

| Symptom                                                           | Likely cause                                                                                         | Fix                                                                                                                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generation never starts / stays at `0%`                           | `hermes-agent` not selected as the active pipeline plugin for this work                              | Open the work → **Plugins** → `pipeline` capability and set `hermes-agent` as the active pipeline; or set it as the global pipeline default in **Settings → Plugins** |
| Step fails with `No AI / search / screenshot provider configured` | Pipeline depends on capability plugins that are not enabled or have no credentials                   | Enable and configure the matching capability plugin (AI provider, search, screenshot, content-extractor) for the work or globally                                     |
| Step output looks wrong / generic                                 | Form-field tuning not set; pipeline using defaults that don't match the work's domain                | Open the **Generator Form** for the work, set domain-specific fields (categories, target keywords, source URLs), and re-run the affected step                         |
| Subprocess error: `command not found` / `hermes: not found`       | Hermes CLI not installed on the host running the API, or `binaryPath` points to a missing executable | Install Hermes on the API host and run `hermes model` for the configured profile; if the binary isn't on `PATH`, set the **Binary Path** setting to the absolute path |
| Run aborts on the first tool-call approval prompt                 | `yolo` is set to `false` and there's no operator to confirm prompts                                  | Set `yolo: true` for automated runs (default), or run interactively in dev only                                                                                       |
| Pipeline cannot resume after host restart                         | Checkpoint not persisted (only the standard pipeline persists checkpoints today)                     | Cancel the stuck run and re-trigger generation; for production reliability prefer `standard-pipeline`                                                                 |

## Local development

This plugin ships built-in with the Ever Works platform. To work on it locally from the monorepo root:

```bash
pnpm install
pnpm --filter @ever-works/hermes-agent-plugin build
pnpm --filter @ever-works/hermes-agent-plugin test
```

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [Hermes Agent homepage](https://github.com/NousResearch/hermes-agent)
- [Hermes setup guide](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart)
- This plugin implements the `pipeline` capability defined in `@ever-works/plugin`.

## License

AGPL-3.0
