---
id: mcp-server
title: MCP Server
sidebar_label: MCP Server
sidebar_position: 13
---

# MCP Server

The Ever Works MCP (Model Context Protocol) server exposes the Ever Works API as tools that AI assistants like Claude can call directly. This enables natural-language management of directories — creating directories, generating items, deploying websites, and more — all through conversation.

:::tip When to use this
Connect the MCP server to Claude Desktop, Claude Code, or any MCP-compatible client to manage your Ever Works directories through AI-powered conversation instead of manual API calls.
:::

## Prerequisites

- A running Ever Works API instance
- An [API key](./api-keys) for authentication
- Node.js 20 or later

## Architecture

The MCP server is a standalone NestJS application in `apps/mcp/` that:

1. **Fetches** the Ever Works API's OpenAPI spec at startup
2. **Filters** endpoints through a curated whitelist of 36 operations
3. **Converts** OpenAPI schemas to MCP tool definitions automatically
4. **Proxies** tool calls to the API using your API key

This means tool descriptions, parameter names, types, and validation rules are always in sync with the API — no manual tool definitions to maintain.

## Setup

### Environment Variables

| Variable              | Required | Default                 | Description                             |
| --------------------- | -------- | ----------------------- | --------------------------------------- |
| `EVER_WORKS_API_KEY`  | Yes      | —                       | API key for authentication              |
| `EVER_WORKS_API_URL`  | No       | `http://localhost:3100` | Base URL of the Ever Works API          |
| `EVER_WORKS_MCP_PORT` | No       | `3200`                  | Port for HTTP transport mode            |
| `MCP_TRANSPORT`       | No       | `stdio`                 | Transport: `stdio` or `streamable-http` |

### Build

```bash
pnpm build --filter=ever-works-mcp
```

### Running

**Stdio mode** (for Claude Desktop and Claude Code):

```bash
EVER_WORKS_API_KEY=ew_live_... pnpm --filter=ever-works-mcp start:stdio
```

**HTTP mode** (for remote clients):

```bash
EVER_WORKS_API_KEY=ew_live_... pnpm --filter=ever-works-mcp start:http
```

In HTTP mode, all requests to the `/mcp` endpoint require an `Authorization: Bearer <API_KEY>` header.

## Claude Desktop Integration

Add the following to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Linux**: `~/.config/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
	"mcpServers": {
		"ever-works": {
			"command": "node",
			"args": ["<path-to-repo>/apps/mcp/dist/stdio.js"],
			"env": {
				"EVER_WORKS_API_URL": "http://localhost:3100",
				"EVER_WORKS_API_KEY": "ew_live_your_key_here"
			}
		}
	}
}
```

## Claude Code Integration

Add the MCP server to your project's `.mcp.json`:

```json
{
	"mcpServers": {
		"ever-works": {
			"command": "node",
			"args": ["<path-to-repo>/apps/mcp/dist/stdio.js"],
			"env": {
				"EVER_WORKS_API_URL": "http://localhost:3100",
				"EVER_WORKS_API_KEY": "ew_live_your_key_here"
			}
		}
	}
}
```

## Available Tools

The MCP server exposes 36 tools organized by domain. Each tool's parameters and descriptions are auto-generated from the API's OpenAPI specification.

### Directories (12 tools)

| Tool                    | Description                                 |
| ----------------------- | ------------------------------------------- |
| `list_directories`      | List all directories accessible to the user |
| `create_directory`      | Create a new directory                      |
| `get_directory`         | Get a specific directory by ID              |
| `update_directory`      | Update directory settings and configuration |
| `delete_directory`      | Delete a directory and its repositories     |
| `get_directory_config`  | Get directory configuration and metadata    |
| `get_directory_items`   | Get all items in a directory                |
| `get_categories_tags`   | Get categories and tags for a directory     |
| `get_directory_history` | Get generation history                      |
| `regenerate_markdown`   | Regenerate markdown files for all items     |
| `update_website`        | Trigger a website rebuild                   |
| `process_community_prs` | Process community pull requests             |

### Generation (4 tools)

| Tool                         | Description                                 |
| ---------------------------- | ------------------------------------------- |
| `generate_items`             | Start AI-powered item generation            |
| `update_items`               | Update existing items using AI              |
| `generate_directory_details` | AI-generate directory details from a prompt |
| `get_generator_form`         | Get the dynamic generator form schema       |

### Items (4 tools)

| Tool                   | Description                              |
| ---------------------- | ---------------------------------------- |
| `submit_item`          | Add a single item to a directory         |
| `remove_item`          | Remove an item from a directory          |
| `update_item`          | Update item metadata (featured, order)   |
| `extract_item_details` | Extract item details from a URL using AI |

### Deployment (4 tools)

| Tool                      | Description                              |
| ------------------------- | ---------------------------------------- |
| `deploy_directory`        | Deploy a directory to a hosting provider |
| `list_domains`            | List custom domains for a directory      |
| `list_deploy_providers`   | List available deployment providers      |
| `check_deploy_capability` | Check if deployment is available         |

### Plugins (5 tools)

| Tool                     | Description                     |
| ------------------------ | ------------------------------- |
| `list_plugins`           | List all available plugins      |
| `get_plugin`             | Get plugin details and settings |
| `enable_plugin`          | Enable a plugin for the user    |
| `disable_plugin`         | Disable a plugin                |
| `update_plugin_settings` | Update plugin configuration     |

### Scheduling (4 tools)

| Tool                   | Description                               |
| ---------------------- | ----------------------------------------- |
| `get_schedule`         | Get scheduled update configuration        |
| `update_schedule`      | Update schedule (cadence, enable/disable) |
| `cancel_schedule`      | Cancel scheduled updates                  |
| `run_scheduled_update` | Manually trigger a scheduled update       |

### Comparisons (5 tools)

| Tool                         | Description                                |
| ---------------------------- | ------------------------------------------ |
| `list_comparisons`           | List all comparisons for a directory       |
| `get_comparison`             | Get a comparison with markdown content     |
| `generate_comparison`        | Auto-generate the next comparison          |
| `generate_manual_comparison` | Generate comparison for two specific items |
| `delete_comparison`          | Delete a comparison                        |

## Adding New Tools

To expose a new API endpoint as an MCP tool:

1. **Add Swagger decorators** to the API endpoint — `@ApiOperation`, `@ApiParam`, `@ApiResponse`, and `@ApiProperty` on the DTO fields
2. **Add a whitelist entry** in `apps/mcp/src/openapi-tools/whitelist.ts`:

```typescript
{
  method: 'POST',
  path: '/api/your-endpoint',
  toolName: 'your_tool_name',
  annotations: { readOnlyHint: false }
}
```

3. **Rebuild** and restart the MCP server

The tool's description, parameters, and validation are derived automatically from the OpenAPI spec.

## Security

- **Response sanitization** — sensitive fields (passwords, API keys, tokens, secrets) are automatically stripped from all API responses before being returned to the AI client
- **API key authentication** — all requests are authenticated with your Ever Works API key
- **Whitelist filtering** — only explicitly allowed endpoints are exposed as tools
- **Request timeout** — API calls time out after 2 minutes

## Related

- [API Keys](./api-keys) — Generate API keys for MCP server authentication
- [Authentication](/api/authentication) — Full API authentication reference
- [Plugin System](/plugin-system/) — Plugins that power generation, search, and deployment
