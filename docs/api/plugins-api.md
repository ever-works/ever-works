---
id: plugins-api
title: Plugins API Endpoints
sidebar_label: Plugins API
sidebar_position: 10
---

# Plugins API Endpoints

The plugins API exposes REST endpoints for managing plugins at two levels: **user-level** (global installation and settings) and **work-level** (per-work enablement and capability assignment). The controller is at `apps/api/src/plugins/plugins.controller.ts`, backed by `PluginOperationsService` from the agent package.

## Architecture

```
apps/api/src/plugins/
  plugins.controller.ts           # REST endpoints for plugin management
  plugins.module.ts               # NestJS module (TypeORM entities, services)
  dto/
    plugin-response.dto.ts        # Response DTOs (Plugin, UserPlugin, WorkPlugin)
    settings-menu.dto.ts          # Settings menu grouping DTOs
    update-plugin-settings.dto.ts # Request DTOs for enable/disable/settings
    validators/
      capability.validator.ts     # Custom capability validator
```

## Plugin Listing

All endpoints require JWT authentication.

### GET `/api/plugins`

List all available plugins with user-specific installation status.

| Query Parameter | Type   | Description               |
| --------------- | ------ | ------------------------- |
| `category`      | string | Filter by plugin category |

Returns `PluginListResponseDto` containing `plugins` (array), `total` count, available `categories`, and `capabilities`.

### GET `/api/plugins/settings-menu`

Get user-installed plugins grouped by category for the settings navigation. Only returns plugins with user-configurable settings.

### GET `/api/plugins/:pluginId`

Get detailed information about a specific plugin, including its settings schema, icon, author, capabilities, and user installation status.

### GET `/api/plugins/:pluginId/models`

List available models for an AI provider plugin. Requires the plugin to be enabled with valid credentials.

## User Plugin Management

### POST `/api/plugins/:pluginId/enable`

Enable a plugin for the current user. Accepts optional `settings`, `secretSettings`, and `autoEnableForWorks` flag in the request body.

### POST `/api/plugins/:pluginId/disable`

Disable a plugin for the current user.

### PATCH `/api/plugins/:pluginId/settings`

Update user-specific settings for a plugin. Accepts `settings`, `secretSettings`, and `metadata` in the request body. Returns `400` if the plugin is not installed.

## Work Plugin Management

Work-level endpoints manage how plugins are configured per work. Ownership checks enforce view or edit permissions through `WorkOwnershipService`.

### GET `/api/works/:workId/plugins`

List all plugins with work-specific configuration. Requires view permission.

Returns `WorkPluginListResponseDto` with `plugins`, `total`, and a `capabilityProviders` mapping that shows which plugin is the active provider for each capability.

### POST `/api/works/:workId/plugins/:pluginId/enable`

Enable a plugin for a specific work. Requires edit permission. The plugin must already be installed at the user level. Accepts optional `settings`, `activeCapability`, and `priority`.

### POST `/api/works/:workId/plugins/:pluginId/disable`

Disable a plugin for a specific work. Requires edit permission.

### PATCH `/api/works/:workId/plugins/:pluginId/settings`

Update work-specific settings for a plugin. Accepts `settings`, `secretSettings`, and `metadata`. Requires edit permission.

### POST `/api/works/:workId/plugins/:pluginId/capability`

Set this plugin as the active provider for a given capability in the work. The request body contains a `capability` string validated against `ALL_PLUGIN_CAPABILITIES`. Returns `400` if the plugin does not support the requested capability.

## Response DTOs

### PluginResponseDto

Base plugin information: `id`, `pluginId`, `name`, `version`, `description`, `category`, `capabilities`, `configurationMode`, `builtIn`, `systemPlugin`, `visibility` (`public` | `hidden` | `user-only`), `state`, `icon`, `settingsSchema`, `author`, `homepage`, `autoEnable`.

### UserPluginResponseDto

Extends `PluginResponseDto` with: `installed`, `enabled`, `settings` (masked), `userPluginId`.

### WorkPluginResponseDto

Extends `UserPluginResponseDto` with: `workEnabled`, `activeCapability`, `workSettings` (masked), `workPluginId`, `priority`, `metadata`.

## Settings Schema

Plugin settings are defined via JSON Schema with custom extensions:

| Extension   | Description                                   |
| ----------- | --------------------------------------------- |
| `secret`    | Field is never returned in API responses      |
| `adminOnly` | Restricted to admin users                     |
| `envVar`    | Environment variable name for env-only fields |
| `scope`     | `global`, `user`, or `work`              |
| `widget`    | UI widget hint (e.g., `model-select`)         |
| `hidden`    | Hide from settings UI                         |

## Module Registration

```typescript
@Module({
	imports: [
		TypeOrmModule.forFeature([PluginEntity, UserPluginEntity, WorkPluginEntity]),
		FacadesModule,
		WorkModule,
		AuthModule
	],
	controllers: [PluginsController],
	providers: [PluginOperationsService, SettingsSchemaValidatorService]
})
export class PluginsModule {}
```
