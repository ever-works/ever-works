# @ever-works/codex-plugin

Full pipeline plugin that delegates work generation to the [Codex CLI](https://github.com/openai/codex). A single Codex session researches, creates, and updates work item JSON files inside a temporary workspace.

## Plugin metadata

| Field        | Value                                             |
| ------------ | ------------------------------------------------- |
| ID           | `codex`                                           |
| Category     | `pipeline`                                        |
| Capabilities | `pipeline`, `form-schema-provider`, `device-auth` |
| Author       | Ever Works Team                                   |
| License      | AGPL-3.0                                          |
| Built-in     | yes                                               |
| Auto-enable  | no                                                |

## Pipeline Steps

The plugin runs 6 sequential steps:

| #   | Step                    | Description                                                       | Optional |
| --- | ----------------------- | ----------------------------------------------------------------- | -------- |
| 1   | **Setup Codex**         | Downloads/caches the Codex CLI binary and resolves authentication | No       |
| 2   | **Prepare Context**     | Creates a temp workspace, seeds existing items and metadata       | No       |
| 3   | **Generate Items**      | Executes Codex CLI to research and generate items as JSON files   | No       |
| 4   | **Collect Results**     | Reads generated JSON files back into the pipeline result          | No       |
| 5   | **Capture Screenshots** | Takes screenshots for generated items (via screenshot provider)   | Yes      |
| 6   | **Cleanup**             | Removes the temporary workspace                                   | Yes      |

During step 3, a **taxonomy watcher** monitors the workspace for new item files and keeps `_meta/` taxonomy files (categories, tags, brands) in sync in real time. Progress is reported per item as files appear.

## Authentication

Codex supports two authentication modes:

### API Key

Provide an OpenAI API key in plugin settings (`apiKey` field).

Get one from [platform.openai.com/account/api-keys](https://platform.openai.com/account/api-keys).

### Local Codex Auth

If no API key is configured, the plugin can use local Codex CLI auth stored in a managed per-user `CODEX_HOME`. Authenticate via the onboarding wizard or manually:

```bash
codex login
```

The plugin materializes an isolated `CODEX_HOME` for each Ever Works user under its managed temp work, so local Codex auth does not rely on a shared `~/.codex/auth.json`.

The onboarding UI provides a 3-step flow: choose auth mode, configure credentials, and verify the connection.

## Settings

| Setting               | Type    | Scope  | Description                                                |
| --------------------- | ------- | ------ | ---------------------------------------------------------- |
| `authMode`            | string  | user   | `api-key` or `local` (hidden, set by onboarding wizard)    |
| `apiKey`              | string  | user   | OpenAI API key (secret, supports env var `OPENAI_API_KEY`) |
| `model`               | string  | global | Model for generation (default: `gpt-6.1-sol`)              |
| `unsafeBypassSandbox` | boolean | hidden | Bypass Codex sandboxing on incompatible hosts              |

### Supported Models

Model list as of 2026-11-05 — source: [Codex models](https://learn.chatgpt.com/docs/models) and the
[OpenAI models page](https://developers.openai.com/api/docs/models). Availability depends on your account, plan and
region (ChatGPT sign-in follows your plan; API-key sessions follow your OpenAI organization and project); the picker
also accepts a custom model id and keeps existing saved selections.

| Model id        | Notes                                                                      |
| --------------- | -------------------------------------------------------------------------- |
| `gpt-6-astra`   | Flagship                                                                   |
| `gpt-6.1-sol`   | **Default** (Codex's own default since CLI 0.161.0)                        |
| `gpt-6.1-terra` | Lower cost                                                                 |
| `gpt-6-luna`    | Cost-sensitive, high volume                                                |
| `gpt-5.4`       | Legacy: still served by the API, not offered with ChatGPT sign-in any more |

All of them have a 1,050,000-token context and 128,000 output tokens. `codex-mini-latest` (retired 2026-02-12) and
`gpt-5.2-codex` (retired 2026-07-23) are no longer listed. A config that saved one is still accepted and the id is
passed through unchanged; OpenAI rejects retired ids at run time.

**Default change (2026-11-05):** the default moved from `gpt-5.4` to `gpt-6.1-sol`. A config that never saved a model
now runs on `gpt-6.1-sol`; there is no backfill, because Ever Works has no real users yet. Saved models are not
changed. GPT-6.1 Sol lists at $2 / $10 per million input / output tokens, below GPT-5.4's $2.50 / $15.

## Form Schema

The plugin provides a user-facing form with two configurable fields:

| Field                 | Type    | Default | Validation | Description                            |
| --------------------- | ------- | ------- | ---------- | -------------------------------------- |
| `target_items`        | number  | 50      | 1-500      | Target number of new items to generate |
| `capture_screenshots` | boolean | false   | -          | Take screenshots for generated items   |

## Prompt System

Prompts are managed through a prompt facade (e.g., Langfuse). When no external prompt is found, hardcoded defaults are used as fallback.

Prompt keys:

- `codex.system` - System prompt template
- `codex.user` - User prompt template

Both support variable substitution for work context, existing items, categories, tags, and brands.

## Binary Management

The plugin automatically downloads and caches the Codex CLI binary:

- Each CLI version is installed into its own directory, `/tmp/codex-generator/bin/codex-<version>-<platform>/`, with the
  binary at `codex` inside it
- Supports Linux (x64/arm64) and macOS (x64/arm64). On Linux the plugin always downloads the static musl build:
  openai/codex has published no `*-unknown-linux-gnu` assets since 0.128.0, and the musl binary also runs on glibc.
- Falls back to a system-installed `codex` command if download fails
- Default CLI version: `0.166.0` ([`rust-v0.166.0`](https://github.com/openai/codex/releases/tag/rust-v0.166.0),
  latest stable on 2026-10-29; was `0.120.0` before 2026-11-05)
- Sandboxed runs use `codex exec --sandbox workspace-write`. `--full-auto` was removed from `codex exec` in 0.147.0.
- **Bubblewrap (Linux):** since `rust-v0.129.0` the Linux binary no longer compiles bubblewrap in. Its sandbox runs a
  `bwrap` from `PATH`, or else the bundled `codex-resources/bwrap` next to the executable, and panics with
  "bubblewrap is unavailable" when neither exists. The plugin therefore also downloads the release's
  `bwrap-<target>.tar.gz`, verifies its published sha256 (fail closed, like the Codex archive) and installs it as
  `codex-<version>-<platform>/codex-resources/bwrap`. Each version keeps its own copy, because codex checks bwrap
  against the sha256 it was built with. Hosts with a system `bwrap` (for example `apk add bubblewrap`) work either way.
  Bubblewrap needs unprivileged user namespaces; where the container forbids them, Codex sandboxing cannot work and
  `unsafeBypassSandbox` is the operator's explicit choice.

## Error Handling

- **Non-zero exit codes**: Treated as soft warnings. If items were still produced, the result succeeds with warnings attached.
- **Sandbox write blocks**: Detected and logged, but **never** retried with sandbox bypass on their own. The detector reads Codex's stdout/stderr, which is model-produced text that injected content (a fetched page, a README) can steer, so it cannot be allowed to escalate a run to `--dangerously-bypass-approvals-and-sandbox`. Bypass happens only when the operator explicitly enables `unsafeBypassSandbox` (then every run starts bypassed). See [Sandbox bypass](#sandbox-bypass).
- **Structured output recovery**: If Codex completes without writing item files, the plugin attempts a second pass using `--output-schema` and `--output-last-message` to recover structured output.
- **Masked secrets**: The `getRealSecret` helper filters out UI placeholder values (`••••`) before using credentials.

## Project Structure

```
src/
  codex.plugin.ts          # Main plugin class (IPlugin, IPipelinePlugin, IFormSchemaProvider, ILocalAuthProvider)
  types.ts                 # Step IDs, constants
  steps.ts                 # Pipeline step definitions
  form-schema.ts           # Form fields, groups, validation
  prompt-keys.ts           # Prompt facade keys
  device-auth.ts            # Device auth flow (codex login --device-auth)
  index.ts                 # Public exports
  prompt/
    system-prompt.ts       # Default prompts and variable builders
  utils/
    binary-manager.ts      # CLI binary download and caching
    pipeline-helpers.ts    # State management, auth resolution, progress reporting
    process-runner.ts      # Codex CLI subprocess execution
    workspace-manager.ts   # Workspace I/O (create, seed, read, cleanup)
    screenshot-capture.ts  # Screenshot facade integration
    taxonomy-sync.ts       # Merge new categories/tags/brands into _meta files
    taxonomy-watcher.ts    # Filesystem watcher for live taxonomy sync
    platform.ts            # Platform detection helpers
    subprocess-env.ts      # Environment variable setup for subprocesses
scripts/
  smoke-codex.mjs          # Manual smoke test script
```

## Development

```bash
# Build
pnpm build

# Type-check
pnpm type-check

# Run tests
pnpm test

# Watch mode
pnpm test:watch

# Coverage
pnpm test:coverage
```

## Sandbox bypass

Codex runs inside its own sandbox unless told otherwise. Two paths can run it with
`--dangerously-bypass-approvals-and-sandbox` (full host access, no approvals):

- **Generation pipeline** — only when the operator sets `unsafeBypassSandbox: true` (hidden setting, default
  `false`). The plugin no longer escalates on its own when Codex's output _says_ writes were blocked: that output
  is model text, and a prompt-injected model could print exactly those phrases. A declined escalation is logged as
  a warning; structured-output recovery still runs, sandboxed.
- **Code-edit path** (`executeCodeEdit`) — **always** passes the bypass flag today. It edits a workspace the
  platform provisioned for the run and needs unrestricted writes there. Treat any host running code-edit as giving
  the Codex process the plugin's own OS privileges: run it in a container/VM with no credentials or networks it
  should not reach. This behaviour is unchanged and documented here so it is a known, reviewed trade-off.

## Smoke Test

Validate real Codex CLI integration locally:

```bash
pnpm smoke
```

For hosts requiring sandbox bypass:

```bash
CODEX_SMOKE_BYPASS_SANDBOX=1 pnpm smoke
```

Requires either `OPENAI_API_KEY` in the environment or local Codex auth (`codex login`).

## Troubleshooting

| Symptom                                                           | Likely cause                                                                                                                                   | Fix                                                                                                                                                                           |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generation never starts / stays at `0%`                           | `codex` not selected as the active pipeline plugin for this work                                                                               | Open the work → **Plugins** → `pipeline` capability and set `codex` as the active pipeline; or set it as the global pipeline default in **Settings → Plugins**                |
| Step fails with `No AI / search / screenshot provider configured` | Pipeline depends on capability plugins that are not enabled or have no credentials                                                             | Enable and configure the matching capability plugin (AI provider, search, screenshot, content-extractor) for the work or globally                                             |
| Step output looks wrong / generic                                 | Form-field tuning not set; pipeline using defaults that don't match the work's domain                                                          | Open the **Generator Form** for the work, set domain-specific fields (categories, target keywords, source URLs), and re-run the affected step                                 |
| Subprocess error: `command not found`                             | `Codex Generator` CLI not installed on the host running the API                                                                                | Install the Codex Generator CLI on the API host and ensure it is on `PATH`; verify by running `which <cli>` from the same shell that launches `pnpm dev:api`                  |
| Authentication / device-auth flow stalls                          | Device-auth code never confirmed in the upstream IDE / browser                                                                                 | Re-run the device-auth flow from **Settings → Plugins → codex → Connect**, then complete the prompt in the upstream service before the code expires                           |
| Run warns "bubblewrap is unavailable"                             | Linux host with no system `bwrap` and no bundled `codex-resources/bwrap` next to the Codex binary (e.g. a binary installed outside the plugin) | Let the plugin reinstall its managed CLI (it downloads the verified bwrap), or install bubblewrap on the host. Enable `unsafeBypassSandbox` only where sandboxing cannot work |
| Pipeline cannot resume after host restart                         | Checkpoint not persisted (only the standard pipeline persists checkpoints today)                                                               | Cancel the stuck run and re-trigger generation; for production reliability prefer `standard-pipeline`                                                                         |

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-co/ever-works)
- [Plugin system](../../plugin/README.md)
- [Codex CLI homepage](https://github.com/openai/codex)
- [OpenAI API keys](https://platform.openai.com/account/api-keys)

## License

AGPL-3.0
