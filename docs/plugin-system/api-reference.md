---
id: api-reference
title: Plugin API Reference
sidebar_label: API Reference
sidebar_position: 6
---

# Plugin API Reference

All plugin endpoints require JWT authentication. The base path is `/api/`.

## Plugin Listing

### List All Plugins

Get all available plugins with the current user's installation status.

**Endpoint:** `GET /api/plugins`

**Query Parameters:**

| Parameter  | Type   | Description                                        |
| ---------- | ------ | -------------------------------------------------- |
| `category` | string | Filter by category (e.g., `ai-provider`, `search`) |

**Response:**

```json
{
	"plugins": [
		{
			"id": "openai",
			"name": "OpenAI",
			"version": "1.0.0",
			"description": "Use OpenAI models like GPT-4o for content generation",
			"category": "ai-provider",
			"capabilities": ["ai-provider"],
			"icon": { "type": "svg", "value": "<svg>...</svg>" },
			"enabled": true,
			"configured": true,
			"autoEnable": false,
			"systemPlugin": false,
			"builtIn": true
		}
	]
}
```

### Get Settings Menu

Get plugins grouped by category for the settings navigation UI. Only returns plugins that the user has enabled and that have user-configurable settings.

**Endpoint:** `GET /api/plugins/settings-menu`

**Response:**

```json
{
	"categories": [
		{
			"id": "ai-provider",
			"label": "AI Providers",
			"plugins": [
				{
					"id": "openai",
					"name": "OpenAI",
					"icon": { "type": "svg", "value": "..." },
					"configured": true
				}
			]
		}
	]
}
```

### Get Plugin Details

Get detailed information about a specific plugin, including its settings schema and current user settings.

**Endpoint:** `GET /api/plugins/:pluginId`

**Response:**

```json
{
	"id": "tavily",
	"name": "Tavily",
	"version": "1.0.0",
	"description": "Web search and content extraction using Tavily API",
	"category": "search",
	"capabilities": ["search", "content-extractor"],
	"settingsSchema": {
		"type": "object",
		"properties": {
			"apiKey": {
				"type": "string",
				"title": "API Key",
				"x-secret": true,
				"x-envVar": "PLUGIN_TAVILY_API_KEY"
			}
		}
	},
	"settings": {
		"searchDepth": "basic",
		"maxResults": 10
	},
	"enabled": true,
	"configured": true,
	"readme": "## What does Tavily do?\n\n..."
}
```

:::info
Secret fields (`x-secret: true`) are never returned in settings responses. They appear as masked values or are omitted entirely.
:::

### List Plugin Models

For AI provider plugins, fetch the list of available models. The plugin must be enabled and have valid credentials configured.

**Endpoint:** `GET /api/plugins/:pluginId/models`

**Response:**

```json
[
	{
		"id": "gpt-4o",
		"name": "GPT-4o",
		"contextLength": 128000,
		"capabilities": {
			"supportsStreaming": true,
			"supportsToolCalling": true,
			"supportsVision": true
		}
	},
	{
		"id": "gpt-4o-mini",
		"name": "GPT-4o Mini",
		"contextLength": 128000
	}
]
```

## User Plugin Management

### Enable Plugin

Enable a plugin for the current user. Optionally provide initial settings.

**Endpoint:** `POST /api/plugins/:pluginId/enable`

**Body:**

```json
{
	"settings": {
		"maxResults": 20
	},
	"secretSettings": {
		"apiKey": "sk-..."
	},
	"autoEnableForWorks": true
}
```

| Field                | Type    | Description                           |
| -------------------- | ------- | ------------------------------------- |
| `settings`           | object  | Non-secret settings to apply          |
| `secretSettings`     | object  | Secret settings (API keys, tokens)    |
| `autoEnableForWorks` | boolean | Auto-enable this plugin for all works |

### Disable Plugin

Disable a plugin for the current user. This cascades — the plugin will be disabled for all the user's works.

**Endpoint:** `POST /api/plugins/:pluginId/disable`

### Update Plugin Settings

Update user-specific settings for an enabled plugin.

**Endpoint:** `PATCH /api/plugins/:pluginId/settings`

**Body:**

```json
{
	"settings": {
		"searchDepth": "advanced",
		"maxResults": 20
	},
	"secretSettings": {
		"apiKey": "new-key-..."
	},
	"metadata": {
		"lastConfigured": "2025-01-15"
	}
}
```

