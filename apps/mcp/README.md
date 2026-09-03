# Ever Works MCP Server

A NestJS-based MCP (Model Context Protocol) server that auto-generates tools from the Ever Works API's OpenAPI spec. Connect it to Claude Desktop, Claude Code, or any MCP-compatible client to manage works, generate content, deploy websites, and configure plugins programmatically.

## Architecture

Tools are dynamically generated at startup by fetching the OpenAPI spec from the Ever Works API and filtering endpoints against a whitelist. This means:

- **No manual tool definitions** — schemas come from the API's OpenAPI spec
- **Adding new tools** — just add a line to `src/openapi-tools/whitelist.ts`
- **Backwards compatible** — tool names match the previous hardcoded implementation

```
Startup -> fetch /api/openapi.json -> filter by whitelist -> convert schemas to Zod -> register tools
```

Built with [NestJS](https://nestjs.com/) and [@rekog/mcp-nest](https://github.com/rekog/mcp-nest).

## Prerequisites

- Node.js >= 20
- An Ever Works API key (generate one at **Settings > API Keys** in the dashboard)
- The Ever Works API running and accessible

## Environment Variables

| Variable                | Required | Default                 | Description                                                                           |
| ----------------------- | -------- | ----------------------- | ------------------------------------------------------------------------------------- |
| `EVER_WORKS_API_KEY`    | Yes      | --                      | API key for authentication                                                            |
| `EVER_WORKS_API_URL`    | No       | `http://localhost:3100` | Base URL of the Ever Works API                                                        |
| `EVER_WORKS_MCP_PORT`   | No       | `3200`                  | Port for HTTP transport                                                               |
| `EVER_WORKS_SCOPE_SLUG` | No       | -- (personal scope)     | Organization slug every tool call runs under, sent as `x-scope-slug` (or `@personal`) |

### Organization scope

Every whitelisted route is unprefixed, so without `EVER_WORKS_SCOPE_SLUG` each call runs in the caller's personal scope: lists show personal Tasks / Goals / Agents only, and the Organization-only tools (Fleet node affinity) answer `400`. Set the variable to an Organization slug to run under that Organization; the API resolves and authorises the slug exactly as it does for the web client, so it selects a scope the caller already has and cannot widen one. In HTTP mode the value applies to every caller of the server.

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

# Run with stdio transport (primary -- for Claude Desktop)
EVER_WORKS_API_KEY=ew_live_... pnpm --filter=ever-works-mcp start:stdio

# Run with HTTP transport (secondary -- for remote access)
EVER_WORKS_API_KEY=ew_live_... pnpm --filter=ever-works-mcp start:http

# Run tests
cd apps/mcp && pnpm test

# Type check
cd apps/mcp && pnpm type-check

# Lint
cd apps/mcp && pnpm lint

# Interactive debugging with MCP Inspector
EVER_WORKS_API_KEY=ew_live_... npx @modelcontextprotocol/inspector node apps/mcp/dist/stdio.js
```

## Available Tools (123)

The authoritative list is `src/openapi-tools/whitelist.ts`; the tables below cover the main domains, and `test/whitelist-tasks-inbox-goals-fleet.spec.ts` checks the counts here against it.

### Works (12)

| Tool                    | Description                               |
| ----------------------- | ----------------------------------------- |
| `list_works`            | List all works with pagination and search |
| `get_work`              | Get full details for a work               |
| `create_work`           | Create a new work                         |
| `update_work`           | Update work settings                      |
| `delete_work`           | Delete a work and optionally its repos    |
| `get_work_config`       | Get work configuration and metadata       |
| `get_work_items`        | Get all items in a work                   |
| `get_categories_tags`   | Get categories and tags for a work        |
| `get_work_history`      | Get generation/update history             |
| `regenerate_markdown`   | Regenerate markdown files for all items   |
| `update_website`        | Trigger a website rebuild and update      |
| `process_community_prs` | Process pending community pull requests   |

### Generation (4)

| Tool                    | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `generate_items`        | Start AI-powered item generation               |
| `update_items`          | Update existing items using AI                 |
| `generate_work_details` | AI-generate work name, description, categories |
| `get_generator_form`    | Get the dynamic generator form schema          |

### Items (4)

| Tool                   | Description                              |
| ---------------------- | ---------------------------------------- |
| `submit_item`          | Add a single item to a work              |
| `remove_item`          | Remove an item from a work               |
| `update_item`          | Update item metadata (featured, order)   |
| `extract_item_details` | Extract item details from a URL using AI |

### Deploy (4)

| Tool                      | Description                      |
| ------------------------- | -------------------------------- |
| `deploy_work`             | Deploy a work's website          |
| `list_domains`            | List domains for a deployed work |
| `list_deploy_providers`   | List available deploy providers  |
| `check_deploy_capability` | Check if a work can be deployed  |

### Plugins (5)

| Tool                     | Description                                     |
| ------------------------ | ----------------------------------------------- |
| `list_plugins`           | List available plugins (optionally by category) |
| `get_plugin`             | Get plugin details and settings schema          |
| `enable_plugin`          | Enable a plugin with optional settings          |
| `disable_plugin`         | Disable a plugin                                |
| `update_plugin_settings` | Update settings for an enabled plugin           |

### Scheduling (4)

| Tool                   | Description                                     |
| ---------------------- | ----------------------------------------------- |
| `get_schedule`         | Get scheduled update configuration              |
| `update_schedule`      | Update schedule (cadence, enable/disable, etc.) |
| `cancel_schedule`      | Cancel and remove scheduled updates             |
| `run_scheduled_update` | Manually trigger a scheduled update             |

### Comparisons (5)

| Tool                         | Description                                    |
| ---------------------------- | ---------------------------------------------- |
| `list_comparisons`           | List all comparisons for a work                |
| `get_comparison`             | Get a specific comparison by slug              |
| `generate_comparison`        | Auto-generate comparisons using AI             |
| `generate_manual_comparison` | Generate comparison between two specific items |
| `delete_comparison`          | Delete a comparison                            |

### Human-in-the-loop gates are not tools

The API cannot tell an MCP caller holding the owner's key from the owner. A tool that answered a gate would therefore let an Agent bound to this server approve its own proposal, resolve its own escalation or sign off its own definition of done. So the answering verbs are deliberately not exposed: `POST /api/inbox/{id}/reply`, `POST /api/tasks/{id}/escalations/{escalationId}/resolve`, `POST /api/me/goals/{id}/dod/approve`, and the `force` flag of `transition_task` (the approver-gate override). Asking stays: an agent can propose criteria, post to a Task's chat, list escalations and read the Inbox; a person answers in the app. For the same reason, never bind this server to an Agent with the owner's API key or JWT — that hands the Agent the owner's identity.

### Tasks (23)

Tasks are units of work an Agent executes (on the cloud runtime or on one of the owner's Fleet nodes); the Task's PR, diff, chat and spend are readable here.

| Tool                      | Description                                                          |
| ------------------------- | -------------------------------------------------------------------- |
| `list_tasks`              | List my Tasks (filter by status, priority, scope, label, search)     |
| `create_task`             | Create a Task                                                        |
| `get_task`                | Get one Task                                                         |
| `update_task`             | Update Task fields (partial)                                         |
| `delete_task`             | Delete a Task                                                        |
| `list_task_subtasks`      | Subtasks of a Task                                                   |
| `get_task_activity`       | Activity rows (created / updated / transitioned / dispatched)        |
| `transition_task`         | Move a Task between statuses (no `force`; the approver gate applies) |
| `get_task_run_candidates` | Agents that could run this Task                                      |
| `run_task`                | Dispatch a run of the Task to an Agent                               |
| `run_tasks_batch`         | Dispatch several Tasks at once                                       |
| `get_task_pr_status`      | Pull-request status of the Task's branch                             |
| `get_task_diff`           | Diff of the Task's branch (capped)                                   |
| `discard_task_branch`     | Throw away the Task's pushed branch (irreversible)                   |
| `reject_task`             | Reject the Task's result with feedback                               |
| `assign_task`             | Add an assignee                                                      |
| `add_task_reviewer`       | Add a reviewer                                                       |
| `add_task_approver`       | Add an approver                                                      |
| `add_task_relation`       | Relate two Tasks (related, duplicates, follow-up)                    |
| `list_task_escalations`   | Escalations raised on the Task (resolving one is a human gate)       |
| `get_task_chat`           | Paginated chat thread                                                |
| `post_task_chat_message`  | Post a chat message on the Task                                      |
| `get_task_spend`          | Per-Task spend rollup                                                |

### Inbox (7)

The Inbox is where agents ask humans for decisions and approvals. The tools read and triage it; answering an item (`POST /api/inbox/{id}/reply`) is the approval itself and is done by a person in the app.

| Tool                     | Description                                |
| ------------------------ | ------------------------------------------ |
| `list_inbox`             | List Inbox items (active view by default)  |
| `get_inbox_unread_count` | Unread count                               |
| `get_inbox_item`         | Get one item with its question and options |
| `mark_inbox_item_read`   | Mark read (or unread again)                |
| `archive_inbox_item`     | Archive an item                            |
| `unarchive_inbox_item`   | Bring an archived item back                |
| `delete_inbox_item`      | Delete an item                             |

### Goals (10)

Goals are outcome-driven autopilot: the platform observes a metric and dispatches Tasks toward a definition of done. Approving proposed criteria (`POST /api/me/goals/{id}/dod/approve`) is a human gate and is not a tool.

| Tool                 | Description                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `list_goals`         | List my Goals                                                                                                         |
| `create_goal`        | Create a Goal                                                                                                         |
| `get_goal`           | Get one Goal                                                                                                          |
| `update_goal`        | Update Goal fields (partial)                                                                                          |
| `get_goal_samples`   | Observation history (newest first)                                                                                    |
| `activate_goal`      | Activate a Goal                                                                                                       |
| `pause_goal`         | Pause a Goal                                                                                                          |
| `evaluate_goal_now`  | Evaluate the Goal immediately                                                                                         |
| `update_goal_limits` | Change the Goal's spend / iteration limits                                                                            |
| `propose_goal_dod`   | Append proposed definition-of-done criteria for a person to approve (proposed criteria never count toward completion) |

### Fleet (8)

The Fleet is the owner's own machines enrolled as nodes; node-facing routes (enroll, heartbeat, lease) and enrollment tokens are deliberately not exposed. The three node-affinity tools are Organization-scoped: they need `EVER_WORKS_SCOPE_SLUG` (see above) and answer `400` in the personal scope.

| Tool                              | Description                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `list_fleet_nodes`                | List enrolled nodes with status and capabilities                                                         |
| `get_fleet_node`                  | One node with its recent jobs                                                                            |
| `get_fleet_runner_status`         | Is a runner available right now                                                                          |
| `get_fleet_execution_preferences` | Where each job kind runs (local-wait / local-fallback / cloud)                                           |
| `get_agent_node_affinity`         | Which node an Agent is pinned to                                                                         |
| `set_agent_node_affinity`         | Pin an Agent to a node                                                                                   |
| `clear_agent_node_affinity`       | Remove the pin                                                                                           |
| `drain_fleet_node`                | Drain a node: disable it and requeue its in-flight claims at once (`drain: false` returns it to service) |

### Agents (9)

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

1. Ensure the endpoint is documented in the API's OpenAPI spec (via `@nestjs/swagger` decorators)
2. Add an entry to `src/openapi-tools/whitelist.ts`:
    ```typescript
    { method: 'GET', path: '/api/your-endpoint', toolName: 'your_tool_name' }
    ```
3. Rebuild and restart the server

The tool's parameter schema and description are automatically derived from the OpenAPI spec.
