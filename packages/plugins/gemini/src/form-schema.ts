import type { FormFieldDefinition, FormFieldGroup, ValidationResult } from '@ever-works/plugin';

export const DEFAULT_TARGET_ITEMS = 50;

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
			name: 'features',
			title: 'Generation Features',
			description: 'Enable or disable generation features',
			order: 1,
			collapsible: true,
			collapsed: true
		}
	];
}

export function validateFormInput(_values: Record<string, unknown>): ValidationResult {
	const errors: Array<{ path: string; message: string }> = [];
	const targetItems = _values.target_items;

	if (targetItems !== undefined && targetItems !== null) {
		const num = Number(targetItems);
		if (Number.isNaN(num)) {
			errors.push({ path: 'target_items', message: 'target_items must be a number' });
		} else if (num < 1 || num > 500) {
			errors.push({ path: 'target_items', message: 'target_items must be between 1 and 500' });
		}
	}

	const captureScreenshots = _values.capture_screenshots;
	if (captureScreenshots !== undefined && typeof captureScreenshots !== 'boolean') {
		errors.push({ path: 'capture_screenshots', message: 'capture_screenshots must be a boolean' });
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