| Field            | Type   | Description                                          |
| ---------------- | ------ | ---------------------------------------------------- |
| `settings`       | object | Non-secret settings to update (merged with existing) |
| `secretSettings` | object | Secret settings to update                            |
| `metadata`       | object | Arbitrary metadata to store with the plugin          |

**Errors:**

| Status | Description                      |
| ------ | -------------------------------- |
| 400    | Plugin not enabled for this user |
| 404    | Plugin not found                 |

## Work Plugin Management

Work endpoints manage plugin configuration at the work level. All work endpoints require the user to have edit permissions on the work.

### List Work Plugins

Get all plugins with their work-specific configuration.

**Endpoint:** `GET /api/works/:workId/plugins`

**Response:**

```json
{
	"plugins": [
		{
			"id": "openai",
			"name": "OpenAI",
			"category": "ai-provider",
			"enabled": true,
			"activeCapability": "ai-provider",
			"priority": 1,
			"settings": {
				"defaultModel": "gpt-4o"
			}
		}
	]
}
```

### Enable Plugin for Work

Enable a plugin for a specific work. The plugin must already be enabled at the user level.

**Endpoint:** `POST /api/works/:workId/plugins/:pluginId/enable`

**Body:**

```json
{
	"settings": {
		"defaultModel": "gpt-4o-mini"
	},
	"activeCapability": "ai-provider",
	"priority": 1
}
```

| Field              | Type   | Description                                                |
| ------------------ | ------ | ---------------------------------------------------------- |
| `settings`         | object | Work-specific settings overrides                           |
| `activeCapability` | string | Set this plugin as the active provider for this capability |
| `priority`         | number | Priority when multiple plugins provide the same capability |

**Errors:**

| Status | Description                      |
| ------ | -------------------------------- |
| 400    | Plugin not enabled at user level |
| 404    | Plugin or work not found         |

### Disable Plugin for Work

Disable a plugin for a specific work. The user-level setting is not affected.

**Endpoint:** `POST /api/works/:workId/plugins/:pluginId/disable`

### Update Work Plugin Settings

Update work-specific settings for a plugin. These settings take highest priority in the [settings hierarchy](/plugin-system/settings#resolution-hierarchy).

**Endpoint:** `PATCH /api/works/:workId/plugins/:pluginId/settings`

**Body:**

```json
{
	"settings": {
		"defaultModel": "gpt-4o-mini",
		"temperature": 0.5
	},
	"secretSettings": {
		"apiKey": "work-specific-key"
	}
}
```

**Errors:**

| Status | Description                      |
| ------ | -------------------------------- |
| 400    | Plugin not enabled for this work |

### Set Active Capability

Designate a plugin as the active provider for a specific capability in this work. For example, set OpenAI as the active `ai-provider` for this work.

**Endpoint:** `POST /api/works/:workId/plugins/:pluginId/capability`

**Body:**

```json
{
	"capability": "ai-provider"
}
```

Only one plugin can be active per capability per work. Setting a new active plugin for a capability automatically deactivates the previous one.

**Errors:**

| Status | Description                                   |
| ------ | --------------------------------------------- |
| 400    | Plugin does not have the specified capability |

## Endpoint Summary

| Method  | Endpoint                                          | Description                     |
| ------- | ------------------------------------------------- | ------------------------------- |
| `GET`   | `/api/plugins`                                    | List all plugins                |
| `GET`   | `/api/plugins/settings-menu`                      | Plugins for settings navigation |
| `GET`   | `/api/plugins/:pluginId`                          | Plugin details                  |
| `GET`   | `/api/plugins/:pluginId/models`                   | AI models for plugin            |
| `POST`  | `/api/plugins/:pluginId/enable`                   | Enable for user                 |
| `POST`  | `/api/plugins/:pluginId/disable`                  | Disable for user                |
| `PATCH` | `/api/plugins/:pluginId/settings`                 | Update user settings            |
| `GET`   | `/api/works/:workId/plugins`                      | Work plugins                    |
| `POST`  | `/api/works/:workId/plugins/:pluginId/enable`     | Enable for work                 |
| `POST`  | `/api/works/:workId/plugins/:pluginId/disable`    | Disable for work                |
| `PATCH` | `/api/works/:workId/plugins/:pluginId/settings`   | Update work settings            |
| `POST`  | `/api/works/:workId/plugins/:pluginId/capability` | Set active capability           |
