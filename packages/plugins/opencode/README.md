# @ever-works/opencode-plugin

Full pipeline plugin that delegates work generation to the [OpenCode CLI](https://github.com/sst/opencode). A single OpenCode CLI session autonomously handles web search, content creation, and file generation inside a temporary workspace while using the active Ever Works AI provider for model access.

## Plugin metadata

| Field        | Value                              |
| ------------ | ---------------------------------- |
| ID           | `opencode`                         |
| Category     | `pipeline`                         |
| Capabilities | `pipeline`, `form-schema-provider` |
| Author       | Ever Works Team                    |
| License      | MIT                                |
| Built-in     | yes                                |
| Auto-enable  | no                                 |

## Pipeline Steps

The plugin runs 6 sequential steps:

| #   | Step                    | Description                                                        | Optional |
| --- | ----------------------- | ------------------------------------------------------------------ | -------- |
| 1   | **Setup OpenCode**      | Downloads/caches the OpenCode CLI binary from GitHub               | No       |
| 2   | **Prepare Context**     | Creates a temp workspace, seeds existing items and metadata        | No       |
| 3   | **Generate Items**      | Executes OpenCode CLI to research and generate items as JSON files | No       |
| 4   | **Collect Results**     | Reads generated JSON files back into the pipeline result           | No       |
| 5   | **Capture Screenshots** | Takes screenshots for generated items (via screenshot provider)    | Yes      |
| 6   | **Cleanup**             | Removes the temporary workspace                                    | Yes      |

During step 3, a **taxonomy watcher** monitors the workspace for new item files and keeps `_meta/` taxonomy files (categories, tags, brands) in sync in real time. Progress is reported per item as files appear.

## AI Provider Integration

OpenCode does not ask the user to configure a separate provider, auth mode, or model inside this plugin.

Instead, it resolves the active Ever Works `ai-provider` for the current `{ userId, workId }` context and generates an isolated OpenCode config for the run:

- Provider base URL and API key come from `execContext.aiFacade.getProviderConfig(...)`
- Model selection comes from the AI provider routing config (`complexModel` first, then `defaultModel`)
- OpenCode runs with a user-scoped, isolated config work rather than machine-global auth state
- Web tools are explicitly enabled, including `websearch`

## Settings

| Setting   | Type   | Scope  | Description                                           |
| --------- | ------ | ------ | ----------------------------------------------------- |
| `version` | string | hidden | OpenCode CLI version to install (default: `v1.0.223`) |

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

Both support variable substitution for work context, existing items, categories, tags, and brands.

## Binary Management

The plugin downloads the OpenCode CLI binary from GitHub releases:

- Binaries are cached at `{tmpdir}/opencode-generator/bin/opencode-{version}-{platform}/`
- Platform detection: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`
- SHA-256 checksum verification when available
- Default version: `v1.0.223`

## Error Handling

- **Non-zero exit codes**: Treated as soft warnings. If items were still produced, the result succeeds with warnings attached.
- **Empty results**: If OpenCode completes without producing any valid item JSON files, an error is thrown with CLI output excerpts for debugging.
- **Missing AI provider config**: The pipeline fails early if the resolved Ever Works AI provider does not expose a base URL, API key, or runnable model.

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
    opencode-config.ts     # User-scoped OpenCode config generation and cleanup
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

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-works/ever-works)
- [Plugin system](../../plugin/README.md)
- [OpenCode CLI homepage](https://github.com/sst/opencode)

## License

MIT
