import type {
	IPlugin,
	IFormSchemaProvider,
	PluginCategory,
	PluginContext,
	PluginSettings,
	PluginManifest,
	JsonSchema,
	ValidationResult,
	PluginHealthCheck
} from '@ever-works/plugin';
import type { FormFieldDefinition, FormFieldGroup } from '@ever-works/contracts';
import { DEFAULT_COMPARISON_SETTINGS } from './types.js';

export class ComparisonGeneratorPlugin implements IPlugin, IFormSchemaProvider {
	readonly id = 'comparison-generator';
	readonly name = 'Comparison Generator';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'utility';
	readonly capabilities = ['form-schema-provider'] as const;
	readonly configurationMode = 'admin-only' as const;

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			cadence_override: {
				type: 'string',
				title: 'Generation Cadence',
				description: 'How often to auto-generate comparisons',
				enum: ['use_directory', 'daily', 'weekly', 'monthly'],
				default: 'use_directory'
			},
			max_comparisons_mode: {
				type: 'string',
				title: 'Max Comparisons Mode',
				description: 'Whether to cap comparisons at a custom limit or generate all possible pairs',
				enum: ['custom', 'unlimited'],
				default: 'custom'
			},
			max_comparisons: {
				type: 'number',
				title: 'Max Comparisons',
				description: 'Maximum total comparisons to generate (only used in Custom mode)',
				default: 50,
				minimum: 1,
				maximum: 500,
				'x-showIf': { field: 'max_comparisons_mode', value: 'custom' }
			},
			min_items_for_comparison: {
				type: 'number',
				title: 'Min Items for Comparison',
				description: 'Minimum items in a category before generating comparisons',
				default: 3,
				minimum: 2,
				maximum: 20
			}
		}
	};

	private context?: PluginContext;

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		context.logger.log('Comparison Generator plugin loaded');
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async validateSettings(settings: PluginSettings): Promise<ValidationResult> {
		const errors: Array<{ path: string; message: string }> = [];

		if (
			settings.max_comparisons_mode !== undefined &&
			!['custom', 'unlimited'].includes(settings.max_comparisons_mode as string)
		) {
			errors.push({ path: 'max_comparisons_mode', message: 'Must be "custom" or "unlimited"' });
		}

		if (settings.max_comparisons !== undefined && settings.max_comparisons_mode !== 'unlimited') {
			const max = Number(settings.max_comparisons);
			if (isNaN(max) || max < 1 || max > 500) {
				errors.push({ path: 'max_comparisons', message: 'Max comparisons must be between 1 and 500' });
			}
		}

		if (settings.min_items_for_comparison !== undefined) {
			const min = Number(settings.min_items_for_comparison);
			if (isNaN(min) || min < 2 || min > 20) {
				errors.push({
					path: 'min_items_for_comparison',
					message: 'Min items must be between 2 and 20'
				});
			}
		}

		if (
			settings.cadence_override !== undefined &&
			!['use_directory', 'daily', 'weekly', 'monthly'].includes(settings.cadence_override as string)
		) {
			errors.push({
				path: 'cadence_override',
				message: 'Invalid cadence value'
			});
		}

		return errors.length > 0 ? { valid: false, errors } : { valid: true };
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		return {
			status: 'healthy',
			message: 'Comparison Generator plugin is ready',
			checkedAt: Date.now()
		};
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description: 'Auto-generates SEO-optimized A vs B comparison pages between directory items',
			category: this.category,
			capabilities: [...this.capabilities],
			author: { name: 'Ever Works Team' },
			license: 'MIT',
			builtIn: true,
			systemPlugin: true,
			autoEnable: false,
			visibility: 'public',
			readme: [
				'## What is the Comparison Generator?',
				'',
				'The Comparison Generator is a system plugin that automatically creates detailed A vs B comparison pages between items in your directories. Each comparison includes structured dimensions with scores, a verdict, and a full SEO-optimized markdown article.',
				'',
				'## How it works',
				'',
				"1. **Pair selection** — the plugin analyzes items within each category and picks the most relevant pairs that haven't been compared yet",
				'2. **Research** — gathers information about both items using configured search and content-extraction plugins',
				'3. **Comparison generation** — uses your AI provider to produce a structured comparison with dimensions, scores, and a verdict',
				'4. **Article writing** — generates a full markdown article suitable for publishing as a standalone comparison page',
				'',
				'## Features',
				'',
				'- **Scheduled generation** — runs automatically based on your directory schedule or a custom cadence (daily, weekly, monthly)',
				'- **Manual comparisons** — pick any two items and generate a comparison on demand from the Comparisons tab',
				'- **Dimension scoring** — each comparison breaks down into multiple dimensions with per-item scores and summaries',
				'- **Duplicate prevention** — tracks previously generated pairs so no comparison is repeated',
				'- **Source attribution** — includes references to the sources used during research',
				'',
				'## Configuration',
				'',
				'Enable comparison generation per directory from the directory Generator settings. You can configure:',
				'',
				'- **Cadence** — how often to auto-generate a new comparison (or follow the directory schedule)',
				'- **Max comparisons** — cap at a custom limit (1–500) or set to "All" to generate every possible pair',
				'- **Min items** — minimum items required in a category before comparisons are generated'
			].join('\n')
		};
	}

	getFormFields(): FormFieldDefinition[] {
		return [
			{
				name: 'comparison_enabled',
				type: 'boolean',
				label: 'Generate Comparisons',
				description: 'Enable A vs B comparison page generation for this directory',
				defaultValue: false,
				group: 'comparisons'
			},
			{
				name: 'comparison_cadence',
				type: 'select',
				label: 'Comparison Cadence',
				description: 'How often to auto-generate a new comparison',
				options: [
					{ label: 'Use Directory Schedule', value: 'use_directory' },
					{ label: 'Daily', value: 'daily' },
					{ label: 'Weekly', value: 'weekly' },
					{ label: 'Monthly', value: 'monthly' }
				],
				defaultValue: 'use_directory',
				group: 'comparisons'
			},
			{
				name: 'comparison_max_mode',
				type: 'select',
				label: 'Max Comparisons',
				description: 'Limit the number of comparisons or generate all possible pairs',
				options: [
					{ label: 'Custom', value: 'custom' },
					{ label: 'Unlimited', value: 'unlimited' }
				],
				defaultValue: 'custom',
				group: 'comparisons'
			},
			{
				name: 'comparison_max',
				type: 'number',
				label: 'Max Comparisons Limit',
				description: 'Maximum number of comparisons to generate',
				defaultValue: 50,
				validation: { min: 1, max: 500 },
				showIf: { field: 'comparison_max_mode', operator: 'eq', value: 'custom' },
				group: 'comparisons'
			}
		];
	}

	getFormGroups(): FormFieldGroup[] {
		return [
			{
				name: 'comparisons',
				title: 'Comparison Pages',
				description: 'Configure automatic A vs B comparison page generation',
				collapsible: true,
				collapsed: true
			}
		];
	}

	validateFormInput(values: Record<string, unknown>): ValidationResult {
		const errors: Array<{ path: string; message: string }> = [];

		if (values.comparison_max !== undefined && values.comparison_max_mode !== 'unlimited') {
			const max = Number(values.comparison_max);
			if (isNaN(max) || max < 1 || max > 500) {
				errors.push({ path: 'comparison_max', message: 'Must be between 1 and 500' });
			}
		}

		return errors.length > 0 ? { valid: false, errors } : { valid: true };
	}

	getDefaultValues(): Record<string, unknown> {
		return {
			comparison_enabled: false,
			comparison_cadence: DEFAULT_COMPARISON_SETTINGS.cadence_override,
			comparison_max_mode: DEFAULT_COMPARISON_SETTINGS.max_comparisons_mode,
			comparison_max: DEFAULT_COMPARISON_SETTINGS.max_comparisons
		};
	}
}

export { ComparisonGeneratorPlugin as default };
