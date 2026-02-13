import type { FormFieldDefinition, FormFieldGroup, ValidationResult } from '@ever-works/plugin';

export function getFormFields(): FormFieldDefinition[] {
	return [
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
