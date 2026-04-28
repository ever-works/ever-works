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
		},
		{
			name: 'generation_notes',
			type: 'textarea',
			label: 'Generation Notes',
			description: 'Optional instructions to bias the Hermes run for this generation only',
			placeholder: 'Example: prioritize enterprise-focused tools with strong documentation.',
			group: 'features'
		}
	];
}

export function getFormGroups(): FormFieldGroup[] {
	return [
		{
			name: 'volume',
			title: 'Generation Volume',
			description: 'Control how many items Hermes should aim to produce',
			order: 0
		},
		{
			name: 'features',
			title: 'Generation Controls',
			description: 'Optional runtime controls for this Hermes generation',
			order: 1,
			collapsible: true,
			collapsed: false
		}
	];
}

export function validateFormInput(values: Record<string, unknown>): ValidationResult {
	const errors: Array<{ path: string; message: string }> = [];

	if (values.target_items !== undefined) {
		if (typeof values.target_items !== 'number' || !Number.isFinite(values.target_items)) {
			errors.push({ path: 'target_items', message: 'Target Items must be a number' });
		} else if (values.target_items < 1 || values.target_items > 500) {
			errors.push({ path: 'target_items', message: 'Target Items must be between 1 and 500' });
		}
	}

	if (values.capture_screenshots !== undefined && typeof values.capture_screenshots !== 'boolean') {
		errors.push({ path: 'capture_screenshots', message: 'Capture Screenshots must be a boolean' });
	}

	if (values.generation_notes !== undefined && typeof values.generation_notes !== 'string') {
		errors.push({ path: 'generation_notes', message: 'Generation Notes must be a string' });
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
