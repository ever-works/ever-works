import type {
	IPlugin,
	IFormSchemaProvider,
	PluginCategory,
	PluginContext,
	PluginManifest,
	JsonSchema,
	ValidationResult,
	PluginHealthCheck
} from '@ever-works/plugin';
import type { FormFieldDefinition, FormFieldGroup } from '@ever-works/contracts';

export class ComparisonGeneratorPlugin implements IPlugin, IFormSchemaProvider {
	readonly id = 'comparison-generator';
	readonly name = 'Comparison Generator';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'utility';
	readonly capabilities = ['form-schema-provider'] as const;
	readonly configurationMode = 'hybrid' as const;

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
			},
			ai_provider: {
				type: 'string',
				title: 'AI Provider',
				description:
					'Override the AI provider used for comparison generation (leave empty for directory default)',
				'x-hidden': true
			},
			ai_model: {
				type: 'string',
				title: 'AI Model',
				description: 'Override the AI model used for comparison generation (leave empty for provider default)',
				'x-hidden': true
			},
			custom_prompt: {
				type: 'string',
				title: 'Custom Prompt',
				description: 'Additional instructions to append to comparison generation prompts',
				'x-hidden': true
			},
			extended_analysis: {
				type: 'boolean',
				title: 'Extended Analysis',
				description: 'When enabled, generates a deeper analysis alongside the standard comparison',
				default: false,
				'x-hidden': true
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
				label: 'Enable Comparisons',
				description: 'Automatically generate A vs B comparison pages between directory items',
				defaultValue: false,
				group: 'comparisons',
				order: 1
			},
			{
				name: 'comparison_cadence',
				type: 'select',
				label: 'Generation Cadence',
				description: 'How often to auto-generate comparisons',
				defaultValue: 'use_directory',
				options: [
					{ value: 'use_directory', label: 'Use Directory Schedule' },
					{ value: 'daily', label: 'Daily' },
					{ value: 'weekly', label: 'Weekly' },
					{ value: 'monthly', label: 'Monthly' }
				],
				group: 'comparisons',
				order: 2
			},
			{
				name: 'comparison_max_mode',
				type: 'select',
				label: 'Max Comparisons Mode',
				description: 'Whether to cap comparisons at a custom limit or generate all possible pairs',
				defaultValue: 'custom',
				options: [
					{ value: 'custom', label: 'Custom Limit' },
					{ value: 'unlimited', label: 'All Pairs' }
				],
				group: 'comparisons',
				order: 3
			},
			{
				name: 'comparison_max',
				type: 'number',
				label: 'Max Comparisons',
				description: 'Maximum total comparisons to generate (only used in Custom mode)',
				defaultValue: 50,
				validation: { min: 1, max: 500 },
				showIf: { field: 'comparison_max_mode', operator: 'eq', value: 'custom' },
				group: 'comparisons',
				order: 4
			}
		];
	}

	getFormGroups(): FormFieldGroup[] {
		return [
			{
				name: 'comparisons',
				title: 'Comparisons',
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
				errors.push({ path: 'comparison_max', message: 'Max comparisons must be between 1 and 500' });
			}
		}

		return errors.length > 0 ? { valid: false, errors } : { valid: true };
	}

	getDefaultValues(): Record<string, unknown> {
		return {
			comparison_enabled: false,
			comparison_cadence: 'use_directory',
			comparison_max_mode: 'custom',
			comparison_max: 50
		};
	}
}

export { ComparisonGeneratorPlugin as default };
