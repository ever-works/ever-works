import type { FormFieldDefinition, FormFieldGroup, ValidationResult } from '@ever-works/plugin';
import { DEFAULT_TARGET_ITEMS } from './types.js';
// Direct import (NOT via `@ever-works/plugin/helpers`): the SSRF guard pulls in
// `node:net` / `node:dns` and is intentionally excluded from the helpers barrel.
// Mirrors the import in utils/make-client.ts.
import { isSafeWebhookUrl } from '@ever-works/plugin/helpers/ssrf-guard';

const REPO_ACCESS_CONDITION = { field: 'pass_repo_access', operator: 'eq' as const, value: true };
const SCENARIO_MODE_CONDITION = { field: 'execution_mode', operator: 'eq' as const, value: 'scenario' };
const WEBHOOK_MODE_CONDITION = { field: 'execution_mode', operator: 'eq' as const, value: 'webhook' };

export function getFormFields(): FormFieldDefinition[] {
	return [
		{
			name: 'execution_mode',
			type: 'select',
			label: 'Execution Mode',
			description: 'How to trigger Make.com: REST scenario run (polled) or direct webhook URL',
			defaultValue: 'scenario',
			options: [
				{ value: 'scenario', label: 'Scenario (REST API)' },
				{ value: 'webhook', label: 'Webhook URL' }
			],
			group: 'scenario'
		},
		{
			name: 'scenario_id',
			type: 'text',
			label: 'Scenario ID',
			description: 'Override the default scenario for this generation (optional if set in plugin settings)',
			placeholder: 'e.g., 123456',
			group: 'scenario',
			showIf: SCENARIO_MODE_CONDITION
		},
		{
			name: 'hook_id',
			type: 'text',
			label: 'Hook ID',
			description: 'Optional Make.com hook (webhook) ID to ping before the scenario runs',
			placeholder: 'e.g., 987654',
			group: 'scenario',
			showIf: SCENARIO_MODE_CONDITION
		},
		{
			name: 'webhook_url',
			type: 'text',
			label: 'Webhook URL',
			description: 'Override the default Make.com webhook URL',
			placeholder: 'https://hook.us2.make.com/...',
			group: 'scenario',
			showIf: WEBHOOK_MODE_CONDITION,
			requiredIf: WEBHOOK_MODE_CONDITION
		},
		{
			name: 'target_items',
			type: 'number',
			label: 'Target Items',
			description: 'Target number of new items to generate',
			defaultValue: DEFAULT_TARGET_ITEMS,
			validation: { min: 1, max: 500 },
			group: 'scenario'
		},
		{
			name: 'scenario_timeout',
			type: 'number',
			label: 'Scenario Timeout (minutes)',
			description: 'Maximum time to wait for the Make.com scenario to complete',
			defaultValue: 30,
			validation: { min: 1, max: 120 },
			group: 'scenario'
		},
		{
			name: 'pass_existing_items',
			type: 'boolean',
			label: 'Pass Existing Items Summary',
			description: 'Include a summary of existing work items in scenario input for deduplication',
			defaultValue: true,
			group: 'data'
		},
		{
			name: 'pass_repo_access',
			type: 'boolean',
			label: 'Pass Data Repository Access',
			description:
				'⚠️ Forwards your repository access token to Make.com (a third-party service) so its ' +
				'scenario can read the data repository. The token leaves Ever Works. Only enable for ' +
				'repos you trust Make.com with, and use a short-lived, read-only token.',
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
		{
			name: 'capture_screenshots',
			type: 'boolean',
			label: 'Capture Screenshots',
			description: 'Take screenshots for generated items (requires a screenshot plugin)',
			defaultValue: false,
			group: 'features'
		},
		{
			name: 'scenario_params',
			type: 'json',
			label: 'Custom Scenario Parameters',
			description: 'Additional key-value parameters to pass to the Make.com scenario',
			defaultValue: {},
			group: 'advanced'
		}
	];
}

export function getFormGroups(): FormFieldGroup[] {
	return [
		{
			name: 'scenario',
			title: 'Scenario Configuration',
			description: 'Configure which Make.com scenario or webhook to execute',
			order: 0
		},
		{
			name: 'data',
			title: 'Data Passing',
			description: 'Configure how data is passed to the Make.com scenario',
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
			description: 'Advanced scenario parameters',
			order: 3,
			collapsible: true,
			collapsed: true
		}
	];
}

export function validateFormInput(values: Record<string, unknown>): ValidationResult {
	const mode = (values.execution_mode as string | undefined) ?? 'scenario';

	if (mode === 'webhook') {
		if (!values.webhook_url || typeof values.webhook_url !== 'string' || values.webhook_url.trim() === '') {
			return {
				valid: false,
				errors: [{ path: 'webhook_url', message: 'Webhook URL is required in webhook mode' }]
			};
		}
		// Security (SSRF): webhook_url is tenant-controlled and is later POSTed to
		// server-side via fetch (utils/make-client.ts invokeWebhook). Reject
		// literal private/loopback/link-local/cloud-metadata hosts and non-HTTP(S)
		// schemes here so a malicious config fails fast with a clean validation
		// error instead of reaching the runtime SSRF guard. The make-client guard
		// remains the authoritative defense; this is defense-in-depth.
		if (!isSafeWebhookUrl(values.webhook_url.trim())) {
			return {
				valid: false,
				errors: [
					{
						path: 'webhook_url',
						message:
							'Webhook URL must be a public https URL. Private, loopback, link-local, and cloud-metadata hosts are not allowed.'
					}
				]
			};
		}
	}

	if (values.pass_repo_access) {
		if (!values.repo_url || typeof values.repo_url !== 'string' || values.repo_url.trim() === '') {
			return {
				valid: false,
				errors: [{ path: 'repo_url', message: 'Repository URL is required when repository access is enabled' }]
			};
		}
		// Security (SSRF): repo_url is tenant-controlled and is forwarded (with its
		// access token) to the Make.com scenario as dataSource.repoUrl, where the
		// scenario is expected to clone/fetch it. Reject literal private/loopback/
		// link-local/cloud-metadata hosts and non-HTTP(S) schemes so an attacker
		// can't point the automation at an internal endpoint (e.g.
		// http://169.254.169.254/). Public git hosts (github.com, gitlab.com, and
		// self-hosted git on public DNS) are unaffected; we intentionally do not
		// impose a fixed host allowlist so legitimate self-hosted repos still work.
		if (!isSafeWebhookUrl(values.repo_url.trim())) {
			return {
				valid: false,
				errors: [
					{
						path: 'repo_url',
						message:
							'Repository URL must be a public https URL. Private, loopback, link-local, and cloud-metadata hosts are not allowed.'
					}
				]
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
