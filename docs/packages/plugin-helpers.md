---
id: plugin-helpers
title: Plugin Helpers & Utilities
sidebar_label: Plugin Helpers & Utilities
sidebar_position: 7
---

# Plugin Helpers & Utilities

The Plugin Helpers module (`@ever-works/plugin/helpers`) provides essential utility functions used across all plugin implementations. It includes context assertion helpers for safely accessing plugin runtime services, a settings resolver that merges configuration from multiple priority layers, and date formatting utilities for LLM prompt construction.

## Package Overview

| Property         | Value                                                   |
| ---------------- | ------------------------------------------------------- |
| **Import path**  | `@ever-works/plugin/helpers`                            |
| **Location**     | `platform/packages/plugin/src/helpers/`                 |
| **Dependencies** | None (uses only Node.js built-ins and plugin contracts) |
| **Used by**      | All plugin implementations                              |

## Module Exports

```typescript
export { resolveSettings, type ResolvedSettings } from './settings-resolver.js';
export {
	assertPluginContext,
	getLogger,
	getCache,
	getHttpClient,
	getEnvVars,
	createScopedLogger,
	createScopedCache,
	isProduction,
	isDevelopment
} from './context-helpers.js';
export { getCurrentDateString } from './date-helpers.js';
```

## Context Helpers

The `context-helpers.ts` module provides safe accessor functions for plugin runtime services. Plugins receive a `PluginContext` object during initialization, and these helpers ensure that required services are available before use.

### assertPluginContext

Validates that the plugin context is properly initialized. Throws descriptive errors if the context or any expected service is missing.

```typescript
import { assertPluginContext } from '@ever-works/plugin/helpers';

function onActivate(context: PluginContext) {
	assertPluginContext(context);
	// Safe to use context.logger, context.cache, etc.
}
```

### Safe Service Getters

Each getter retrieves a service from the context with a descriptive error if the service is unavailable.

| Function                 | Returns                  | Description                  |
| ------------------------ | ------------------------ | ---------------------------- |
| `getLogger(context)`     | `PluginLogger`           | Logger instance from context |
| `getCache(context)`      | `PluginCache`            | Cache service from context   |
| `getHttpClient(context)` | `PluginHttpClient`       | HTTP client from context     |
| `getEnvVars(context)`    | `Record<string, string>` | Environment variables map    |

```typescript
import { getLogger, getCache } from '@ever-works/plugin/helpers';

const logger = getLogger(context);
logger.info('Plugin activated');

const cache = getCache(context);
await cache.get('my-key');
```

### Scoped Logger and Cache

Create child instances scoped to a specific operation or module name. Scoped loggers prefix all messages, and scoped caches prefix all keys to avoid collisions between plugins.

```typescript
import { createScopedLogger, createScopedCache } from '@ever-works/plugin/helpers';

const logger = createScopedLogger(context, 'git-sync');
logger.info('Starting sync'); // => "[git-sync] Starting sync"

const cache = createScopedCache(context, 'github');
await cache.set('repos', data); // key stored as "github:repos"
await cache.get('repos'); // retrieves "github:repos"
```

### Environment Checks

Simple boolean checks for the current runtime environment.

```typescript
import { isProduction, isDevelopment } from '@ever-works/plugin/helpers';

if (isProduction(context)) {
	// Production-only logic
}

if (isDevelopment(context)) {
	// Development-only debug logging
}
```

## Settings Resolver

The `settings-resolver.ts` module implements a layered settings resolution strategy. Plugin settings can be defined at multiple levels, and the resolver merges them in a deterministic priority order.

### Resolution Priority

Settings are resolved from highest to lowest priority. The first non-null, non-undefined value wins:

| Priority    | Source                | Description                     |
| ----------- | --------------------- | ------------------------------- |
| 1 (highest) | User settings         | Per-user configuration          |
| 2           | Directory settings    | Per-directory overrides         |
| 3           | Admin settings        | Organization-wide defaults      |
| 4           | Environment variables | `x-envVar` mapped values        |
| 5 (lowest)  | Schema defaults       | Default values from JSON Schema |

