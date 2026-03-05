# Ever Works MCP Server

An MCP (Model Context Protocol) server that exposes the Ever Works API as AI-consumable tools. Connect it to Claude Desktop, Claude Code, or any MCP-compatible client to manage directories, generate content, deploy websites, and configure plugins programmatically.

## Prerequisites

- Node.js >= 20
- An Ever Works API key (generate one at **Settings > API Keys** in the dashboard)

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `EVER_WORKS_API_KEY` | Yes | — | API key for authentication |
| `EVER_WORKS_API_URL` | No | `http://localhost:3100` | Base URL of the Ever Works API |
| `EVER_WORKS_MCP_PORT` | No | `3200` | Port for HTTP transport |

## Claude Desktop Configuration

Add to your Claude Desktop `claude_desktop_config.json`:

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

## Development

```bash
# Install dependencies (from repo root)
pnpm install

# Build
pnpm build --filter=ever-works-mcp

# Run with stdio transport (primary — for Claude Desktop)
EVER_WORKS_API_KEY=ew_live_... pnpm --filter=ever-works-mcp start:stdio

# Run with HTTP transport (secondary — for remote access)
EVER_WORKS_API_KEY=ew_live_... pnpm --filter=ever-works-mcp start:http

# Type check
cd apps/mcp && pnpm type-check

# Interactive debugging with MCP Inspector
EVER_WORKS_API_KEY=ew_live_... npx @modelcontextprotocol/inspector node apps/mcp/dist/stdio.js
```

## Available Tools (24)

### Directories (9)
| Tool | Description |
|------|-------------|
| `list_directories` | List all directories with pagination and search |
| `get_directory` | Get full details for a directory |
| `create_directory` | Create a new directory |
| `update_directory` | Update directory settings |
| `delete_directory` | Delete a directory and optionally its repos |
| `get_directory_config` | Get directory configuration and metadata |
| `get_directory_items` | Get all items in a directory |
| `get_categories_tags` | Get categories and tags for a directory |
| `get_directory_history` | Get generation/update history |

### Generation (4)
| Tool | Description |
|------|-------------|
| `generate_items` | Start AI-powered item generation |
| `update_items` | Update existing items using AI |
| `generate_directory_details` | AI-generate directory name, description, categories |
| `get_generator_form` | Get the dynamic generator form schema |

### Items (4)
| Tool | Description |
|------|-------------|
| `submit_item` | Add a single item to a directory |
| `remove_item` | Remove an item from a directory |
| `update_item` | Update item metadata (featured, order) |
| `extract_item_details` | Extract item details from a URL using AI |

### Deploy (4)
| Tool | Description |
|------|-------------|
| `deploy_directory` | Deploy a directory's website |
| `list_domains` | List domains for a deployed directory |
| `list_deploy_providers` | List available deploy providers |
| `check_deploy_capability` | Check if a directory can be deployed |

### Plugins (5)
| Tool | Description |
|------|-------------|
| `list_plugins` | List available plugins (optionally by category) |
| `get_plugin` | Get plugin details and settings schema |
| `enable_plugin` | Enable a plugin with optional settings |
| `disable_plugin` | Disable a plugin |
| `update_plugin_settings` | Update settings for an enabled plugin |
