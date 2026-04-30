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

| Parameter | Type | Description |
|-----------|------|-------------|
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
    "autoEnableForDirectories": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `settings` | object | Non-secret settings to apply |
| `secretSettings` | object | Secret settings (API keys, tokens) |
| `autoEnableForDirectories` | boolean | Auto-enable this plugin for all directories |

### Disable Plugin

Disable a plugin for the current user. This cascades — the plugin will be disabled for all the user's directories.

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

| Field | Type | Description |
|-------|------|-------------|
| `settings` | object | Non-secret settings to update (merged with existing) |
| `secretSettings` | object | Secret settings to update |
| `metadata` | object | Arbitrary metadata to store with the plugin |

**Errors:**

| Status | Description |
|--------|-------------|
| 400 | Plugin not enabled for this user |
| 404 | Plugin not found |

## Directory Plugin Management

Directory endpoints manage plugin configuration at the directory level. All directory endpoints require the user to have edit permissions on the directory.

### List Directory Plugins

Get all plugins with their directory-specific configuration.

**Endpoint:** `GET /api/directories/:directoryId/plugins`

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

### Enable Plugin for Directory

Enable a plugin for a specific directory. The plugin must already be enabled at the user level.

**Endpoint:** `POST /api/directories/:directoryId/plugins/:pluginId/enable`

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

| Field | Type | Description |
|-------|------|-------------|
| `settings` | object | Directory-specific settings overrides |
| `activeCapability` | string | Set this plugin as the active provider for this capability |
| `priority` | number | Priority when multiple plugins provide the same capability |

**Errors:**

| Status | Description |
|--------|-------------|
| 400 | Plugin not enabled at user level |
| 404 | Plugin or directory not found |

### Disable Plugin for Directory

Disable a plugin for a specific directory. The user-level setting is not affected.

**Endpoint:** `POST /api/directories/:directoryId/plugins/:pluginId/disable`

### Update Directory Plugin Settings

Update directory-specific settings for a plugin. These settings take highest priority in the [settings hierarchy](/plugin-system/settings#resolution-hierarchy).

**Endpoint:** `PATCH /api/directories/:directoryId/plugins/:pluginId/settings`

**Body:**

```json
{
    "settings": {
        "defaultModel": "gpt-4o-mini",
        "temperature": 0.5
    },
    "secretSettings": {
        "apiKey": "directory-specific-key"
    }
}
```

**Errors:**

| Status | Description |
|--------|-------------|
| 400 | Plugin not enabled for this directory |

### Set Active Capability

Designate a plugin as the active provider for a specific capability in this directory. For example, set OpenAI as the active `ai-provider` for this directory.

**Endpoint:** `POST /api/directories/:directoryId/plugins/:pluginId/capability`

**Body:**

```json
{
    "capability": "ai-provider"
}
```

Only one plugin can be active per capability per directory. Setting a new active plugin for a capability automatically deactivates the previous one.

**Errors:**

| Status | Description |
|--------|-------------|
| 400 | Plugin does not have the specified capability |

## Endpoint Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/plugins` | List all plugins |
| `GET` | `/api/plugins/settings-menu` | Plugins for settings navigation |
| `GET` | `/api/plugins/:pluginId` | Plugin details |
| `GET` | `/api/plugins/:pluginId/models` | AI models for plugin |
| `POST` | `/api/plugins/:pluginId/enable` | Enable for user |
| `POST` | `/api/plugins/:pluginId/disable` | Disable for user |
| `PATCH` | `/api/plugins/:pluginId/settings` | Update user settings |
| `GET` | `/api/directories/:directoryId/plugins` | Directory plugins |
| `POST` | `/api/directories/:directoryId/plugins/:pluginId/enable` | Enable for directory |
| `POST` | `/api/directories/:directoryId/plugins/:pluginId/disable` | Disable for directory |
| `PATCH` | `/api/directories/:directoryId/plugins/:pluginId/settings` | Update directory settings |
| `POST` | `/api/directories/:directoryId/plugins/:pluginId/capability` | Set active capability |
