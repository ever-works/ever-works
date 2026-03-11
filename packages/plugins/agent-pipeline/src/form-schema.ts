import type { FormFieldDefinition, FormFieldGroup, ValidationResult } from '@ever-works/plugin';

export const DEFAULT_TARGET_ITEMS = 50;
export const DEFAULT_MAX_PAGES_TO_PROCESS = 20;

export function getFormFields(): FormFieldDefinition[] {
	return [
		{
			name: 'target_items',
			type: 'number',
			label: 'Target Items',
			description: 'Target number of new items to generate',
			defaultValue: DEFAULT_TARGET_ITEMS,
			validation: { min: 1, max: 500 },
			group: 'volume'
		},
		{
			name: 'max_pages_to_process',
			type: 'number',
			label: 'Max Pages to Process',
			description: 'Maximum number of URLs the agent will process in total',
			defaultValue: DEFAULT_MAX_PAGES_TO_PROCESS,
			validation: { min: 1, max: 1000 },
			group: 'search'
		},
		{
			name: 'capture_screenshots',
			type: 'boolean',
			label: 'Capture Screenshots',
			description: 'Take screenshots for generated items',
			defaultValue: false,
			group: 'features'
		}
	];
}

export function getFormGroups(): FormFieldGroup[] {
	return [
		{
			name: 'volume',
			title: 'Generation Volume',
			description: 'Control how many items to generate',
			order: 0
		},
		{
			name: 'search',
			title: 'Search Configuration',
			description: 'Control how many sources the agent processes',
			order: 1,
			collapsible: true,
			collapsed: true
		},
		{
			name: 'features',
			title: 'Generation Features',
			description: 'Enable or disable generation features',
			order: 2,
			collapsible: true,
			collapsed: true
		}
	];
}

export function validateFormInput(values: Record<string, unknown>): ValidationResult {
	const errors: Array<{ path: string; message: string }> = [];

	const rules = [
		{ name: 'target_items', min: 1, max: 500 },
		{ name: 'max_pages_to_process', min: 1, max: 1000 }
	];

	for (const rule of rules) {
		const value = values[rule.name];
		if (value !== undefined && value !== null) {
			const num = Number(value);
			if (isNaN(num)) {
				errors.push({ path: rule.name, message: `${rule.name} must be a number` });
			} else if (num < rule.min || num > rule.max) {
				errors.push({ path: rule.name, message: `${rule.name} must be between ${rule.min} and ${rule.max}` });
			}
		}
	}

	return errors.length > 0 ? { valid: false, errors } : { valid: true };
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
