---
id: creating-a-plugin
title: Creating a Plugin
sidebar_label: Creating a Plugin
sidebar_position: 4
---

# Creating a Plugin

This guide walks through creating a new plugin from scratch. We'll build a search plugin as an example, but the same patterns apply to any plugin category.

## Category-Specific Guides

For detailed, category-specific instructions, see these dedicated guides:

| Category | Guide | What It Covers |
|----------|-------|----------------|
| AI Provider | [Creating an AI Provider Plugin](./creating-ai-provider-plugin) | `BaseAiProvider`, `AiOperations`, model tiers, embeddings |
| Search | [Creating a Search Plugin](./creating-search-plugin) | `ISearchPlugin`, filtering, pagination, dual-capability |
| Screenshot | [Creating a Screenshot Plugin](./creating-screenshot-plugin) | `IScreenshotPlugin`, capture, signed URLs, viewport config |
| Content Extractor | [Creating a Content Extractor Plugin](./creating-content-extractor-plugin) | `IContentExtractorPlugin`, general vs additive, batch extraction |
| Pipeline | [Creating a Pipeline Plugin](./creating-pipeline-plugin) | `IPipelinePlugin`, self-managed vs engine-orchestratable, modifiers |
| Deployment & Git | [Creating a Deployment Plugin](./creating-deployment-plugin) | `BaseGitProvider`, `IDeploymentPlugin`, OAuth |
| Data Source | [Creating a Data Source Plugin](./creating-data-source-plugin) | `IDataSourcePlugin`, field mapping, form schema |

The rest of this page covers the **common patterns** shared by all plugin categories.

## Directory Structure

Create a new directory under `packages/plugins/`:

```
packages/plugins/my-search/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts
    └── my-search.plugin.ts
```

## 1. package.json

The `everworks.plugin` field is how the platform discovers your plugin at startup:

```json
{
    "name": "@ever-works/my-search-plugin",
    "version": "1.0.0",
    "description": "My custom search plugin",
    "private": true,
    "type": "module",
    "main": "./dist/index.cjs",
    "module": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "exports": {
        ".": {
            "types": "./dist/index.d.ts",
            "import": "./dist/index.js",
            "require": "./dist/index.cjs"
        }
    },
    "scripts": {
        "build": "tsup",
        "dev": "tsup --watch",
        "type-check": "tsc --noEmit",
        "clean": "rm -rf dist",
        "test": "vitest run --passWithNoTests",
        "test:watch": "vitest"
    },
    "peerDependencies": {
        "@ever-works/plugin": "workspace:*"
    },
    "devDependencies": {
        "@ever-works/plugin": "workspace:*",
        "tsup": "^8.4.0",
        "typescript": "^5.7.3",
        "vitest": "^3.0.0"
    },
    "everworks": {
        "plugin": {
            "id": "my-search",
            "name": "My Search",
            "version": "1.0.0",
            "category": "search",
            "capabilities": ["search"],
            "description": "Custom web search provider.",
            "author": {
                "name": "Your Name"
            },
            "license": "MIT",
            "builtIn": true,
            "autoEnable": false,
            "envVars": [
                {
                    "name": "PLUGIN_MY_SEARCH_API_KEY",
                    "required": false,
                    "secret": true,
                    "description": "API key for My Search"
                }
            ]
        }
    }
}
```

Key fields in `everworks.plugin`:

