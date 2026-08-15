import type { FormFieldDefinition, FormFieldGroup, ValidationResult } from '@ever-works/plugin';

import { MAX_VARIANT_SESSIONS, MIN_VARIANT_SESSIONS } from './types.js';

export const DEFAULT_TARGET_ITEMS = 50;
export const DEFAULT_VARIANT_SESSIONS = 1;
export const MAX_PER_SESSION_BUDGET_USD = 500;

/**
 * Runtime ceiling for the per-session spend cap. Applied on every path that
 * can reach `sessions.create` — the generation form (validated), a raw
 * `GenerationRequest` hitting `execute()` directly, and the programmatic
 * `runSessions()` fan-out entry point — so no caller can request an unbounded
 * budget. Non-numeric / non-positive values mean "no cap configured".
 */
export function clampPerSessionBudgetUsd(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}

	return Math.min(value, MAX_PER_SESSION_BUDGET_USD);
}

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
			name: 'variant_sessions',
			type: 'number',
			label: 'Parallel Variant Sessions',
			description:
				'Number of parallel managed-agent sessions to fan out. 1 keeps the standard single-session run; higher values generate complementary variants that are merged and de-duplicated.',
			defaultValue: DEFAULT_VARIANT_SESSIONS,
			validation: { min: MIN_VARIANT_SESSIONS, max: MAX_VARIANT_SESSIONS },
			group: 'scope'
		},
		{
			name: 'per_session_budget_usd',
			type: 'number',
			label: 'Per-Session Budget (USD)',
			description:
				'Optional hard spend ceiling per managed-agent session. The session stops issuing model requests once its tracked cost reaches this amount.',
			validation: { min: 1, max: MAX_PER_SESSION_BUDGET_USD },
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

	const variantSessions = values.variant_sessions;

	if (variantSessions !== undefined) {
		if (typeof variantSessions !== 'number' || !Number.isFinite(variantSessions)) {
			return {
				valid: false,
				errors: [{ path: 'variant_sessions', message: 'Variant sessions must be a number.' }]
			};
		}

		if (variantSessions < MIN_VARIANT_SESSIONS || variantSessions > MAX_VARIANT_SESSIONS) {
			return {
				valid: false,
				errors: [
					{
						path: 'variant_sessions',
						message: `Variant sessions must be between ${MIN_VARIANT_SESSIONS} and ${MAX_VARIANT_SESSIONS}.`
					}
				]
			};
		}
	}

	const perSessionBudget = values.per_session_budget_usd;

	if (perSessionBudget !== undefined) {
		if (typeof perSessionBudget !== 'number' || !Number.isFinite(perSessionBudget)) {
			return {
				valid: false,
				errors: [{ path: 'per_session_budget_usd', message: 'Per-session budget must be a number.' }]
			};
		}

		if (perSessionBudget < 1 || perSessionBudget > MAX_PER_SESSION_BUDGET_USD) {
			return {
				valid: false,
				errors: [
					{
						path: 'per_session_budget_usd',
						message: `Per-session budget must be between 1 and ${MAX_PER_SESSION_BUDGET_USD} USD.`
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
