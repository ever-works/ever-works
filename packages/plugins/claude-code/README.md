# Claude Code Generator Plugin

Full pipeline plugin that delegates the entire directory generation to Claude Code. Instead of orchestrating 15 separate pipeline steps with multiple AI API calls, this plugin runs a single Claude Code session that autonomously handles web search, content creation, and file generation.

## How it works

The plugin runs 5 sequential steps:

1. **Setup Claude Code** - Downloads and caches the Claude Code CLI binary
2. **Prepare Context** - Creates a temporary workspace and seeds it with existing items and metadata
3. **Generate Items** - Executes Claude Code CLI to research and generate directory items as JSON files
4. **Collect Results** - Reads the generated JSON files back to build the pipeline result
5. **Cleanup** - Removes the temporary workspace

## Settings

| Setting        | Required     | Description                       |
| -------------- | ------------ | --------------------------------- |
| `oauthToken`   | One of these | Claude Code OAuth token           |
| `apiKey`       | is required  | Anthropic API key                 |
| `version`      | No           | CLI version (default: `2.1.37`)   |
| `maxTurns`     | No           | Max agentic turns (default: `20`) |
| `maxBudgetUsd` | No           | Max budget per generation in USD  |

### Authentication

At least one of `oauthToken` or `apiKey` must be provided. OAuth token takes precedence.

**OAuth Token** (recommended):

```bash
claude setup-token
```

**API Key**:
Get one from [console.anthropic.com](https://console.anthropic.com)

## Requirements

- Linux or macOS (Windows is not supported)
- Node.js 20+
- Network access to download the CLI binary and for Claude Code to perform web searches

## Usage

Enable the plugin for a directory and trigger generation with `providers.pipeline: 'claude-code'`.
