import type { FormFieldDefinition, FormFieldGroup, ValidationResult } from '@ever-works/plugin';
import { DEFAULT_TARGET_ITEMS } from './types.js';

const REPO_ACCESS_CONDITION = { field: 'pass_repo_access', operator: 'eq' as const, value: true };
const NATIVE_SHAPE_CONDITION = { field: 'result_shape', operator: 'eq' as const, value: 'native' };

export function getFormFields(): FormFieldDefinition[] {
	return [
		// ── Tool group ────────────────────────────────────────────────
		{
			name: 'toolkit',
			type: 'text',
			label: 'Composio Toolkit',
			description:
				'Toolkit slug for this generation (e.g. GMAIL, GITHUB, SLACK, NOTION, LINEAR). Used for connection validation only — the toolSlug uniquely identifies the action.',
			placeholder: 'e.g. GMAIL',
			group: 'tool'
		},
		{
			name: 'tool_slug',
			type: 'text',
			label: 'Composio Tool Slug',
			description:
				'Composio tool slug (e.g. GMAIL_SEND_EMAIL, GITHUB_CREATE_ISSUE, SLACK_SEND_MESSAGE). Unique across toolkits.',
			placeholder: 'e.g. GMAIL_SEND_EMAIL',
			group: 'tool'
		},
		{
			name: 'composio_user_id',
			type: 'text',
			label: 'Composio User ID',
			description:
				'Override the Composio user_id to run the tool against (defaults to your Ever Works user id). Use this if you connected the upstream account under a different identifier (typically an email).',
			placeholder: 'e.g. alice@example.com',
			group: 'tool'
		},
		{
			name: 'target_items',
			type: 'number',
			label: 'Target Items',
			description: 'Target number of new items to generate',
			defaultValue: DEFAULT_TARGET_ITEMS,
			validation: { min: 1, max: 500 },
			group: 'tool'
		},
		{
			name: 'tool_timeout',
			type: 'number',
			label: 'Tool Timeout (minutes)',
			description: 'Maximum time to wait for the Composio tool to complete',
			defaultValue: 10,
			validation: { min: 1, max: 120 },
			group: 'tool'
		},

		// ── Result shape & mapping ────────────────────────────────────
		{
			name: 'result_shape',
			type: 'select',
			label: 'Result Shape',
			description:
				'How the plugin should interpret the tool response. "Structured" expects { items: [...] }. "Native" maps raw records via the field mapping below. "Side-effect" runs the tool for its effect only (e.g. send email, post message) and produces no work items.',
			options: [
				{ value: 'structured', label: 'Structured ({ items: [...] })' },
				{ value: 'native', label: 'Native records (with field mapping)' },
				{ value: 'side-effect', label: 'Side-effect only (no items expected)' }
			],
			defaultValue: 'structured',
			group: 'mapping'
		},
		{
			name: 'name_field',
			type: 'text',
			label: 'Name Field',
			description: 'Path in each record that holds the item name (e.g. title, fields.name).',
			placeholder: 'e.g. subject or title',
			group: 'mapping',
			showIf: NATIVE_SHAPE_CONDITION,
			requiredIf: NATIVE_SHAPE_CONDITION
		},
		{
			name: 'url_field',
			type: 'text',
			label: 'URL Field',
			description: 'Path in each record that holds the item URL.',
			placeholder: 'e.g. html_url',
			group: 'mapping',
			showIf: NATIVE_SHAPE_CONDITION
		},
		{
			name: 'description_field',
			type: 'text',
			label: 'Description Field',
			placeholder: 'e.g. snippet',
			group: 'mapping',
			showIf: NATIVE_SHAPE_CONDITION
		},
		{
			name: 'category_field',
			type: 'text',
			label: 'Category Field',
			placeholder: 'e.g. category',
			group: 'mapping',
			showIf: NATIVE_SHAPE_CONDITION
		},
		{
			name: 'tags_field',
			type: 'text',
			label: 'Tags Field',
			description: 'Accepts either an array of strings or a comma-separated string.',
			placeholder: 'e.g. labels',
			group: 'mapping',
			showIf: NATIVE_SHAPE_CONDITION
		},
		{
			name: 'image_field',
			type: 'text',
			label: 'Image Field',
			description: 'Path to an image URL or an array of image URLs.',
			placeholder: 'e.g. avatar_url',
			group: 'mapping',
			showIf: NATIVE_SHAPE_CONDITION
		},
		{
			name: 'brand_field',
			type: 'text',
			label: 'Brand Field',
			placeholder: 'e.g. organization',
			group: 'mapping',
			showIf: NATIVE_SHAPE_CONDITION
		},
		{
			name: 'content_field',
			type: 'text',
			label: 'Content (Markdown) Field',
			placeholder: 'e.g. body',
			group: 'mapping',
			showIf: NATIVE_SHAPE_CONDITION
		},

		// ── Data passing ──────────────────────────────────────────────
		{
			name: 'pass_existing_items',
			type: 'boolean',
			label: 'Pass Existing Items Summary',
			description: 'Include a summary of existing work items in the tool input for deduplication',
			defaultValue: true,
			group: 'data'
		},
		{
			name: 'pass_repo_access',
			type: 'boolean',
			label: 'Pass Data Repository Access',
			description: 'Grant the Composio tool read access to the work data repository',
			defaultValue: false,
			group: 'data'
		},
		{
			name: 'repo_url',
			type: 'text',
			label: 'Data Repository URL',
			description: 'GitHub repository URL containing work data',
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

		// ── Features ──────────────────────────────────────────────────
		{
			name: 'capture_screenshots',
			type: 'boolean',
			label: 'Capture Screenshots',
			description: 'Take screenshots for generated items (requires a screenshot plugin)',
			defaultValue: false,
			group: 'features'
		},

		// ── Advanced ──────────────────────────────────────────────────
		{
			name: 'tool_params',
			type: 'json',
			label: 'Custom Tool Arguments',
			description:
				'Additional key-value parameters forwarded to the Composio tool as top-level arguments AND under `toolParams` in the envelope. Use this to populate required tool inputs (e.g. `{ "to": "alice@example.com", "subject": "Hello" }` for GMAIL_SEND_EMAIL).',
			defaultValue: {},
			group: 'advanced'
		}
	];
}

export function getFormGroups(): FormFieldGroup[] {
	return [
		{
			name: 'tool',
			title: 'Composio Tool',
			description: 'Choose the toolkit, tool, and connected account to invoke',
			order: 0
		},
		{
			name: 'mapping',
			title: 'Result Mapping',
			description: 'Control how the tool response becomes work items',
			order: 1,
			collapsible: true,
			collapsed: false
		},
		{
			name: 'data',
			title: 'Data Passing',
			description: 'Configure what contextual data is forwarded to the Composio tool',
			order: 2,
			collapsible: true,
			collapsed: false
		},
		{
			name: 'features',
			title: 'Features',
			description: 'Optional generation features',
			order: 3,
			collapsible: true,
			collapsed: true
		},
		{
			name: 'advanced',
			title: 'Advanced',
			description: 'Advanced tool arguments',
			order: 4,
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

	if (values.result_shape === 'native') {
		if (!values.name_field || typeof values.name_field !== 'string' || values.name_field.trim() === '') {
			return {
				valid: false,
				errors: [
					{
						path: 'name_field',
						message: 'Name field is required when using the native result shape'
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