| Field | Description |
|-------|-------------|
| `id` | Unique plugin identifier. Must match the `id` in your plugin class. |
| `category` | Primary category (see [Architecture](./architecture#plugin-categories)) |
| `capabilities` | Array of capabilities this plugin provides |
| `builtIn` | Set to `true` for plugins shipped with the platform |
| `autoEnable` | If `true`, the plugin is enabled by default for new users |
| `envVars` | Environment variables the plugin uses (for documentation and `.env.example`) |

## 2. tsup.config.ts

Build configuration for dual CJS/ESM output:

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    noExternal: ['@ever-works/plugin'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    splitting: false,
    treeshake: true,
});
```

## 3. tsconfig.json

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "declaration": true,
        "declarationMap": true,
        "sourceMap": true,
        "outDir": "./dist",
        "rootDir": "./src",
        "strict": true,
        "esModuleInterop": true,
        "skipLibCheck": true,
        "forceConsistentCasingInFileNames": true,
        "resolveJsonModule": true,
        "isolatedModules": true,
        "noEmit": true
    }
}
```

## 4. src/index.ts

Always export both named **and** default:

```typescript
export { MySearchPlugin } from './my-search.plugin.js';
export { MySearchPlugin as default } from './my-search.plugin.js';
```

:::warning
Use `.js` extensions in import paths, even though the source files are `.ts`. This is required for ESM module resolution.
:::

## 5. Plugin Class

Here's a complete search plugin implementation:

```typescript
import type {
    IPlugin,
    ISearchPlugin,
    PluginContext,
    PluginCategory,
    PluginManifest,
    PluginHealthCheck,
    JsonSchema,
    ValidationResult,
    PluginSettings,
    SearchOptions,
    SearchResponse,
    SearchResult,
    RateLimitInfo,
} from '@ever-works/plugin';

export class MySearchPlugin implements IPlugin, ISearchPlugin {
    // ── IPlugin Properties ──────────────────────────────────

    readonly id = 'my-search';
    readonly name = 'My Search';
    readonly version = '1.0.0';
    readonly category: PluginCategory = 'search';
    readonly capabilities: readonly string[] = ['search'];
    readonly providerName = 'My Search';
    readonly configurationMode: 'admin-only' | 'user-required' | 'hybrid' = 'hybrid';

    readonly settingsSchema: JsonSchema = {
        type: 'object',
        properties: {
            apiKey: {
                type: 'string',
                title: 'API Key',
                description: 'Your API key',
                'x-secret': true,
                'x-envVar': 'PLUGIN_MY_SEARCH_API_KEY',
                'x-scope': 'user',
            },
            maxResults: {
                type: 'number',
                title: 'Max Results',
                description: 'Maximum results per search',
                default: 10,
                minimum: 1,
                maximum: 50,
            },
        },
        required: ['apiKey'],
    };

    private context?: PluginContext;

    // ── Lifecycle ───────────────────────────────────────────

    async onLoad(context: PluginContext): Promise<void> {
        this.context = context;
        context.logger.log('My Search plugin loaded');
    }

    async onUnload(): Promise<void> {
        this.context = undefined;
    }

    async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
        const errors: Array<{ path: string; message: string }> = [];

        if (!settings.apiKey) {
            errors.push({ path: 'apiKey', message: 'API key is required' });
        }

        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
        };
    }

    async healthCheck(): Promise<PluginHealthCheck> {
        return {
            status: 'healthy',
            message: 'My Search plugin is ready',
            checkedAt: Date.now(),
        };
    }

    getManifest(): PluginManifest {
        return {
            id: this.id,
            name: this.name,
            version: this.version,
            description: 'Custom web search provider',
            category: this.category,
            capabilities: [...this.capabilities],
            author: { name: 'Your Name' },
            license: 'MIT',
            builtIn: true,
            autoEnable: false,
            icon: {
                type: 'svg',
                value: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
            },
        };
    }

    // ── ISearchPlugin Interface ─────────────────────────────

    async search(options: SearchOptions): Promise<SearchResponse> {
        const apiKey = options.settings?.apiKey as string;
        if (!apiKey) {
            throw new Error(
                'API key not configured. '
                + 'Set it in plugin settings or via PLUGIN_MY_SEARCH_API_KEY.',
            );
        }

        const startTime = Date.now();
        const maxResults = options.limit
            || (options.settings?.maxResults as number)
            || 10;

        // Use the context HTTP client for API calls
        const response = await this.context!.http.get<MyApiResponse>(
            `https://api.example.com/search?q=${encodeURIComponent(options.query)}&limit=${maxResults}`,
            {
                headers: { Authorization: `Bearer ${apiKey}` },
            },
        );

        const results: SearchResult[] = (response.data?.results || []).map(
            (r, index) => ({
                title: r.title,
                url: r.url,
                snippet: r.description,
                position: index + 1,
            }),
        );

        return {
            results,
            query: options.query,
            totalResults: results.length,
            hasMore: results.length >= maxResults,
            duration: Date.now() - startTime,
        };
    }

    async isAvailable(): Promise<boolean> {
        return true;
    }

    async getRateLimitInfo(): Promise<RateLimitInfo> {
        return { remaining: -1, limit: -1, period: 'month' };
    }
}

