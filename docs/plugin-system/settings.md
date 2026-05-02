---
id: settings
title: Plugin Settings
sidebar_label: Settings
sidebar_position: 3
---

# Plugin Settings

Every plugin defines its configuration through a **JSON Schema** with custom extensions. Settings are resolved at runtime through a cascading hierarchy, allowing admins to set defaults while users and works can override them.

## Settings Schema

Plugins declare their settings in the `settingsSchema` property using [JSON Schema](https://json-schema.org/) with platform-specific extensions:

```typescript
readonly settingsSchema: JsonSchema = {
    type: 'object',
    properties: {
        apiKey: {
            type: 'string',
            title: 'API Key',
            description: 'Your API key for this service',
            'x-secret': true,
            'x-envVar': 'PLUGIN_EXAMPLE_API_KEY',
            'x-scope': 'user',
        },
        defaultModel: {
            type: 'string',
            title: 'Default Model',
            default: 'gpt-4o',
            'x-widget': 'model-select',
            'x-scope': 'global',
        },
        maxResults: {
            type: 'number',
            title: 'Max Results',
            default: 10,
            minimum: 1,
            maximum: 100,
        },
        advancedMode: {
            type: 'boolean',
            title: 'Advanced Mode',
            default: false,
            'x-hidden': true,
        },
    },
    required: ['apiKey'],
};
```

## Schema Extensions

The platform extends JSON Schema with `x-*` properties that control security, scoping, and UI behavior:

| Extension     | Type                                | Description                                                                                  |
| ------------- | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| `x-secret`    | `boolean`                           | Field is encrypted at rest and masked in API responses. Use for API keys, tokens, passwords. |
| `x-envVar`    | `string`                            | Environment variable name to check as a fallback when no setting is stored.                  |
| `x-scope`     | `'global' \| 'user' \| 'work'` | Which scope level can set this field.                                                        |
| `x-widget`    | `string`                            | UI rendering hint (e.g., `model-select` renders a model picker dropdown).                    |
| `x-hidden`    | `boolean`                           | Hide from the settings UI. Used for advanced/internal settings.                              |
| `x-adminOnly` | `boolean`                           | Only visible to admin users.                                                                 |

### x-secret

Fields marked with `x-secret: true` receive special handling:

- **Stored encrypted** in a separate `secretSettings` column in the database
- **Never returned** in API responses (masked as `"••••••"` or omitted)
- **Environment variable fallback** — If the user hasn't set the value, the system checks the `x-envVar` environment variable

### x-envVar

Maps a setting to an environment variable. This is the lowest-priority source — it's only used when no stored value exists at any scope.

```typescript
apiKey: {
    type: 'string',
    'x-secret': true,
    'x-envVar': 'PLUGIN_BRAVE_API_KEY',
}
```

With this schema, the API key is resolved as:

1. Work setting (if in work context)
2. User setting
3. Admin setting
4. `PLUGIN_BRAVE_API_KEY` environment variable
5. Not configured (error)

### x-scope

Controls which scope levels can set the field:

- **`global`** — Typically admin-level settings shared across the platform (e.g., default model names)
- **`user`** — User-specific settings (e.g., personal API keys)
- **`work`** — Can be overridden per work

## Resolution Hierarchy

When the platform needs a plugin's settings (e.g., to make an API call), it resolves each field through a cascading hierarchy:

```
┌─────────────────────────────────┐
│  1. Work settings          │  ← Highest priority
│     (per-work overrides)   │
├─────────────────────────────────┤
│  2. User settings               │
│     (personal configuration)    │
├─────────────────────────────────┤
│  3. Admin settings              │
│     (system-wide defaults)      │
├─────────────────────────────────┤
│  4. Environment variables       │
│     (from .env or process.env)  │
├─────────────────────────────────┤
│  5. Plugin defaults             │  ← Lowest priority
│     (default in schema)         │
└─────────────────────────────────┘
```

Settings are merged per-field, not per-scope. For example, if a user sets `apiKey` but not `maxResults`, the final resolved settings will contain the user's `apiKey` and the admin's (or default) `maxResults`.

### Resolved Settings

The `getResolvedSettings()` method returns each field with its source:

```typescript
interface ResolvedSetting<T = unknown> {
	readonly key: string;
	readonly value: T;
	readonly source: 'default' | 'env' | 'admin' | 'work' | 'user';
	readonly isFallback: boolean;
}
```

This is useful for the UI to show where each value comes from and whether it's an override.

## Configuration Modes

Each plugin declares a `configurationMode` that controls the user experience:

| Mode            | Behavior                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `admin-only`    | Only admins can configure the plugin. Users see it but cannot change settings. Suitable for system infrastructure.   |
| `user-required` | Users **must** provide their own configuration (e.g., API keys). The plugin won't work until the user configures it. |
| `hybrid`        | Admins set defaults, users can optionally override. Most common mode.                                                |

Example scenarios:

- **OpenAI plugin** (`user-required`) — Each user provides their own OpenAI API key
- **Default Pipeline plugin** (`admin-only`) — System plugin, no user configuration needed
- **Tavily plugin** (`hybrid`) — Admin can set a shared API key, users can override with their own

## Settings Validation

Plugins implement `validateSettings()` to enforce constraints beyond what JSON Schema provides:

```typescript
async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
    const errors = [];

    if (!settings.apiKey) {
        errors.push({ path: 'apiKey', message: 'API key is required' });
    }

    if (settings.maxResults && (settings.maxResults < 1 || settings.maxResults > 100)) {
        errors.push({ path: 'maxResults', message: 'Must be between 1 and 100' });
    }

    return { valid: errors.length === 0, errors };
}
```

Validation runs when settings are saved through the API. The `ValidationResult` type:

```typescript
interface ValidationResult {
	readonly valid: boolean;
	readonly errors?: readonly ValidationError[];
	readonly warnings?: readonly ValidationError[];
}

interface ValidationError {
	readonly path: string; // Field path (e.g., 'apiKey')
	readonly message: string; // Human-readable error
	readonly code?: string; // Machine-readable error code
}
```

## Database Storage

Settings are persisted in three tables, one per scope:

| Table                   | Scope         | Settings Column | Secrets Column   |
| ----------------------- | ------------- | --------------- | ---------------- |
| `PluginEntity`          | Admin/system  | `settings`      | `secretSettings` |
| `UserPluginEntity`      | Per user      | `settings`      | `secretSettings` |
| `WorkPluginEntity` | Per work | `settings`      | `secretSettings` |

Secret fields (marked with `x-secret`) are stored in a separate `secretSettings` column at every scope level. During resolution, the system checks work secrets first, then user secrets, then admin secrets, following the same cascading hierarchy as regular settings.

## Frontend Integration

The settings UI is automatically generated from the `settingsSchema`:

- **Standard fields** render as text inputs, number inputs, toggles, or dropdowns based on the JSON Schema type and `enum` values
- **`x-widget: 'model-select'`** renders a model picker that fetches available models from the plugin
- **`x-secret` fields** show password inputs with a "configured" indicator
- **`x-hidden` fields** are not shown in the UI
- **Scope indicators** show where each value comes from (admin default, user override, etc.)

Settings pages are available at:

- `/settings/plugins/[category]` — User-level settings by category
- `/plugins/[pluginId]` — Plugin detail page with settings
- `/works/[id]/plugins` — Work-level plugin management
