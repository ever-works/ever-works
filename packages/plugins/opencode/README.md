# @ever-works/opencode-plugin

Full pipeline plugin that delegates directory generation to the [OpenCode CLI](https://github.com/sst/opencode). A single OpenCode CLI session autonomously handles web search, content creation, and file generation inside a temporary workspace.

## Pipeline Steps

The plugin runs 6 sequential steps:

| #   | Step                    | Description                                                       | Optional |
| --- | ----------------------- | ----------------------------------------------------------------- | -------- |
| 1   | **Setup OpenCode**      | Downloads/caches the OpenCode CLI binary from GitHub               | No       |
| 2   | **Prepare Context**     | Creates a temp workspace, seeds existing items and metadata        | No       |
| 3   | **Generate Items**      | Executes OpenCode CLI to research and generate items as JSON files | No       |
| 4   | **Collect Results**     | Reads generated JSON files back into the pipeline result           | No       |
| 5   | **Capture Screenshots** | Takes screenshots for generated items (via screenshot provider)    | Yes      |
| 6   | **Cleanup**             | Removes the temporary workspace                                    | Yes      |

During step 3, a **taxonomy watcher** monitors the workspace for new item files and keeps `_meta/` taxonomy files (categories, tags, brands) in sync in real time. Progress is reported per item as files appear.

## Authentication

OpenCode CLI supports two authentication modes:

### Machine-Local (default)

Uses an existing local OpenCode login stored at `~/.local/share/opencode/auth.json` (or `$XDG_DATA_HOME/opencode/auth.json`). Authenticate manually:

```bash
opencode auth login
```

### API Key

Provide an OpenCode provider API key in plugin settings (`apiKey` field). The plugin writes an isolated auth file per session so machine-local credentials are unaffected.

The onboarding wizard provides a multi-step flow: choose auth mode, configure credentials, and verify the connection.

## Settings

| Setting    | Type   | Scope  | Description                                                          |
| ---------- | ------ | ------ | -------------------------------------------------------------------- |
| `authMode` | string | user   | `machine-local` or `api-key`                                        |
| `provider` | string | user   | OpenCode provider (`go` or `zen`)                                   |
| `apiKey`   | string | user   | Provider API key (secret, supports env var `PLUGIN_OPENCODE_API_KEY`) |
| `model`    | string | global | Model in `provider/model` form (default: `go/kimi-k2.5`)           |
| `version`  | string | hidden | OpenCode CLI version to install (default: `v1.0.223`)               |

### Supported Models

- **Go GLM-5.1** — 200k context
- **Go GLM-5** — 200k context
- **Go Kimi K2.5** (default) — 200k context
- **Go MiMo-V2-Pro** — 200k context
- **Go MiniMax M2.7** — 200k context
- **Go Qwen3.5 Plus** — 200k context

## Form Schema

The plugin provides a user-facing form with two configurable fields:

| Field                 | Type    | Default | Validation | Description                            |
| --------------------- | ------- | ------- | ---------- | -------------------------------------- |
| `target_items`        | number  | 50      | 1-500      | Target number of new items to generate |
| `capture_screenshots` | boolean | false   | -          | Take screenshots for generated items   |

## Prompt System

Prompts are managed through a prompt facade (e.g., Langfuse). When no external prompt is found, hardcoded defaults are used as fallback.

Prompt keys:

- `opencode.system` — System prompt template
- `opencode.user` — User prompt template

Both support variable substitution for directory context, existing items, categories, tags, and brands.

## Binary Management

The plugin downloads the OpenCode CLI binary from GitHub releases:

- Binaries are cached at `{tmpdir}/opencode-generator/bin/opencode-{version}-{platform}/`
- Platform detection: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`
- SHA-256 checksum verification when available
- Default version: `v1.0.223`

## Error Handling

- **Non-zero exit codes**: Treated as soft warnings. If items were still produced, the result succeeds with warnings attached.
- **Empty results**: If OpenCode completes without producing any valid item JSON files, an error is thrown with CLI output excerpts for debugging.
- **Masked secrets**: The `getRealSecret` helper filters out UI placeholder values before using credentials.

## Project Structure

```
src/
  opencode.plugin.ts       # Main plugin class (IPlugin, IPipelinePlugin, IFormSchemaProvider)
  types.ts                 # Step IDs, constants
  steps.ts                 # Pipeline step definitions
  form-schema.ts           # Form fields, groups, validation
  prompt-keys.ts           # Prompt facade keys
  index.ts                 # Public exports
  prompt/
    system-prompt.ts       # Default prompts and variable builders
  utils/
    binary-manager.ts      # CLI download from GitHub releases
    pipeline-helpers.ts    # State management, settings resolution, progress reporting
    process-runner.ts      # OpenCode CLI subprocess execution
    workspace-manager.ts   # Workspace I/O (create, seed, read, cleanup)
    screenshot-capture.ts  # Screenshot facade integration
    taxonomy-sync.ts       # Merge new categories/tags/brands into _meta files
    taxonomy-watcher.ts    # Filesystem watcher for live taxonomy sync
    platform.ts            # Platform/architecture detection
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