// Private types for the external API response
interface MyApiResponse {
    results: Array<{
        title: string;
        url: string;
        description: string;
    }>;
}

export default MySearchPlugin;
```

## Key Implementation Patterns

### Settings are resolved at call time

Settings are passed to capability methods via `options.settings`, **not** stored on the plugin instance. This allows different directories to use different configurations:

```typescript
async search(options: SearchOptions): Promise<SearchResponse> {
    // Always read settings from options — NOT from this.context
    const apiKey = options.settings?.apiKey as string;
    // ...
}
```

### Use the context HTTP client

Use `this.context!.http` instead of `fetch` or axios. The context HTTP client is instrumented for logging and monitoring:

```typescript
const response = await this.context!.http.get<MyResponse>(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
});
```

### Use the context logger

```typescript
this.context?.logger.log('Search completed');
this.context?.logger.error(`Search failed: ${error.message}`);
```

### Use the context cache

Cache expensive results with a TTL:

```typescript
const cacheKey = `search:${query}`;
const cached = await this.context!.cache.get<SearchResponse>(cacheKey);
if (cached) return cached;

const result = await this.performSearch(query);
await this.context!.cache.set(cacheKey, result, 300); // 5 minutes
return result;
```

## Building an AI Provider Plugin

AI provider plugins extend `BaseAiProvider` instead of implementing interfaces directly:

```typescript
import { BaseAiProvider } from '@ever-works/plugin/abstract';
import { AiOperations } from '@ever-works/plugin/ai';
import type {
    PluginContext,
    ChatCompletionOptions,
    ChatCompletionResponse,
    AiModel,
    AiModelCapabilities,
    PluginSettings,
} from '@ever-works/plugin';

export class MyAiPlugin extends BaseAiProvider {
    readonly id = 'my-ai';
    readonly name = 'My AI Provider';
    readonly version = '1.0.0';
    readonly providerType = 'my-ai';
    readonly providerName = 'My AI';
    readonly configurationMode = 'user-required' as const;

    readonly settingsSchema = {
        type: 'object' as const,
        properties: {
            apiKey: {
                type: 'string' as const,
                title: 'API Key',
                'x-secret': true,
                'x-scope': 'user' as const,
            },
            defaultModel: {
                type: 'string' as const,
                title: 'Default Model',
                default: 'my-model-v1',
                'x-widget': 'model-select',
            },
        },
        required: ['apiKey'] as const,
    };

    async onLoad(context: PluginContext): Promise<void> {
        await super.onLoad(context);
        this.aiOps = new AiOperations({
            apiKey: '',
            model: 'my-model-v1',
            providerType: 'custom',
            baseURL: 'https://api.example.com/v1',
        });
    }

