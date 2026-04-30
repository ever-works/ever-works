---
id: plugin-api-layer
title: Plugin API Layer
sidebar_label: Plugin API Layer
sidebar_position: 4
---

# Plugin API Layer

The Plugin API Layer (`@ever-works/plugin/api`) defines the types and utilities used by API endpoints to serve plugin data to frontend clients. It provides response type definitions, settings helper functions for scope-based filtering, and constraint validation for plugin settings values.

## Package Overview

| Property | Value |
|---|---|
| **Import path** | `@ever-works/plugin/api` |
| **Location** | `platform/packages/plugin/src/api/` |
| **Format** | ESM (tsup build) |
| **Purpose** | API response types, settings helpers, validation |

## API Response Types

### PluginResponse

The base type for plugin data returned by the API.

```typescript
interface PluginResponse {
    id: string;              // Database entity ID
    pluginId: string;        // Unique plugin identifier
    name: string;            // Display name
    version: string;         // Semver version
    description?: string;    // Plugin description
    readme?: string;         // Markdown readme
    category: PluginCategory;
    capabilities: string[];
    configurationMode: ConfigurationMode;
    builtIn: boolean;
    systemPlugin: boolean;
    visibility: PluginVisibility;
    state: PluginState;
    icon?: PluginIcon;
    settingsSchema?: PluginSettingsSchema;
    author?: PluginAuthor;
    homepage?: string;
    autoEnable?: boolean;
    supplementary?: boolean;
}
```

### Response Hierarchy

The API provides increasingly detailed plugin responses based on context:

| Type | Extends | Additional Fields |
|---|---|---|
| `PluginResponse` | -- | Base plugin data |
| `UserPluginResponse` | `PluginResponse` | `installed`, `enabled`, `settings`, `userPluginId`, `autoEnableForDirectories` |
| `DirectoryPluginResponse` | `UserPluginResponse` | `directoryEnabled`, `activeCapability`, `directorySettings`, `directoryPluginId`, `priority` |

### List Response Types

```typescript
interface PluginListResponse {
    plugins: UserPluginResponse[];
    total: number;
    categories?: PluginCategory[];
    capabilities?: string[];
}

interface DirectoryPluginListResponse {
    plugins: DirectoryPluginResponse[];
    total: number;
    capabilityProviders?: Record<string, string>;
}
```

### Settings Menu Types

For the settings UI, the API provides a structured menu with category groupings:

```typescript
interface SettingsMenuResponse {
    categories: SettingsMenuCategory[];
}

interface SettingsMenuCategory {
    category: PluginCategory;
    label: string;
    plugins: SettingsMenuPlugin[];
}

interface SettingsMenuPlugin {
    pluginId: string;
    name: string;
    icon?: PluginIcon;
    enabled: boolean;
    hasRequiredSettings: boolean;
}
```

## Settings Schema

The `PluginSettingsSchema` and `PluginSettingsSchemaProperty` types are flattened representations of JSON Schema, optimized for UI rendering. The API transforms `x-`prefixed JSON Schema extensions into flat properties.

### Property Mapping

| JSON Schema Extension | API Property | Description |
|---|---|---|
| `x-secret` | `secret` | Password-masked field |
| `x-adminOnly` | `adminOnly` | Admin-only field |
| `x-envVar` | `envVar` | Environment variable name |
| `x-scope` | `scope` | Setting scope: `global`, `user`, `directory` |
| `x-widget` | `widget` | UI widget hint (e.g., `model-select`) |
| `x-hidden` | `hidden` | Hidden from settings UI |
| `x-showIf` | `showIf` | Conditional visibility |
| `x-requiredGroups` | `requiredGroups` | Groups where at least one field must be set |

### Schema Transformation

```typescript
const apiSchema = toPluginSettingsSchemaProperty(jsonSchema);
// Transforms x-prefixed properties into flat API-friendly format
```

## Settings Helpers

Functions in `settings-helpers.ts` for working with plugin settings at different scopes.

### splitSettingsBySecret

Separates settings into regular and secret buckets, populating schema defaults for visible fields.

```typescript
const { regular, secret } = splitSettingsBySecret(
    userSettings,
    pluginSchema,
    ['global', 'user']
);
// regular: { model: 'gpt-4', temperature: 0.7 }
// secret: { apiKey: 'sk-...' }
```

### getVisibleProperties

Filters schema properties by scope, excluding hidden fields.

```typescript
const visible = getVisibleProperties(schema, ['global', 'user']);
// Returns only properties matching the specified scopes
```

### getRequiredFields

Returns required field names filtered by scope.

```typescript
const required = getRequiredFields(schema, ['global', 'user']);
// ['apiKey', 'model']
```

### validateRequiredSettings

Validates that required fields are filled, supporting directory-level inheritance from user-level fallback settings. Also validates `requiredGroups`.

```typescript
const errors = validateRequiredSettings(
    settings, secretSettings, schema,
    ['global', 'user', 'directory'],
    'directory',
    userFallbackSettings
);
// ['API Key', 'At least one of: API Key, Base URL']
```

### sanitizeSettingsForSave

Normalizes settings values for storage: converts `undefined` to `null`, and at directory scope also converts empty strings to `null`.

```typescript
const sanitized = sanitizeSettingsForSave(settings, 'directory');
```

## Constraint Validation

The `validateSettingsConstraints` function validates setting values against their schema constraints. It skips empty/null/undefined values (required checks are handled separately).

### Supported Constraints

| Type | Constraints |
|---|---|
| `number` | `minimum`, `maximum` |
| `string` | `minLength`, `maxLength`, `pattern` (regex) |
| Any | `enum` (allowed values list) |

```typescript
interface ConstraintError {
    readonly field: string;
    readonly message: string;
}

const errors = validateSettingsConstraints(values, visibleProperties);
// [
//   { field: 'temperature', message: 'Temperature must be at most 2' },
//   { field: 'apiKey', message: 'API Key must be at least 10 characters' }
// ]
```

### Validation Examples

```typescript
// Number range validation
validateSettingsConstraints(
    { temperature: 3.0 },
    { temperature: { type: 'number', title: 'Temperature', maximum: 2 } }
);
// => [{ field: 'temperature', message: 'Temperature must be at most 2' }]

// String pattern validation
validateSettingsConstraints(
    { model: 'invalid model!' },
    { model: { type: 'string', title: 'Model', pattern: '^[a-z0-9-]+$' } }
);
// => [{ field: 'model', message: 'Model has an invalid format' }]

// Enum validation
validateSettingsConstraints(
    { mode: 'invalid' },
    { mode: { type: 'string', title: 'Mode', enum: ['fast', 'balanced', 'quality'] } }
);
// => [{ field: 'mode', message: 'Mode must be one of: fast, balanced, quality' }]
```

## Re-exported Types

The API module re-exports commonly used types for convenience:

```typescript
export type { PluginCategory, PluginAuthor, PluginIcon, PluginIconType, PluginVisibility }
    from '../contracts/plugin-manifest.types.js';
export type { PluginState } from '../contracts/lifecycle.types.js';
export type { ConfigurationMode } from '../settings/settings.types.js';
```

## File Structure

```
plugin/src/api/
  index.ts                          # Public exports with re-exports
  api-response.types.ts             # Response types and schema transform
  settings-helpers.ts               # Scope-based settings utilities
  validate-settings-constraints.ts  # Constraint validation logic
  __tests__/                        # Test files
```
