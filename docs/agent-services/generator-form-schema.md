---
id: generator-form-schema
title: Generator Form Schema Service
sidebar_label: Generator Form Schema
sidebar_position: 6
---

# Generator Form Schema Service

The `GeneratorFormSchemaService` dynamically builds the generator form schema based on the active plugin pipeline and enabled plugins. It powers the frontend form that users interact with when configuring a generation run.

**Source:** `packages/agent/src/services/generator-form-schema.service.ts`

## Overview

The generator form is not static -- it changes based on which pipeline plugin is selected and which data source plugins are enabled. This service resolves the complete form schema by querying the plugin registry, collecting form field definitions, and determining available providers for each capability category.

## Dependencies

```typescript
constructor(
    private readonly pluginRegistry: PluginRegistryService,
    @Optional() private readonly workPluginRepository?: WorkPluginRepository,
    @Optional() private readonly pluginSettingsService?: PluginSettingsService,
)
```

- **PluginRegistryService** -- Central registry of all installed plugins and their capabilities.
- **WorkPluginRepository** -- Tracks which plugins are enabled/active per work.
- **PluginSettingsService** -- Resolves plugin settings and checks required configuration.

## Core Concepts

### GeneratorFormSchema

The complete form schema returned to the frontend:

```typescript
interface GeneratorFormSchema {
	resolvedPipelineId: string | undefined;
	providers: Record<string, ProviderOption[]>;
	pluginFields: FormFieldDefinition[];
	pluginGroups?: FormFieldGroup[];
	handledConfigFields: readonly string[];
	defaultValues?: Record<string, unknown>;
}
```

### ProviderOption

Each selectable provider in the form:

```typescript
interface ProviderOption {
	id: string;
	name: string;
	description: string;
	configured: boolean;
	isDefault: boolean;
	icon?: string;
}
```

## Getting the Form Schema

The primary method `getFormSchema()` orchestrates the full schema resolution:

```typescript
const schema = await formSchemaService.getFormSchema(
	'agent-pipeline', // pipelineId (optional)
	{ workId, userId } // scope options
);
```

### Resolution Steps

1. **Resolve pipeline plugin** -- Determines which pipeline plugin to use (see resolution order below).
2. **Get available providers** -- For each capability category (AI, search, screenshot, content extraction, pipeline), queries the registry for loaded, enabled, non-supplementary plugins.
3. **Filter by pipeline** -- If the pipeline declares `selectableProviderCategories`, categories not in the list are emptied.
4. **Collect pipeline form fields** -- If the pipeline implements `FormSchemaProvider`, retrieves `getFormFields()`, `getFormGroups()`, `handledConfigFields`, and `getDefaultValues()`.
5. **Collect additional form fields** -- From enabled `FORM_SCHEMA_PROVIDER` plugins (excluding pipelines), deduplicating by field name.
6. **Merge and return** -- Combines all fields, groups, and default values into the final schema.

### Pipeline Resolution Order

The service resolves the pipeline plugin through a priority chain:

| Priority | Source                                             | Description             |
| -------- | -------------------------------------------------- | ----------------------- |
| 1        | Explicit `pipelineId` parameter                    | User-selected pipeline  |
| 2        | Work's `activeCapability` for `'pipeline'`    | Work-level default |
| 3        | Plugin with `defaultForCapabilities: ['pipeline']` | System-level default    |
| 4        | First loaded pipeline plugin                       | Fallback                |

### Provider Filtering

Providers are filtered based on scope:

- **Enable status** -- Checked via `pluginRegistry.isPluginEnabledForScope()` which considers Work > User > autoEnable hierarchy.
- **Supplementary flag** -- Plugins marked as `supplementary` (e.g., notion-extractor) are excluded from selectable lists; they activate via URL matching.
- **Plugin state** -- Only `loaded` plugins are included.

### Default Provider Detection

A provider is marked as `isDefault` when:

1. It matches the work's `activeCapability` entry for that category, **OR**
2. Its manifest includes the capability in `defaultForCapabilities`, **OR**
3. It is a `systemPlugin` (fallback).

## Validating Form Values

```typescript
const result = await formSchemaService.validateFormValues(pipelineId, formValues, { workId, userId });
// result: { valid: true } or { valid: false, errors: [...] }
```

Validation runs in two phases:

1. **Pipeline validation** -- Calls `validateFormInput()` on the pipeline plugin.
2. **Data source plugin validation** -- For each enabled `FORM_SCHEMA_PROVIDER` plugin, validates the nested values under `values[pluginId]`.

## Processing Form Configuration

The `processFormConfig()` method transforms raw form values into structured configuration:

```typescript
const { config, pluginConfig } = await formSchemaService.processFormConfig(pipelineId, rawFormValues, {
	workId,
	userId
});
```

### Transformation Steps

1. **Pipeline transform** -- If the pipeline implements `transformFormValues()`, it processes the full config first.
2. **Plugin transforms** -- Each enabled `FORM_SCHEMA_PROVIDER` plugin transforms the config to extract its nested key.
3. **Separation** -- Plugin-specific config (nested under `pluginId` keys) is extracted into `pluginConfig`, leaving flat config in `config`.

### Output Structure

```typescript
{
    config: {
        // Flat configuration values (prompt, generation settings, etc.)
        max_search_queries: 10,
        ai_first_generation_enabled: true,
    },
    pluginConfig: {
        // Per-plugin nested configuration
        'notion-extractor': { database_id: 'abc123' },
        'custom-scorer': { weight_threshold: 0.8 },
    },
}
```

## Validating Plugin Configuration

The `validateFormSchemaPlugins()` method ensures all enabled form-schema-provider plugins are properly configured:

```typescript
await formSchemaService.validateFormSchemaPlugins({ workId, userId });
```

For each enabled plugin:

1. Checks if required settings are configured via `getResolvedSettings()`.
2. Validates `required` fields from the JSON Schema.
3. Validates `x-requiredGroups` -- at least one field in each group must have a value.
4. Settings with `x-envVar` (without `x-secret`) are considered auto-configured.

Throws `BadRequestException` with a list of errors if any plugins are misconfigured.

## Validating Selected Providers

```typescript
await formSchemaService.validateSelectedProviders({ ai: 'openai', search: 'exa' }, { workId, userId });
```

Validates each provider through the chain: **exists** -> **loaded** -> **enabled** -> **configured**. If a provider field is empty, validates the default provider for that category instead.

## Plugin Configuration Check

The `isPluginConfigured()` method determines if a plugin has all required settings:

```typescript
// Checks:
// 1. Required fields from schema.required[]
// 2. Required groups from schema['x-requiredGroups'][]
// 3. Skips fields with x-envVar (environment-provided)
```

This enables the frontend to show "not configured" badges on providers that need setup.
