# Search Facade Service Design Document

> **Status:** Design complete. Implementation blocked on Story 2 (Plugin Runtime).
>
> This document captures the facade design for web search operations.

---

## Overview

The SearchFacade abstracts web search operations (Tavily, Exa, SerpAPI, etc.) behind the plugin system. It follows the generic facade pattern documented in [facade-architecture.md](./facade-architecture.md).

---

## Provider Resolution

Search provider selection follows the three-level configuration model:

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. USER LEVEL (Settings > Plugins)                                  │
│    - Install search plugins (Tavily, Exa, SerpAPI, etc.)            │
│    - Configure API keys                                             │
│    - Stored in: UserPlugin.settings.apiKey                          │
├─────────────────────────────────────────────────────────────────────┤
│ 2. DIRECTORY LEVEL (Directory > Apps)                               │
│    - Select DEFAULT search provider for this directory              │
│    - Override settings (max results, search depth, etc.)            │
│    - Stored in: DirectoryPlugin.settings.defaults['search']         │
├─────────────────────────────────────────────────────────────────────┤
│ 3. GENERATION LEVEL (Generator Form)                                │
│    - Override provider for THIS generation only                     │
│    - Configure search-specific options                              │
│    - Passed via: GenerationOptions.providers.search                 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Database Model (Plugin System)

### Token Storage: UserPlugin

```typescript
// UserPlugin for Tavily
{
    userId: 'user-123',
    pluginId: 'tavily',
    settings: {
        apiKey: 'tvly_xxxx...',  // Encrypted (secret: true)
        defaultSearchDepth: 'basic',
        includeDomains: [],
        excludeDomains: []
    },
    enabled: true
}
```

### Provider Selection: DirectoryPlugin

```typescript
// DirectoryPlugin for search
{
    directoryId: 'dir-456',
    pluginId: 'tavily',
    settings: {
        defaults: {
            'search': 'tavily'
        },
        // Directory-specific overrides
        maxResults: 10,
        searchDepth: 'advanced'
    },
    enabled: true
}
```

---

## SearchFacade Implementation

### Location

`packages/agent/src/facades/search.facade.ts`

### Interface Design

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { ISearchPlugin, SearchOptions, SearchResult, SearchResponse } from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/plugin-registry.service';
import { PluginSettingsService } from '../plugins/plugin-settings.service';

@Injectable()
export class SearchFacade {
	private readonly logger = new Logger(SearchFacade.name);

	constructor(
		private readonly registry: PluginRegistryService,
		private readonly settingsService: PluginSettingsService
	) {}

	// ========================================
	// PLUGIN RESOLUTION (Private)
	// ========================================

	private async getPlugin(directoryId: string, providerOverride?: string): Promise<ISearchPlugin> {
		const providerId =
			providerOverride ??
			(await this.settingsService.getDirectoryProvider(directoryId, 'search')) ??
			(await this.settingsService.getPlatformDefault('search'));

		if (!providerId) {
			throw new SearchProviderNotFoundError('No search provider configured');
		}

		const plugin = this.registry.getByCapability<ISearchPlugin>('search', providerId);

		if (!plugin) {
			throw new SearchProviderNotFoundError(providerId);
		}

		return plugin;
	}

	private async getSettings(userId: string, directoryId: string, pluginId: string): Promise<Record<string, unknown>> {
		return this.settingsService.resolveSettings(userId, directoryId, pluginId);
	}

	// ========================================
	// SEARCH OPERATIONS
	// ========================================

	/**
	 * Perform a web search.
	 */
	async search(
		query: string,
		options: SearchOptions,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<SearchResponse> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const settings = await this.getSettings(userId, directoryId, plugin.id);

		// Merge options with resolved settings
		const mergedOptions: SearchOptions = {
			maxResults: settings.maxResults ?? options.maxResults ?? 10,
			searchDepth: settings.searchDepth ?? options.searchDepth ?? 'basic',
			includeDomains: options.includeDomains ?? settings.includeDomains ?? [],
			excludeDomains: options.excludeDomains ?? settings.excludeDomains ?? [],
			...options
		};

		return plugin.search(query, mergedOptions, settings);
	}

