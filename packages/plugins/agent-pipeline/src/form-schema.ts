import type { FormFieldDefinition, FormFieldGroup, ValidationResult } from '@ever-works/plugin';

export function getFormFields(): FormFieldDefinition[] {
	return [
		{
			name: 'source_urls',
			type: 'tags',
			label: 'Source URLs',
			description: 'URLs to seed the agent with for initial research',
			placeholder: 'https://example.com/products',
			group: 'sources'
		},
		{
			name: 'max_items',
			type: 'number',
			label: 'Max Items',
			description: 'Maximum number of items to generate',
			defaultValue: 50,
			validation: { min: 1, max: 500 },
			group: 'volume'
		},
		{
			name: 'capture_screenshots',
			type: 'boolean',
			label: 'Capture Screenshots',
			description: 'Take screenshots for generated items',
			defaultValue: true,
			group: 'features'
		}
	];
}

export function getFormGroups(): FormFieldGroup[] {
	return [
		{
			name: 'sources',
			title: 'Data Sources',
			description: 'Configure initial URLs for research',
			order: 1,
			collapsible: true,
			collapsed: true
		},
		{
			name: 'volume',
			title: 'Volume Control',
			description: 'Control the number of items generated',
			order: 2,
			collapsible: true,
			collapsed: true
		},
		{
			name: 'features',
			title: 'Generation Features',
			description: 'Enable or disable generation features',
			order: 3,
			collapsible: true,
			collapsed: true
		}
	];
}

export function validateFormInput(values: Record<string, unknown>): ValidationResult {
	const errors: Array<{ path: string; message: string }> = [];

	const maxItems = values.max_items;
	if (maxItems !== undefined && maxItems !== null) {
		const num = Number(maxItems);
		if (isNaN(num)) {
			errors.push({ path: 'max_items', message: 'max_items must be a number' });
		} else if (num < 1 || num > 500) {
			errors.push({ path: 'max_items', message: 'max_items must be between 1 and 500' });
		}
	}

	const sourceUrls = values.source_urls;
	if (Array.isArray(sourceUrls)) {
		for (let i = 0; i < sourceUrls.length; i++) {
			const url = sourceUrls[i];
			if (typeof url === 'string' && url.trim()) {
				try {
					new URL(url);
				} catch {
					errors.push({ path: `source_urls[${i}]`, message: `Invalid URL: ${url}` });
				}
			}
		}
	}

	return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
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
