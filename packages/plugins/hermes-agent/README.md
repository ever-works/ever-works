# @ever-works/hermes-agent-plugin

Hermes Agent pipeline plugin for Ever Works.

## Plugin metadata

| Field        | Value                                |
| ------------ | ------------------------------------ |
| ID           | `hermes-agent`                       |
| Category     | `pipeline`                           |
| Capabilities | `pipeline`, `form-schema-provider`   |
| Author       | Ever Works Team                      |
| License      | MIT                                  |
| Built-in     | yes                                  |
| Auto-enable  | no                                   |

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

MIT