	/**
	 * Perform multiple searches in parallel.
	 */
	async searchBulk(
		queries: string[],
		options: SearchOptions,
		directoryId: string,
		userId: string,
		providerOverride?: string
	): Promise<SearchResponse[]> {
		const plugin = await this.getPlugin(directoryId, providerOverride);
		const settings = await this.getSettings(userId, directoryId, plugin.id);

		// Execute searches in parallel
		return Promise.all(queries.map((query) => plugin.search(query, options, settings)));
	}

	/**
	 * Get available search providers for a user.
	 */
	async getAvailableProviders(userId: string): Promise<Array<{ id: string; name: string; configured: boolean }>> {
		const searchPlugins = this.registry.getByCapability<ISearchPlugin>('search');

		const providers = await Promise.all(
			searchPlugins.map(async ({ pluginId, plugin }) => {
				const settings = await this.settingsService.getUserPluginSettings(userId, pluginId);
				return {
					id: pluginId,
					name: plugin.name,
					configured: !!settings?.apiKey
				};
			})
		);

		return providers;
	}
}
```

---

## Error Types

```typescript
// packages/agent/src/facades/errors/search-facade.errors.ts

export class SearchFacadeError extends Error {
	constructor(
		message: string,
		public readonly operation: string,
		public readonly provider?: string,
		public readonly cause?: Error
	) {
		super(message);
		this.name = 'SearchFacadeError';
	}
}

export class SearchProviderNotFoundError extends SearchFacadeError {
	constructor(providerId: string) {
		super(`Search provider not found: ${providerId}`, 'getPlugin', providerId);
		this.name = 'SearchProviderNotFoundError';
	}
}

export class SearchApiKeyMissingError extends SearchFacadeError {
	constructor(providerId: string) {
		super(
			`No ${providerId} API key found. Please configure your ${providerId} API key.`,
			'getSettings',
			providerId
		);
		this.name = 'SearchApiKeyMissingError';
	}
}
```

---

## Integration with Content Extraction

Some search plugins (like Tavily) also implement `IContentExtractorPlugin`. The facade can provide unified access:

```typescript
// packages/agent/src/facades/search.facade.ts

/**
 * Extract content from a URL (if supported by provider).
 */
async extractContent(
    url: string,
    directoryId: string,
    userId: string,
    providerOverride?: string,
): Promise<ExtractedContent | null> {
    const plugin = await this.getPlugin(directoryId, providerOverride);
    const settings = await this.getSettings(userId, directoryId, plugin.id);

    // Check if plugin also implements content extraction
    if (!this.implementsContentExtractor(plugin)) {
        return null;
    }

    return (plugin as IContentExtractorPlugin).extract(url, settings);
}

private implementsContentExtractor(plugin: ISearchPlugin): plugin is ISearchPlugin & IContentExtractorPlugin {
    return 'extract' in plugin && typeof plugin.extract === 'function';
}
```

---

## Multi-Capability Plugins (Exa.ai)

The Exa.ai plugin provides both search and full pipeline capabilities:

```typescript
// Exa plugin sub-providers
{
    id: 'exa:search',
    name: 'Exa Search',
    capability: 'search',
    handledConfigFields: ['max_search_queries', 'max_results_per_query']
}

{
    id: 'exa:websets',
    name: 'Exa Websets',
    capability: 'full-pipeline',
    handledConfigFields: ['*']  // Handles ALL config
}
```

When `exa:search` is selected, only the search capability is used. When `exa:websets` is selected, the entire pipeline is replaced.

See [multi-provider-selection.md](./multi-provider-selection.md) for details.

---

## Migration Pattern

```typescript
// BEFORE - Hardcoded Tavily
constructor(private readonly tavilyService: TavilyService) {}

async searchWeb(query: string, apiKey: string) {
    return this.tavilyService.search(query, { apiKey });
}
```

```typescript
// AFTER - Plugin system with facade
constructor(private readonly searchFacade: SearchFacade) {}

async searchWeb(query: string, directory: Directory, user: User) {
    return this.searchFacade.search(
        query,
        { maxResults: 10 },
        directory.id,
        user.id,
    );
}
```

---

## Related Documentation

- [facade-architecture.md](./facade-architecture.md)
- [multi-provider-selection.md](./multi-provider-selection.md)
- [PLUGIN_SYSTEM_RFC.md - Generator Form Architecture](../PLUGIN_SYSTEM_RFC.md#generator-form-architecture)
