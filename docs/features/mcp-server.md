---
id: mcp-server
title: MCP Server
sidebar_label: MCP Server
sidebar_position: 13
---

# MCP Server

The Ever Works MCP (Model Context Protocol) server exposes the Ever Works API as tools that AI assistants like Claude can call directly. This enables natural-language management of works — creating works, generating items, deploying websites, and more — all through conversation.

:::tip When to use this
Connect the MCP server to Claude Desktop, Claude Code, or any MCP-compatible client to manage your Ever Works works through AI-powered conversation instead of manual API calls.
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

### Works (12 tools)

| Tool                    | Description                             |
| ----------------------- | --------------------------------------- |
| `list_works`            | List all works accessible to the user   |
| `create_work`           | Create a new work                       |
| `get_work`              | Get a specific work by ID               |
| `update_work`           | Update work settings and configuration  |
| `delete_work`           | Delete a work and its repositories      |
| `get_work_config`       | Get work configuration and metadata     |
| `get_work_items`        | Get all items in a work                 |
| `get_categories_tags`   | Get categories and tags for a work      |
| `get_work_history`      | Get generation history                  |
| `regenerate_markdown`   | Regenerate markdown files for all items |
| `update_website`        | Trigger a website rebuild               |
| `process_community_prs` | Process community pull requests         |

### Generation (4 tools)

| Tool                    | Description                            |
| ----------------------- | -------------------------------------- |
| `generate_items`        | Start AI-powered item generation       |
| `update_items`          | Update existing items using AI         |
| `generate_work_details` | AI-generate work details from a prompt |
| `get_generator_form`    | Get the dynamic generator form schema  |

### Items (4 tools)

| Tool                   | Description                              |
| ---------------------- | ---------------------------------------- |
| `submit_item`          | Add a single item to a work              |
| `remove_item`          | Remove an item from a work               |
| `update_item`          | Update item metadata (featured, order)   |
| `extract_item_details` | Extract item details from a URL using AI |

### Deployment (4 tools)

| Tool                      | Description                         |
| ------------------------- | ----------------------------------- |
| `deploy_work`             | Deploy a work to a hosting provider |
| `list_domains`            | List custom domains for a work      |
| `list_deploy_providers`   | List available deployment providers |
| `check_deploy_capability` | Check if deployment is available    |

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
| `list_comparisons`           | List all comparisons for a work            |
| `get_comparison`             | Get a comparison with markdown content     |
| `generate_comparison`        | Auto-generate the next comparison          |
| `generate_manual_comparison` | Generate comparison for two specific items |
| `delete_comparison`          | Delete a comparison                        |

### Tasks (24 tools)

Tasks are units of work an Agent executes (on the cloud runtime or on one of the owner's Fleet nodes); the Task's PR, diff, chat and spend are readable here.

| Tool                      | Description                                                      |
| ------------------------- | ---------------------------------------------------------------- |
| `list_tasks`              | List my Tasks (filter by status, priority, scope, label, search) |
| `create_task`             | Create a Task                                                    |
| `get_task`                | Get one Task                                                     |
| `update_task`             | Update Task fields (partial)                                     |
| `delete_task`             | Delete a Task                                                    |
| `list_task_subtasks`      | Subtasks of a Task                                               |
| `get_task_activity`       | Activity rows (created / updated / transitioned / dispatched)    |
| `transition_task`         | Move a Task between statuses                                     |
| `get_task_run_candidates` | Agents that could run this Task                                  |
| `run_task`                | Dispatch a run of the Task to an Agent                           |
| `run_tasks_batch`         | Dispatch several Tasks at once                                   |
| `get_task_pr_status`      | Pull-request status of the Task's branch                         |
| `get_task_diff`           | Diff of the Task's branch (capped)                               |
| `discard_task_branch`     | Throw away the Task's pushed branch (irreversible)               |
| `reject_task`             | Reject the Task's result with feedback                           |
| `assign_task`             | Add an assignee                                                  |
| `add_task_reviewer`       | Add a reviewer                                                   |
| `add_task_approver`       | Add an approver                                                  |
| `add_task_relation`       | Relate two Tasks (blocks, duplicates, ...)                       |
| `list_task_escalations`   | Escalations raised on the Task                                   |
| `resolve_task_escalation` | Resolve one escalation                                           |
| `get_task_chat`           | Paginated chat thread                                            |
| `post_task_chat_message`  | Post a chat message on the Task                                  |
| `get_task_spend`          | Per-Task spend rollup                                            |

### Inbox (8 tools)

The Inbox is where agents ask humans for decisions and approvals; `reply_inbox_item` is how an answer or approval is given.

| Tool                     | Description                                 |
| ------------------------ | ------------------------------------------- |
| `list_inbox`             | List Inbox items (active view by default)   |
| `get_inbox_unread_count` | Unread count                                |
| `get_inbox_item`         | Get one item with its question and options  |
| `reply_inbox_item`       | Answer a question or pick an offered option |
| `mark_inbox_item_read`   | Mark read (or unread again)                 |
| `archive_inbox_item`     | Archive an item                             |
| `unarchive_inbox_item`   | Bring an archived item back                 |
| `delete_inbox_item`      | Delete an item                              |

### Goals (11 tools)

Goals are outcome-driven autopilot: the platform observes a metric and dispatches Tasks toward a definition of done.

| Tool                 | Description                                             |
| -------------------- | ------------------------------------------------------- |
| `list_goals`         | List my Goals                                           |
| `create_goal`        | Create a Goal                                           |
| `get_goal`           | Get one Goal                                            |
| `update_goal`        | Update Goal fields (partial)                            |
| `get_goal_samples`   | Observation history (newest first)                      |
| `activate_goal`      | Activate a Goal                                         |
| `pause_goal`         | Pause a Goal                                            |
| `evaluate_goal_now`  | Evaluate the Goal immediately                           |
| `update_goal_limits` | Change the Goal's spend / iteration limits              |
| `propose_goal_dod`   | Ask the platform to propose definition-of-done criteria |
| `approve_goal_dod`   | Approve the proposed criteria                           |

### Fleet (8 tools)

The Fleet is the owner's own machines enrolled as nodes; node-facing routes (enroll, heartbeat, lease) and enrollment tokens are deliberately not exposed.

| Tool                              | Description                                                    |
| --------------------------------- | -------------------------------------------------------------- |
| `list_fleet_nodes`                | List enrolled nodes with status and capabilities               |
| `get_fleet_node`                  | One node with its recent jobs                                  |
| `get_fleet_runner_status`         | Is a runner available right now                                |
| `get_fleet_execution_preferences` | Where each job kind runs (local-wait / local-fallback / cloud) |
| `get_agent_node_affinity`         | Which node an Agent is pinned to                               |
| `set_agent_node_affinity`         | Pin an Agent to a node                                         |
| `clear_agent_node_affinity`       | Remove the pin                                                 |
| `drain_fleet_node`                | Drain a node (finish in-flight work, take no more)             |

### Agents (9 tools)

Agents are the workers; runs are their executions.

| Tool               | Description                    |
| ------------------ | ------------------------------ |
| `list_agents`      | List my Agents                 |
| `get_agent`        | Get one Agent                  |
| `list_agent_runs`  | Run history of an Agent        |
| `get_agent_run`    | One run with its step logs     |
| `run_agent_now`    | Start a run immediately        |
| `cancel_agent_run` | Cancel a queued or running run |
| `pause_agent`      | Pause an Agent                 |
| `resume_agent`     | Resume a paused Agent          |
| `get_agent_budget` | Budget and spend of an Agent   |

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