    async createChatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
        if (!this.aiOps) throw new Error('Plugin not loaded');
        const config = this.resolveConfig(options.settings);
        return this.aiOps.createChatCompletion(options, config);
    }

    async listModels(settings?: PluginSettings): Promise<readonly AiModel[]> {
        if (!this.aiOps) throw new Error('Plugin not loaded');
        return this.aiOps.listModels(this.resolveConfig(settings));
    }

    getCapabilities(): AiModelCapabilities {
        return {
            supportsStructuredOutput: true,
            supportsStreaming: true,
            supportsToolCalling: false,
            supportsVision: false,
            maxContextLength: 32000,
        };
    }

    protected getDefaultModelId(): string {
        return 'my-model-v1';
    }
}
```

`BaseAiProvider` gives you `resolveConfig()`, `askJson()`, streaming fallback, model listing, and availability checking for free.

## Building a Pipeline Step Plugin

Pipeline steps extend `BasePipelineStep`:

```typescript
import { BasePipelineStep } from '@ever-works/plugin/abstract';
import type { MutableGenerationContext, StepExecutionOptions, StepProgressCallback } from '@ever-works/plugin';

export class MyPipelineStep extends BasePipelineStep {
    readonly id = 'my-step';
    readonly name = 'My Pipeline Step';
    readonly version = '1.0.0';

    readonly stepId = 'my-custom-step';
    readonly stepName = 'Custom Processing';
    readonly stepDescription = 'Applies custom processing to generated items';
    readonly stepPosition = BasePipelineStep.after('format');

    readonly provides = ['customData'];
    readonly requires = ['items'];

    async execute(
        context: MutableGenerationContext,
        options?: StepExecutionOptions,
        onProgress?: StepProgressCallback,
    ): Promise<MutableGenerationContext> {
        this.reportProgress(onProgress, this.createProgress('running', 0, 'Starting...'));

        // Process items
        for (let i = 0; i < context.items.length; i++) {
            context.items[i].customData = await this.process(context.items[i]);
            this.reportProgress(onProgress, this.createProgress(
                'running', (i + 1) / context.items.length * 100, `Processed ${i + 1} items`,
            ));
        }

        this.reportProgress(onProgress, this.createProgress('completed', 100, 'Done'));
        return context;
    }
}
```

Step positioning options:

| Method | Effect |
|--------|--------|
| `BasePipelineStep.after('stepId')` | Run after the specified step |
| `BasePipelineStep.before('stepId')` | Run before the specified step |
| `BasePipelineStep.replace('stepId')` | Replace the specified step |
| `BasePipelineStep.first()` | Run as the first step |
| `BasePipelineStep.last()` | Run as the last step |

## Build and Test

```bash
# Install dependencies
pnpm install

# Build your plugin
pnpm build --filter=@ever-works/my-search-plugin

# Type check
pnpm type-check --filter=@ever-works/my-search-plugin

# Run tests
pnpm test --filter=@ever-works/my-search-plugin

# Start the API — your plugin is auto-discovered
pnpm dev:api
```

The plugin is automatically discovered from `packages/plugins/my-search/` when the API starts. No manual registration is needed.

## Multiple Capabilities

A single plugin can provide multiple capabilities. For example, Tavily provides both `search` and `content-extractor`:

```typescript
export class TavilyPlugin implements IPlugin, ISearchPlugin, IContentExtractorPlugin {
    readonly capabilities: readonly string[] = ['search', 'content-extractor'];

    // ISearchPlugin methods
    async search(options: SearchOptions): Promise<SearchResponse> { /* ... */ }

    // IContentExtractorPlugin methods
    async extract(options: ContentExtractionOptions): Promise<ContentExtractionResult> { /* ... */ }
}
```

## Checklist

Before submitting a plugin:

- [ ] `id` in the plugin class matches `id` in `package.json` → `everworks.plugin.id`
- [ ] Both named and default exports in `index.ts`
- [ ] `.js` extensions in all import paths
- [ ] `x-secret: true` on all sensitive fields (API keys, tokens)
- [ ] `x-envVar` set for environment variable fallbacks
- [ ] `validateSettings()` checks all required fields
- [ ] `getManifest()` returns complete metadata with icon and description
- [ ] Settings read from `options.settings`, not cached on the instance
- [ ] Error messages include configuration instructions
- [ ] Plugin builds with `pnpm build`
- [ ] Plugin passes type checking with `pnpm type-check`