### resolveSettings

```typescript
import { resolveSettings } from '@ever-works/plugin/helpers';

const resolved = resolveSettings({
	schema: pluginSettingsSchema,
	userSettings: { model: 'gpt-4', temperature: 0.7 },
	directorySettings: { model: 'gpt-3.5-turbo' },
	adminSettings: {},
	envVars: { OPENAI_API_KEY: 'sk-...' }
});

// resolved.model => 'gpt-4' (user takes priority over directory)
// resolved.apiKey => 'sk-...' (from env var via x-envVar mapping)
// resolved.temperature => 0.7 (from user settings)
```

### Environment Variable Mapping

The resolver reads `x-envVar` annotations from the plugin's JSON Schema to map environment variables to settings fields.

```typescript
// In plugin settings schema:
{
    "properties": {
        "apiKey": {
            "type": "string",
            "x-envVar": "OPENAI_API_KEY",
            "x-secret": true
        }
    }
}

// If no user/directory/admin setting provides apiKey,
// the resolver checks process.env.OPENAI_API_KEY
```

### Environment Variable Parsing

The resolver automatically parses environment variable string values into their appropriate types based on the schema:

| Schema Type | Parsing Behavior                                                 |
| ----------- | ---------------------------------------------------------------- |
| `number`    | `parseFloat(value)`, skipped if `NaN`                            |
| `boolean`   | `'true'` / `'1'` become `true`, `'false'` / `'0'` become `false` |
| `string`    | Used as-is                                                       |

### Deep Equality Check

The resolver uses a deep equality comparison when determining whether a setting has changed, ensuring that object and array values are compared structurally rather than by reference. This prevents unnecessary updates when settings objects are reconstructed but contain identical values.

## Date Helpers

The `date-helpers.ts` module provides date formatting utilities optimized for inclusion in LLM prompts.

### getCurrentDateString

Returns the current date as a human-readable string using `Intl.DateTimeFormat`. This is used in AI prompts to give the model awareness of the current date without requiring system-level access.

```typescript
import { getCurrentDateString } from '@ever-works/plugin/helpers';

const dateStr = getCurrentDateString();
// => "Tuesday, March 4, 2025"

// Used in AI prompts:
const systemPrompt = `You are a helpful assistant. Today's date is ${getCurrentDateString()}.`;
```

The format uses the `en-US` locale with `{ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }` options, producing a consistent, unambiguous date representation that LLMs can easily parse.

## Usage Patterns

### Typical Plugin Initialization

```typescript
import {
	assertPluginContext,
	getLogger,
	getCache,
	resolveSettings,
	createScopedLogger
} from '@ever-works/plugin/helpers';

class MyPlugin implements IPlugin {
	private logger!: PluginLogger;
	private cache!: PluginCache;

	async onActivate(context: PluginContext): Promise<void> {
		assertPluginContext(context);
		this.logger = createScopedLogger(context, 'my-plugin');
		this.cache = getCache(context);

		const settings = resolveSettings({
			schema: this.settingsSchema,
			userSettings: context.settings,
			directorySettings: context.directorySettings,
			adminSettings: context.adminSettings,
			envVars: context.envVars
		});

		this.logger.info('Plugin activated with resolved settings');
	}
}
```

### Settings Resolution in Capabilities

```typescript
async generateContent(prompt: string, context: PluginContext): Promise<string> {
    const settings = resolveSettings({
        schema: this.settingsSchema,
        userSettings: context.settings,
        directorySettings: context.directorySettings,
        adminSettings: {},
        envVars: context.envVars,
    });

    return this.aiOps.createChatCompletion({
        messages: [{ role: 'user', content: prompt }],
        temperature: settings.temperature,
        model: settings.model,
    });
}
```

## File Structure

```
plugin/src/helpers/
  index.ts              # Public exports
  context-helpers.ts    # Context assertion and service accessors
  settings-resolver.ts  # Layered settings resolution
  date-helpers.ts       # Date formatting for LLM prompts
```
