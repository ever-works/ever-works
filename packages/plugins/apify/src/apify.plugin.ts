import type {
	IPlugin,
	IDataSourcePlugin,
	IFormSchemaProvider,
	PluginContext,
	PluginCategory,
	PluginManifest,
	PluginHealthCheck,
	JsonSchema,
	ValidationResult,
	DataSourceQueryOptions,
	DataSourceQueryResult,
	DataSourceMetadata,
	ConnectionValidationResult
} from '@ever-works/plugin';
import { extractKeywords } from '@ever-works/plugin/keywords';
import type { FormFieldDefinition, FormFieldGroup, ItemData } from '@ever-works/contracts';

/**
 * Field mapping configuration for transforming Apify data to ItemData
 */
interface FieldMapping {
	name?: string;
	description?: string;
	source_url?: string;
	category?: string;
	image_url?: string;
	[key: string]: string | undefined;
}

/**
 * Apify Plugin
 *
 * Imports items from Apify datasets into directories.
 * Implements IDataSourcePlugin and IFormSchemaProvider.
 *
 * Configuration levels:
 * - Level 1: API token (Settings > Plugins)
 * - Level 2: Enable/disable per-directory (DirectoryPlugin entity)
 * - Level 3: Dataset ID, filters (GeneratorForm via IFormSchemaProvider)
 */
export class ApifyPlugin implements IPlugin, IDataSourcePlugin, IFormSchemaProvider {
	// ============================================================================
	// IPlugin Properties
	// ============================================================================

	readonly id = 'apify';
	readonly name = 'Apify';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'data-source';
	// IMPORTANT: Include BOTH capabilities
	readonly capabilities: readonly string[] = ['data-source', 'form-schema-provider'];

	/**
	 * Source name for facade identification
	 */
	readonly sourceName = 'Apify';

