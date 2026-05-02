---
id: plugin-categories
title: Plugin Categories & Capabilities
sidebar_label: Categories & Capabilities
sidebar_position: 7
---

# Plugin Categories & Capabilities

Every plugin in the Ever Works platform declares a **category** and one or more **capabilities**. The category determines how the platform classifies and displays the plugin, while capabilities define the interfaces the plugin implements and the operations it can perform.

## Plugin Categories

Categories are defined as a single source of truth in `@ever-works/plugin` via the `PLUGIN_CATEGORIES` constant:

```typescript
const PLUGIN_CATEGORIES = [
	'git-provider',
	'deployment',
	'screenshot',
	'search',
	'content-extractor',
	'data-source',
	'ai-provider',
	'pipeline',
	'form',
	'integration',
	'utility',
	'theme'
] as const;

type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];
```

Each plugin declares exactly one category. The category is set on the plugin class and included in the plugin manifest.

### Category Overview

| Category            | Description                                        | Example Plugins                                                                             |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `ai-provider`       | Provides AI model access for content generation    | OpenAI, Anthropic, Google, Groq, Ollama, Mistral, OpenRouter, Perplexity, Vercel AI Gateway |
| `search`            | Web search for discovering work items         | Exa, Tavily, SerpAPI, Brave                                                                 |
| `content-extractor` | Extracts structured content from URLs              | Jina, Firecrawl, Local Content Extractor, Notion Extractor, PDF Extractor                   |
| `screenshot`        | Captures website screenshots                       | ScreenshotOne, Urlbox, Scrapfly                                                             |
| `git-provider`      | Git hosting API operations and local git           | GitHub                                                                                      |
| `deployment`        | Deploys generated works to hosting platforms | Vercel                                                                                      |
| `data-source`       | Imports items from external data APIs              | Apify, Bright Data, Scrapfly, Valyu                                                         |
| `pipeline`          | Defines the generation workflow                    | Standard Pipeline (15 steps), Agent Pipeline (5 steps), Claude Code                         |
| `form`              | Provides custom form fields for the generator UI   | (used by pipeline plugins via `IFormSchemaProvider`)                                        |
| `integration`       | Third-party service integrations                   | (extensible)                                                                                |
| `utility`           | General-purpose utilities                          | Comparison Generator                                                                        |
| `theme`             | Visual theme customization                         | (extensible)                                                                                |

## Plugin Capabilities

Capabilities are the functional interfaces a plugin implements. A plugin can declare multiple capabilities. For example, the Exa plugin declares both `search` and `content-extractor` capabilities.

### Capability Constants

```typescript
const PLUGIN_CAPABILITIES = {
	AI_PROVIDER: 'ai-provider',
	SEARCH: 'search',
	SCREENSHOT: 'screenshot',
	CONTENT_EXTRACTOR: 'content-extractor',
	DATA_SOURCE: 'data-source',
	PIPELINE: 'pipeline',
	PIPELINE_MODIFIER: 'pipeline-modifier',
	FORM_SCHEMA_PROVIDER: 'form-schema-provider',
	DEPLOYMENT: 'deployment',
	GIT_PROVIDER: 'git-provider',
	OAUTH: 'oauth'
} as const;
```

### Capability Interfaces

Each capability maps to a TypeScript interface that the plugin must implement:

| Capability             | Interface                 | Required Methods                                                                                                                      |
| ---------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ai-provider`          | `IAiProviderPlugin`       | `createChatCompletion()`, `listModels()`, `getModel()`, `isAvailable()`, `getCapabilities()`                                          |
| `search`               | `ISearchPlugin`           | `search()`, `isAvailable()`                                                                                                           |
| `content-extractor`    | `IContentExtractorPlugin` | `extract()`, `isAvailable()`                                                                                                          |
| `screenshot`           | `IScreenshotPlugin`       | `capture()`, `isAvailable()`                                                                                                          |
| `data-source`          | `IDataSourcePlugin`       | `query()`, `isAvailable()`                                                                                                            |
| `pipeline`             | `IPipelinePlugin`         | `getStepDefinitions()`, `execute()`                                                                                                   |
| `pipeline-modifier`    | `IPipelineModifierPlugin` | `execute()`, `targetPipelines`                                                                                                        |
| `git-provider`         | `IGitProviderPlugin`      | `getAuth()`, `getCloneUrl()`, `createRepository()`, `getRepository()`, `createPullRequest()`, `mergePullRequest()` + `IGitOperations` |
| `deployment`           | `IDeploymentPlugin`       | `deploy()`, `getDeploymentStatus()`                                                                                                   |
| `oauth`                | `IOAuthPlugin`            | `getOAuthConfig()`, `exchangeCode()`, `getUser()`                                                                                     |
| `form-schema-provider` | `IFormSchemaProvider`     | `getFormFields()`, `getFormGroups()`                                                                                                  |

### Type Guards

The plugin system provides type guard functions for each capability:

```typescript
import {
	isAiProviderPlugin,
	isSearchPlugin,
	isContentExtractorPlugin,
	isScreenshotPlugin,
	isDataSourcePlugin,
	isPipelinePlugin,
	isPipelineModifierPlugin,
	isGitProviderPlugin,
	isDeploymentPlugin
} from '@ever-works/plugin';

// Usage in facade or platform code
if (isSearchPlugin(plugin)) {
	const results = await plugin.search({ query: 'example' });
}
```

## Selectable Provider Categories

Certain capabilities are selectable in the generator form UI. These are defined by `SELECTABLE_PROVIDER_CATEGORIES`:

```typescript
const SELECTABLE_PROVIDER_CATEGORIES = {
	search: { capability: 'search', uiKey: 'search', selectableInForm: true },
	screenshot: { capability: 'screenshot', uiKey: 'screenshot', selectableInForm: true },
	ai: { capability: 'ai-provider', uiKey: 'ai', selectableInForm: true },
	contentExtractor: { capability: 'content-extractor', uiKey: 'contentExtractor', selectableInForm: true },
	pipeline: { capability: 'pipeline', uiKey: 'pipeline', selectableInForm: true }
} as const;
```

When a user creates a work, they can select which plugin to use for each selectable category. Plugins that declare `defaultForCapabilities` in their manifest are pre-selected.

## Plugin Visibility

Each plugin can set a visibility level in its manifest:

| Visibility  | Behavior                                                               |
| ----------- | ---------------------------------------------------------------------- |
| `public`    | Shown to all users in all plugin lists (default)                       |
| `hidden`    | Never shown in the plugin UI; used for internal infrastructure plugins |
| `user-only` | Shown in user plugin settings but not in work plugin lists        |

### Supplementary Plugins

Plugins with `supplementary: true` in their manifest are excluded from manual provider selection dropdowns. They still declare their capability and auto-activate through URL-based routing in the facade layer. This is used for narrow-scope extractors like the Notion Extractor (activates only for `notion.so` URLs) and the PDF Extractor (activates only for `.pdf` URLs).

## Multi-Capability Plugins

A single plugin can implement multiple capabilities. This is common for search and content extraction:

| Plugin            | Capabilities                       |
| ----------------- | ---------------------------------- |
| Exa               | `search`, `content-extractor`      |
| Tavily            | `search`, `content-extractor`      |
| Firecrawl         | `search`, `content-extractor`      |
| Bright Data       | `search`, `content-extractor`      |
| Scrapfly          | `screenshot`, `content-extractor`  |
| GitHub            | `git-provider`, `oauth`            |
| Standard Pipeline | `pipeline`, `form-schema-provider` |
| Agent Pipeline    | `pipeline`, `form-schema-provider` |

When a plugin provides multiple capabilities, the manifest's `defaultForCapabilities` array specifies which capabilities it should be the default provider for:

```typescript
// A plugin with multiple capabilities, default for only one
{
  capabilities: ['search', 'content-extractor'],
  defaultForCapabilities: ['search']
}
```

## Configuration Modes

Every plugin declares a `configurationMode` that determines how its settings are managed:

| Mode            | Description                                                          |
| --------------- | -------------------------------------------------------------------- |
| `admin-only`    | Only platform admins can configure the plugin                        |
| `user-required` | Each user must provide their own credentials (e.g., API keys)        |
| `hybrid`        | Admins set global defaults; users can override with their own values |

Most AI provider plugins use `user-required` since users provide their own API keys. Infrastructure plugins like GitHub use `hybrid` with admin-level OAuth app credentials and user-level tokens.
