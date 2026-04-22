# @ever-works/gemini-plugin

Full pipeline plugin that delegates directory generation to the [Gemini CLI](https://github.com/google-gemini/gemini-cli). A single Gemini CLI session autonomously handles web search, content creation, and file generation inside a temporary workspace.

## Pipeline Steps

The plugin runs 6 sequential steps:

| #   | Step                    | Description                                                      | Optional |
| --- | ----------------------- | ---------------------------------------------------------------- | -------- |
| 1   | **Setup Gemini CLI**    | Installs/caches the Gemini CLI via npm and resolves auth         | No       |
| 2   | **Prepare Context**     | Creates a temp workspace, seeds existing items and metadata      | No       |
| 3   | **Generate Items**      | Executes Gemini CLI to research and generate items as JSON files | No       |
| 4   | **Collect Results**     | Reads generated JSON files back into the pipeline result         | No       |
| 5   | **Capture Screenshots** | Takes screenshots for generated items (via screenshot provider)  | Yes      |
| 6   | **Cleanup**             | Removes the temporary workspace                                  | Yes      |

During step 3, a **taxonomy watcher** monitors the workspace for new item files and keeps `_meta/` taxonomy files (categories, tags, brands) in sync in real time. Progress is reported per item as files appear.

## Authentication

Gemini supports two authentication modes in Ever Works:

### API Key (default)

Provide a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) in plugin settings (`apiKey` field).

### Vertex AI

Use Google Cloud / Vertex AI environment-based authentication. Requires:

- `googleCloudProject` - Google Cloud project ID
- `googleCloudLocation` - Region (default: `us-central1`)
- `googleApiKey` (optional) - Google Cloud API key

The onboarding UI provides a 3-step flow: choose auth mode, configure credentials, and verify the connection.

This plugin does not reuse host machine Gemini CLI login state from `~/.gemini/`.
Credentials must come from Ever Works user settings so each user keeps isolated auth.

## Settings

| Setting               | Type    | Scope  | Description                                                       |
| --------------------- | ------- | ------ | ----------------------------------------------------------------- |
| `authMode`            | string  | user   | `api-key` or `vertex`                                             |
| `apiKey`              | string  | user   | Gemini API key (secret, supports env var `PLUGIN_GEMINI_API_KEY`) |
| `googleApiKey`        | string  | user   | Google Cloud API key for Vertex AI (secret, optional)             |
| `googleCloudProject`  | string  | user   | Google Cloud project ID for Vertex AI                             |
| `googleCloudLocation` | string  | user   | Google Cloud region for Vertex AI (default: `us-central1`)        |
| `model`               | string  | user   | Model for generation (default: `gemini-2.5-pro`)                  |
| `version`             | string  | hidden | Gemini CLI version to install (default: `latest`)                 |
| `maxTurns`            | integer | hidden | Maximum agentic turns (default: 500)                              |

### Supported Models

- **Gemini 2.5 Pro** (default) - 200k context
- **Gemini 2.5 Flash** - 200k context
- **Gemini 2.0 Flash** - 200k context

## Form Schema

The plugin provides a user-facing form with two configurable fields:

| Field                 | Type    | Default | Validation | Description                            |
| --------------------- | ------- | ------- | ---------- | -------------------------------------- |
| `target_items`        | number  | 50      | 1-500      | Target number of new items to generate |
| `capture_screenshots` | boolean | false   | -          | Take screenshots for generated items   |

## Prompt System

Prompts are managed through a prompt facade (e.g., Langfuse). When no external prompt is found, hardcoded defaults are used as fallback.

Prompt keys:

- `gemini.system` - System prompt template
- `gemini.user` - User prompt template

Both support variable substitution for directory context, existing items, categories, tags, and brands.

## Binary Management

The plugin installs the Gemini CLI via npm:

- Packages are cached at `{tmpdir}/gemini-generator/bin/gemini-{version}/`
- Uses `@google/gemini-cli` npm package
- Default version: `latest`

## Error Handling

- **Non-zero exit codes**: Treated as soft warnings. If items were still produced, the result succeeds with warnings attached.
- **Empty results**: If Gemini completes without producing any valid item JSON files, an error is thrown with CLI output excerpts for debugging.
- **Masked secrets**: The `getRealSecret` helper filters out UI placeholder values before using credentials.

## Project Structure

```
src/
  gemini.plugin.ts         # Main plugin class (IPlugin, IPipelinePlugin, IFormSchemaProvider)
  types.ts                 # Step IDs, constants
  steps.ts                 # Pipeline step definitions
  form-schema.ts           # Form fields, groups, validation
  prompt-keys.ts           # Prompt facade keys
  index.ts                 # Public exports
  prompt/
    system-prompt.ts       # Default prompts and variable builders
  utils/
    binary-manager.ts      # CLI installation via npm
    pipeline-helpers.ts    # State management, auth resolution, progress reporting
    process-runner.ts      # Gemini CLI subprocess execution
    workspace-manager.ts   # Workspace I/O (create, seed, read, cleanup)
    screenshot-capture.ts  # Screenshot facade integration
    taxonomy-sync.ts       # Merge new categories/tags/brands into _meta files
    taxonomy-watcher.ts    # Filesystem watcher for live taxonomy sync
    platform.ts            # Platform detection helpers
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
