import type { FormFieldDefinition, FormFieldGroup, ValidationResult } from '@ever-works/plugin';
import { DEFAULT_TARGET_ITEMS } from './types.js';

const REPO_ACCESS_CONDITION = { field: 'pass_repo_access', operator: 'eq' as const, value: true };

export function getFormFields(): FormFieldDefinition[] {
	return [
		{
			name: 'workflow_id',
			type: 'text',
			label: 'SIM Workflow ID',
			description: 'The deployed SIM workflow to execute for item generation',
			validation: { required: true },
			placeholder: 'e.g., wf_abc123...',
			group: 'workflow'
		},
		{
			name: 'execution_mode',
			type: 'select',
			label: 'Execution Mode',
			description: 'Async is recommended for workflows that take longer than 30 seconds',
			options: [
				{ label: 'Async (recommended)', value: 'async' },
				{ label: 'Sync (fast workflows only)', value: 'sync' }
			],
			defaultValue: 'async',
			group: 'workflow'
		},
		{
			name: 'target_items',
			type: 'number',
			label: 'Target Items',
			description: 'Target number of new items to generate',
			defaultValue: DEFAULT_TARGET_ITEMS,
			validation: { min: 1, max: 500 },
			group: 'workflow'
		},
		{
			name: 'pass_existing_items',
			type: 'boolean',
			label: 'Pass Existing Items Summary',
			description: 'Include a summary of existing directory items in workflow input for deduplication',
			defaultValue: true,
			group: 'data'
		},
		{
			name: 'pass_repo_access',
			type: 'boolean',
			label: 'Pass Data Repository Access',
			description: 'Grant the SIM workflow read access to the directory data repository',
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
			name: 'workflow_params',
			type: 'json',
			label: 'Custom Workflow Parameters',
			description: 'Additional key-value parameters to pass to the SIM workflow',
			defaultValue: {},
			group: 'advanced'
		}
	];
}

export function getFormGroups(): FormFieldGroup[] {
	return [
		{
			name: 'workflow',
			title: 'Workflow Configuration',
			description: 'Configure which SIM workflow to execute and how many items to generate',
			order: 0
		},
		{
			name: 'data',
			title: 'Data Passing',
			description: 'Configure how data is passed to the SIM workflow',
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
			description: 'Advanced workflow parameters',
			order: 3,
			collapsible: true,
			collapsed: true
		}
	];
}

export function validateFormInput(values: Record<string, unknown>): ValidationResult {
	if (!values.workflow_id || typeof values.workflow_id !== 'string' || values.workflow_id.trim() === '') {
		return { valid: false, errors: [{ path: 'workflow_id', message: 'SIM Workflow ID is required' }] };
	}

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
