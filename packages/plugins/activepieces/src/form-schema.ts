import type { FormFieldDefinition, FormFieldGroup, ValidationResult } from '@ever-works/plugin';
import { DEFAULT_TARGET_ITEMS } from './types.js';

const REPO_ACCESS_CONDITION = { field: 'pass_repo_access', operator: 'eq' as const, value: true };

export function getFormFields(): FormFieldDefinition[] {
	return [
		{
			name: 'flow_id',
			type: 'text',
			label: 'Activepieces Flow ID',
			description: 'Override the default flow for this generation (optional if set in plugin settings)',
			placeholder: 'e.g., 8h7g6f5e4d3c2b1a',
			group: 'flow'
		},
		{
			name: 'webhook_mode',
			type: 'select',
			label: 'Webhook Execution Mode',
			description:
				'Sync waits for the flow to finish; async returns immediately and is not supported by this pipeline',
			defaultValue: 'sync',
			options: [
				{ label: 'Synchronous (recommended)', value: 'sync' },
				{ label: 'Asynchronous', value: 'async' }
			],
			group: 'flow'
		},
		{
			name: 'target_items',
			type: 'number',
			label: 'Target Items',
			description: 'Target number of new items to generate',
			defaultValue: DEFAULT_TARGET_ITEMS,
			validation: { min: 1, max: 500 },
			group: 'flow'
		},
		{
			name: 'flow_timeout',
			type: 'number',
			label: 'Flow Timeout (minutes)',
			description: 'Maximum time to wait for the Activepieces flow to complete',
			defaultValue: 60,
			validation: { min: 1, max: 120 },
			group: 'flow'
		},
		{
			name: 'pass_existing_items',
			type: 'boolean',
			label: 'Pass Existing Items Summary',
			description: 'Include a summary of existing directory items in flow input for deduplication',
			defaultValue: true,
			group: 'data'
		},
		{
			name: 'pass_repo_access',
			type: 'boolean',
			label: 'Pass Data Repository Access',
			description: 'Grant the Activepieces flow read access to the directory data repository',
			defaultValue: false,
			group: 'data'
		},
		{
			name: 'repo_url',
			type: 'text',
			label: 'Data Repository URL',
			description: 'GitHub repository URL containing directory data',
			placeholder: 'e.g., https://github.com/org/repo',
			group: 'data',
			showIf: REPO_ACCESS_CONDITION,
			requiredIf: REPO_ACCESS_CONDITION
		},
		{
			name: 'repo_access_token',
			type: 'password',
			label: 'Repository Access Token',
			description: 'Read-only access token for the data repository (short-lived recommended)',
			placeholder: 'ghp_...',
			group: 'data',
			showIf: REPO_ACCESS_CONDITION,
			requiredIf: REPO_ACCESS_CONDITION
		},
		{
			name: 'repo_branch',
			type: 'text',
			label: 'Repository Branch',
			description: 'Branch to read from',
			defaultValue: 'data',
			group: 'data',
			showIf: REPO_ACCESS_CONDITION
		},
		{
			name: 'capture_screenshots',
			type: 'boolean',
			label: 'Capture Screenshots',
			description: 'Take screenshots for generated items (requires a screenshot plugin)',
			defaultValue: false,
			group: 'features'
		},
		{
			name: 'flow_params',
			type: 'json',
			label: 'Custom Flow Parameters',
			description: 'Additional key-value parameters to pass to the Activepieces flow',
			defaultValue: {},
			group: 'advanced'
		}
	];
}

export function getFormGroups(): FormFieldGroup[] {
	return [
		{
			name: 'flow',
			title: 'Flow Configuration',
			description: 'Configure which Activepieces flow to execute and how many items to generate',
			order: 0
		},
		{
			name: 'data',
			title: 'Data Passing',
			description: 'Configure how data is passed to the Activepieces flow',
			order: 1,
			collapsible: true,
			collapsed: false
		},
		{
			name: 'features',
			title: 'Features',
			description: 'Optional generation features',
			order: 2,
			collapsible: true,
			collapsed: true
		},
		{
			name: 'advanced',
			title: 'Advanced',
			description: 'Advanced flow parameters',
			order: 3,
			collapsible: true,
			collapsed: true
		}
	];
}

export function validateFormInput(values: Record<string, unknown>): ValidationResult {
	if (values.pass_repo_access) {
		if (!values.repo_url || typeof values.repo_url !== 'string' || values.repo_url.trim() === '') {
			return {
				valid: false,
				errors: [{ path: 'repo_url', message: 'Repository URL is required when repository access is enabled' }]
			};
		}
		if (
			!values.repo_access_token ||
			typeof values.repo_access_token !== 'string' ||
			values.repo_access_token.trim() === ''
		) {
			return {
				valid: false,
				errors: [
					{
						path: 'repo_access_token',
						message: 'Repository access token is required when repository access is enabled'
					}
				]
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