	/**
	 * Settings schema for admin/user-level settings.
	 * The API token is typically configured at admin or user level.
	 */
	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			apiToken: {
				type: 'string',
				title: 'Apify API Token',
				description: 'Your Apify API token (found in Settings > Integrations)',
				'x-secret': true,
				'x-scope': 'user'
			},
			defaultFieldMapping: {
				type: 'object',
				title: 'Default Field Mapping',
				description: 'Default mapping from Apify fields to item fields',
				properties: {
					name: { type: 'string', default: 'title' },
					description: { type: 'string', default: 'description' },
					source_url: { type: 'string', default: 'url' },
					category: { type: 'string', default: 'category' },
					image_url: { type: 'string', default: 'image' }
				}
			}
		}
	};

	/**
	 * NOT a system plugin - users must enable it explicitly
	 */
	readonly systemPlugin = false;

	/**
	 * NOT the default data source
	 */
	readonly isDefault = false;

	/**
	 * Config fields handled by this plugin (for GeneratorForm)
	 */
	readonly handledConfigFields: readonly string[] = [];

	private context?: PluginContext;

	// ============================================================================
	// IFormSchemaProvider - Adds form fields to GeneratorForm
	// ============================================================================

	/**
	 * Get form fields for the GeneratorForm (Level 3 configuration).
	 * Note: Enable/disable is at Level 2 (DirectoryPlugin), not here.
	 */
	getFormFields(): FormFieldDefinition[] {
		return [
			{
				name: 'apify_datasetId',
				type: 'text',
				label: 'Dataset ID',
				description: 'The Apify dataset ID to import items from',
				placeholder: 'e.g., 5uxB4x3zYjV5S7nFd',
				group: 'apify'
			},
			{
				name: 'apify_actorRunId',
				type: 'text',
				label: 'Actor Run ID (alternative)',
				description: 'Import from a specific actor run instead of a dataset',
				placeholder: 'Leave empty to use Dataset ID',
				group: 'apify'
			},
			{
				name: 'apify_maxItems',
				type: 'number',
				label: 'Maximum Items',
				description: 'Limit the number of items to import (0 = no limit)',
				defaultValue: 100,
				group: 'apify',
				validation: { min: 0, max: 10000 }
			},
			{
				name: 'apify_filterByRelevance',
				type: 'boolean',
				label: 'Filter by Relevance',
				description: 'Only import items relevant to the directory prompt',
				defaultValue: true,
				group: 'apify'
			}
		];
	}

	getFormGroups(): FormFieldGroup[] {
		return [
			{
				name: 'apify',
				title: 'Apify',
				description: 'Import items from Apify datasets',
				collapsible: true,
				collapsed: true,
				order: 100 // Show after default pipeline fields
			}
		];
	}

	validateFormInput(values: Record<string, unknown>): ValidationResult {
		const datasetId = values['apify_datasetId'] as string | undefined;
		const actorRunId = values['apify_actorRunId'] as string | undefined;

		// Either datasetId or actorRunId must be provided when plugin is enabled at Level 2
		if (!datasetId && !actorRunId) {
			return {
				valid: false,
				errors: [
					{
						path: 'apify_datasetId',
						message: 'Either Dataset ID or Actor Run ID is required'
					}
				]
			};
		}

		return { valid: true };
	}

	transformFormValues(values: Record<string, unknown>): Record<string, unknown> {
		return {
			...values,
			apify: {
				datasetId: values['apify_datasetId'],
				actorRunId: values['apify_actorRunId'],
				maxItems: values['apify_maxItems'] ?? 100,
				filterByRelevance: values['apify_filterByRelevance'] ?? true
			}
		};
	}

	getDefaultValues(): Record<string, unknown> {
		return {
			apify_maxItems: 100,
			apify_filterByRelevance: true
		};
	}

	// ============================================================================
	// IDataSourcePlugin - Query items from Apify
	// ============================================================================

	/**
	 * Query items from Apify dataset.
	 *
	 * This method is called by DataSourceFacade.queryAll() when:
	 * 1. The plugin is installed and enabled (plugin state = 'enabled')
	 * 2. The user checked "Enable Apify" in GeneratorForm (pluginConfig.enabled = true)
	 */
	async query(options?: DataSourceQueryOptions): Promise<DataSourceQueryResult> {
		const settings = options?.settings as Record<string, unknown> | undefined;

		// Get API token from resolved settings
		const apiToken = settings?.apiToken as string | undefined;
		if (!apiToken) {
			this.context?.logger.error('Apify API token not configured');
			return { items: [], hasMore: false };
		}

		// Get dataset/actor run ID from settings (passed via pluginConfig)
		const datasetId = settings?.datasetId as string | undefined;
		const actorRunId = settings?.actorRunId as string | undefined;
		const maxItems = (settings?.maxItems as number) ?? 100;
		const filterByRelevance = (settings?.filterByRelevance as boolean) ?? true;

		if (!datasetId && !actorRunId) {
			this.context?.logger.error('No Apify dataset ID or actor run ID provided');
			return { items: [], hasMore: false };
		}

		try {
			// Build API URL
			const baseUrl = datasetId
				? `https://api.apify.com/v2/datasets/${datasetId}/items`
				: `https://api.apify.com/v2/actor-runs/${actorRunId}/dataset/items`;

			const url = new URL(baseUrl);
			url.searchParams.set('token', apiToken);
			if (maxItems > 0) {
				url.searchParams.set('limit', maxItems.toString());
			}

			// Fetch data from Apify
			const response = await fetch(url.toString());
			if (!response.ok) {
				throw new Error(`Apify API error: ${response.status} ${response.statusText}`);
			}

			const data = await response.json();
			if (!Array.isArray(data)) {
				throw new Error('Unexpected Apify API response format');
			}

			// Get field mapping
			const fieldMapping = (settings?.defaultFieldMapping as FieldMapping) ?? {
				name: 'title',
				description: 'description',
				source_url: 'url',
				category: 'category',
				image_url: 'image'
			};

			// Transform Apify items to ItemData format
			let items = data.map((item: Record<string, unknown>) => this.mapToItemData(item, fieldMapping));

			this.context?.logger.log(`Apify: fetched ${items.length} items from dataset`);

			// Filter by relevance if enabled and filterContext provided
			if (filterByRelevance && options?.filterContext) {
				const originalCount = items.length;
				items = this.filterByRelevance(items, options.filterContext);
				this.context?.logger.log(`Apify: filtered from ${originalCount} to ${items.length} relevant items`);
			}

			return {
				items: items as unknown as readonly ItemData[],
				total: items.length,
				hasMore: false // We fetched all items up to the limit
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.context?.logger.error(`Apify query failed: ${errorMessage}`);
			return { items: [], hasMore: false };
		}
	}

	async getMetadata(): Promise<DataSourceMetadata> {
		return {
			name: 'Apify',
			description: 'Import items from Apify datasets and actor runs'
		};
	}

	/**
	 * Check if the data source is available.
	 * Returns true if the plugin is properly configured.
	 */
	async isAvailable(): Promise<boolean> {
		if (!this.context) return false;
		const settings = await this.context.getSettings();
		return Boolean(settings?.apiToken);
	}

	async validateConnection(settings: Record<string, unknown>): Promise<ConnectionValidationResult> {
		const apiToken = settings.apiToken as string | undefined;
		if (!apiToken) {
			return { success: false, message: 'Apify API token is not configured.' };
		}

		try {
			const response = await fetch(`https://api.apify.com/v2/users/me?token=${apiToken}`);

			if (!response.ok) {
				return {
					success: false,
					message: `Apify connection failed (${response.status}): ${response.statusText}`
				};
			}

			return { success: true, message: 'Apify connection verified.' };
		} catch (error) {
			return {
				success: false,
				message: `Apify connection failed: ${error instanceof Error ? error.message : String(error)}`
			};
		}
	}

	// ============================================================================
	// Private Helper Methods
	// ============================================================================

	/**
	 * Map an Apify item to ItemData format using field mapping.
	 */
	private mapToItemData(item: Record<string, unknown>, mapping: FieldMapping): Partial<ItemData> {
		const getValue = (key: string): string | undefined => {
			const mappedKey = mapping[key];
			if (!mappedKey) return undefined;
			const value = item[mappedKey];
			return typeof value === 'string' ? value : undefined;
		};

		const name = getValue('name') || String(item.title || item.name || 'Untitled');
		const imageUrl = getValue('image_url');

		return {
			name,
			slug: this.generateSlug(name),
			description: getValue('description') || '',
			source_url: getValue('source_url') || '',
			category: getValue('category'),
			// ItemData uses images[] array instead of image_url
			images: imageUrl ? [imageUrl] : undefined
		};
	}

	private generateSlug(name: string): string {
		return name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
			.substring(0, 100);
	}

	/**
	 * Filter items by relevance to the directory's prompt/domain.
	 * Uses basic keyword matching for now.
	 */
	private filterByRelevance(
		items: Partial<ItemData>[],
		filterContext: NonNullable<DataSourceQueryOptions['filterContext']>
	): Partial<ItemData>[] {
		const { prompt, subject, keywords } = filterContext;

		// Build keyword set from all sources
		const keywordSet = new Set<string>();

		if (keywords) {
			keywords.forEach((k) => keywordSet.add(k.toLowerCase()));
		}

		if (subject || prompt) {
			const extracted = extractKeywords([subject, prompt].filter(Boolean).join(' '), { maxKeywords: 15 });
			extracted.forEach((k) => keywordSet.add(k));
		}

		// If no keywords, return all items
		if (keywordSet.size === 0) {
			return items;
		}

		// Filter items that contain at least one keyword
		return items.filter((item) => {
			const text = `${item.name} ${item.description}`.toLowerCase();
			return Array.from(keywordSet).some((keyword) => text.includes(keyword));
		});
	}

	// ============================================================================
	// IPlugin Lifecycle
	// ============================================================================

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Apify Plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Apify plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Import data from Apify web scraping datasets into your directory',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: false,
			systemPlugin: false,
			homepage: 'https://apify.com',
			icon: {
				type: 'svg',
				value: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>'
			},
			readme: [
				'## What does the Apify plugin do?',
				'',
				'Apify is a web scraping and automation platform. This plugin imports items from Apify datasets into your directory, enabling you to transform existing scraped data into structured directory content.',
				'',
				'## Why use it?',
				'',
				'- **Bulk import** — import hundreds or thousands of items from an existing Apify dataset',
				'- **Field mapping** — map Apify result fields (title, URL, description) to directory item fields',
				'- **Relevance filtering** — automatically filter imported items by relevance to your directory topic',
				'- **Compatible with any actor** — import data from any Apify actor or dataset',
				'',
				'## How it works in Ever Works',
				'',
				'During directory generation, the data source facade queries the Apify plugin to fetch items from your specified dataset or actor run. The results are fed into the generation pipeline alongside other data sources. You can enable relevance filtering to ensure only topically relevant items are included.',
				'',
				'## Getting started',
				'',
				'1. Create an Apify account at [apify.com](https://apify.com)',
				'2. Run an actor or prepare a dataset with the items you want to import',
				'3. Enable the Apify plugin on this page and enter your API token',
				'4. When creating a directory, provide your dataset ID in the Apify section of the generation form'
			].join('\n')
		};
	}
}

export default ApifyPlugin;
