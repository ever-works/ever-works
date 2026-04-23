import type { FormFieldDefinition, FormFieldGroup, ValidationResult } from '@ever-works/plugin';

export const DEFAULT_TARGET_ITEMS = 50;

export function getFormFields(): FormFieldDefinition[] {
	return [
		{
			name: 'target_items',
			type: 'number',
			label: 'Target Items',
			description: 'Approximate number of items the managed agent should return.',
			defaultValue: DEFAULT_TARGET_ITEMS,
			validation: { min: 1, max: 250 },
			group: 'scope'
		},
		{
			name: 'capture_screenshots',
			type: 'boolean',
			label: 'Capture Screenshots',
			description: 'Use the configured screenshot provider to enrich generated items with images.',
			defaultValue: true,
			group: 'output'
		}
	];
}

export function getFormGroups(): FormFieldGroup[] {
	return [
		{
			name: 'scope',
			title: 'Generation Scope',
			description: 'How much content the managed agent should research and return.',
			order: 0
		},
		{
			name: 'output',
			title: 'Output Enrichment',
			description: 'Optional post-processing applied after the managed agent returns results.',
			order: 1,
			collapsible: true,
			collapsed: false
		}
	];
}

export function validateFormInput(values: Record<string, unknown>): ValidationResult {
	const targetItems = values.target_items;

	if (targetItems !== undefined) {
		if (typeof targetItems !== 'number' || !Number.isFinite(targetItems)) {
			return {
				valid: false,
				errors: [{ path: 'target_items', message: 'Target items must be a number.' }]
			};
		}

		if (targetItems < 1 || targetItems > 250) {
			return {
				valid: false,
				errors: [{ path: 'target_items', message: 'Target items must be between 1 and 250.' }]
			};
		}
	}

	return { valid: true };
}

export function getDefaultValues(fields: FormFieldDefinition[]): Record<string, unknown> {
	const defaults: Record<string, unknown> = {};

	for (const field of fields) {
		if (field.defaultValue !== undefined) {
			defaults[field.name] = field.defaultValue;
		}
	}

	return defaults;
}
