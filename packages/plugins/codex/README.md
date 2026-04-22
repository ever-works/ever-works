# @ever-works/codex-plugin

Full pipeline plugin that delegates directory generation to the [Codex CLI](https://github.com/openai/codex). A single Codex session researches, creates, and updates directory item JSON files inside a temporary workspace.

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

The plugin materializes an isolated `CODEX_HOME` for each Ever Works user under its managed temp directory, so local Codex auth does not rely on a shared `~/.codex/auth.json`.

The onboarding UI provides a 3-step flow: choose auth mode, configure credentials, and verify the connection.

## Settings

| Setting               | Type    | Scope  | Description                                                |
| --------------------- | ------- | ------ | ---------------------------------------------------------- |
| `authMode`            | string  | user   | `api-key` or `local` (hidden, set by onboarding wizard)    |
| `apiKey`              | string  | user   | OpenAI API key (secret, supports env var `OPENAI_API_KEY`) |
| `model`               | string  | global | Model for generation (default: `gpt-5.4`)                  |
| `unsafeBypassSandbox` | boolean | hidden | Bypass Codex sandboxing on incompatible hosts              |

### Supported Models

- **GPT-5.4** (default) - 400k context
- **Codex Mini Latest** - 200k context
- **GPT-5.2 Codex** - 400k context

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

Both support variable substitution for directory context, existing items, categories, tags, and brands.

## Binary Management

The plugin automatically downloads and caches the Codex CLI binary:

- Binaries are cached in `/tmp/codex-generator/bin/`
- Supports Linux (x64/arm64) and macOS (x64/arm64)
- Falls back to a system-installed `codex` command if download fails
- Default CLI version: `0.120.0`

## Error Handling

- **Non-zero exit codes**: Treated as soft warnings. If items were still produced, the result succeeds with warnings attached.
- **Sandbox write blocks**: Automatically detected and retried once with sandbox bypass.
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
