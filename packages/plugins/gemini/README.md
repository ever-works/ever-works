# @ever-works/gemini-plugin

Full pipeline plugin that delegates work generation to the [Gemini CLI](https://github.com/google-gemini/gemini-cli). A single Gemini CLI session autonomously handles web search, content creation, and file generation inside a temporary workspace.

> **Note:** This is the Gemini **CLI** pipeline. For the Gemini **AI provider** (chat completions / embeddings via the Generative Language API), see [`@ever-works/google-plugin`](../google/README.md).

## Plugin metadata

| Field        | Value                              |
| ------------ | ---------------------------------- |
| ID           | `gemini`                           |
| Category     | `pipeline`                         |
| Capabilities | `pipeline`, `form-schema-provider` |
| Author       | Ever Works Team                    |
| License      | AGPL-3.0                           |
| Built-in     | yes                                |
| Auto-enable  | no                                 |

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

Provide a Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey) in plugin settings (`apiKey` field).

This plugin does not reuse host machine Gemini CLI login state from `~/.gemini/`.
Credentials must come from Ever Works user settings so each user keeps isolated auth.
The runtime also uses an isolated per-user Gemini home/config work instead of the machine user's home.

## Settings

| Setting   | Type   | Scope  | Description                                                       |
| --------- | ------ | ------ | ----------------------------------------------------------------- |
| `apiKey`  | string | user   | Gemini API key (secret, supports env var `PLUGIN_GEMINI_API_KEY`) |
| `model`   | string | global | Model for generation (default: `gemini-3.8-flash`)                |
| `version` | string | hidden | Gemini CLI version to install (default: `0.67.0`)                 |

### Supported Models

Model list as of 2026-11-05 — source: [Gemini API models](https://aistudio.google.com/docs/models) and
[deprecations](https://aistudio.google.com/docs/deprecations). Availability depends on your account, plan and region;
the picker also accepts a custom model id and keeps existing saved selections.

| Model id                 | Notes                                                                           |
| ------------------------ | ------------------------------------------------------------------------------- |
| `gemini-4-argon`         | Flagship. The Gemini CLI README says the CLI is not optimized for Gemini 4+ yet |
| `gemini-3.8-flash`       | **Default.** Most intelligent Flash                                             |
| `gemini-3.6-flash`       | Previous Flash release                                                          |
| `gemini-3.5-flash-lite`  | Fastest, most cost-effective                                                    |
| `gemini-3.1-pro-preview` | Preview                                                                         |
| `gemini-3-flash-preview` | Preview                                                                         |
| `gemini-2.5-pro`         | Legacy: deprecated 2026-11-02, existing users only, re-routed from 2026-12-01   |
| `gemini-2.5-flash`       | Legacy: deprecated 2026-11-02, existing users only, re-routed from 2026-12-01   |
| `gemini-2.5-flash-lite`  | Legacy: past users only                                                         |

Every listed model takes 1,048,576 input and 65,536 output tokens. `gemini-3.1-flash-lite-preview` shut down on
2026-05-25 and is no longer listed; a config that saved it keeps it as a custom id. Gemini 2.0 Flash shut down on
2026-06-01.

**Default change (2026-11-05):** the default moved from `gemini-2.5-flash` to `gemini-3.8-flash`. A config that never
saved a model now runs on `gemini-3.8-flash`; there is no backfill, because Ever Works has no real users yet. Saved
models are not changed.

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

Both support variable substitution for work context, existing items, categories, tags, and brands.

## Binary Management

The plugin runs Gemini CLI through `npx`:

- Uses `npx --yes @google/gemini-cli@<version>`
- Supports version pinning through `@google/gemini-cli@<version>`; `latest` is an explicit opt-in
- Default version: `0.67.0` (pinned 2026-11-05; was `0.45.2`, which rewrote any model id ending in "flash" to its own
  default — [google-gemini/gemini-cli#28859](https://github.com/google-gemini/gemini-cli/issues/28859), fixed in
  0.61.0)
- Runs non-interactively with `--approval-mode yolo` inside Gemini's own `--sandbox`

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

## Troubleshooting

| Symptom                                                           | Likely cause                                                                          | Fix                                                                                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generation never starts / stays at `0%`                           | `gemini` not selected as the active pipeline plugin for this work                     | Open the work → **Plugins** → `pipeline` capability and set `gemini` as the active pipeline; or set it as the global pipeline default in **Settings → Plugins** |
| Step fails with `No AI / search / screenshot provider configured` | Pipeline depends on capability plugins that are not enabled or have no credentials    | Enable and configure the matching capability plugin (AI provider, search, screenshot, content-extractor) for the work or globally                               |
| Step output looks wrong / generic                                 | Form-field tuning not set; pipeline using defaults that don't match the work's domain | Open the **Generator Form** for the work, set domain-specific fields (categories, target keywords, source URLs), and re-run the affected step                   |
| Subprocess error: `command not found`                             | `Gemini Generator` CLI not installed on the host running the API                      | Install the Gemini Generator CLI on the API host and ensure it is on `PATH`; verify by running `which <cli>` from the same shell that launches `pnpm dev:api`   |
| Authentication / device-auth flow stalls                          | Device-auth code never confirmed in the upstream IDE / browser                        | Re-run the device-auth flow from **Settings → Plugins → gemini → Connect**, then complete the prompt in the upstream service before the code expires            |
| Pipeline cannot resume after host restart                         | Checkpoint not persisted (only the standard pipeline persists checkpoints today)      | Cancel the stuck run and re-trigger generation; for production reliability prefer `standard-pipeline`                                                           |

## Documentation

- [Ever Works documentation](https://docs.ever.works)
- [Ever Works repository](https://github.com/ever-co/ever-works)
- [Plugin system](../../plugin/README.md)
- [Gemini CLI homepage](https://github.com/google-gemini/gemini-cli)
- [Google AI Studio (API keys)](https://aistudio.google.com/apikey)

## License

AGPL-3.0
