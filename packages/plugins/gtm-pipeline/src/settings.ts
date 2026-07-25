import type { FormFieldDefinition, FormFieldGroup, ValidationResult } from '@ever-works/plugin';

/**
 * Go-to-Market pipeline settings — target channels, tone, cadence, plus
 * the qualification and review knobs. Exposed through the standard
 * form-schema-provider surface and resolved from `request.config`.
 */

export const GTM_TARGET_CHANNELS = ['email', 'blog', 'social', 'newsletter', 'community'] as const;
export type GtmTargetChannel = (typeof GTM_TARGET_CHANNELS)[number];

export const GTM_TONES = ['professional', 'friendly', 'direct', 'enthusiastic'] as const;
export type GtmTone = (typeof GTM_TONES)[number];

export const GTM_CADENCES = ['daily', 'weekly', 'biweekly', 'monthly'] as const;
export type GtmCadence = (typeof GTM_CADENCES)[number];

export interface GtmPipelineSettings {
	readonly targetChannels: readonly string[];
	readonly tone: GtmTone;
	readonly cadence: GtmCadence;
	readonly maxContactsPerRun: number;
	/** Human gate before any outbound action (default ON — drafts-not-sends). */
	readonly reviewRequired: boolean;
	/** Minimum qualify score (0–100) required to keep a contact. */
	readonly qualifyMinScore: number;
	/** Contacts with risk score ≥ this threshold (0–10) are excluded. */
	readonly riskExcludeThreshold: number;
	/** Days of silence after which a prepared action queues a follow-up. */
	readonly followUpQuietDays: number;
}

export const GTM_DEFAULT_SETTINGS: GtmPipelineSettings = {
	targetChannels: ['email'],
	tone: 'professional',
	cadence: 'weekly',
	maxContactsPerRun: 20,
	reviewRequired: true,
	qualifyMinScore: 40,
	riskExcludeThreshold: 7,
	followUpQuietDays: 4
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	const num = Number(value);
	if (value === undefined || value === null || Number.isNaN(num)) return fallback;
	return Math.min(max, Math.max(min, num));
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
	return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * Resolve the effective settings from the raw generator/config object
 * (snake_case form keys), falling back to safe defaults for anything
 * missing or out of range.
 */
export function resolveGtmSettings(config: Record<string, unknown> | undefined): GtmPipelineSettings {
	const cfg = config ?? {};
	const rawChannels = cfg.target_channels;
	const channels = Array.isArray(rawChannels)
		? rawChannels.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim())
		: [];
	return {
		targetChannels: channels.length > 0 ? channels : GTM_DEFAULT_SETTINGS.targetChannels,
		tone: pickEnum(cfg.tone, GTM_TONES, GTM_DEFAULT_SETTINGS.tone),
		cadence: pickEnum(cfg.cadence, GTM_CADENCES, GTM_DEFAULT_SETTINGS.cadence),
		maxContactsPerRun: clampNumber(cfg.max_contacts_per_run, 1, 200, GTM_DEFAULT_SETTINGS.maxContactsPerRun),
		reviewRequired:
			typeof cfg.review_required === 'boolean' ? cfg.review_required : GTM_DEFAULT_SETTINGS.reviewRequired,
		qualifyMinScore: clampNumber(cfg.qualify_min_score, 0, 100, GTM_DEFAULT_SETTINGS.qualifyMinScore),
		riskExcludeThreshold: clampNumber(cfg.risk_exclude_threshold, 0, 10, GTM_DEFAULT_SETTINGS.riskExcludeThreshold),
		followUpQuietDays: clampNumber(cfg.follow_up_quiet_days, 1, 90, GTM_DEFAULT_SETTINGS.followUpQuietDays)
	};
}

export function getGtmFormFields(): FormFieldDefinition[] {
	return [
		{
			name: 'target_channels',
			type: 'tags',
			label: 'Target Channels',
			description: `Channels to prepare content for (e.g. ${GTM_TARGET_CHANNELS.join(', ')})`,
			defaultValue: [...GTM_DEFAULT_SETTINGS.targetChannels],
			group: 'campaign'
		},
		{
			name: 'tone',
			type: 'select',
			label: 'Tone',
			description: 'Voice used for drafted content',
			options: GTM_TONES.map((tone) => ({ value: tone, label: tone.charAt(0).toUpperCase() + tone.slice(1) })),
			defaultValue: GTM_DEFAULT_SETTINGS.tone,
			group: 'campaign'
		},
		{
			name: 'cadence',
			type: 'select',
			label: 'Cadence',
			description: 'How often this pipeline is expected to run',
			options: GTM_CADENCES.map((cadence) => ({
				value: cadence,
				label: cadence.charAt(0).toUpperCase() + cadence.slice(1)
			})),
			defaultValue: GTM_DEFAULT_SETTINGS.cadence,
			group: 'campaign'
		},
		{
			name: 'max_contacts_per_run',
			type: 'number',
			label: 'Max Contacts per Run',
			description: 'Upper bound of contacts drafted per run',
			defaultValue: GTM_DEFAULT_SETTINGS.maxContactsPerRun,
			validation: { min: 1, max: 200 },
			group: 'qualification'
		},
		{
			name: 'qualify_min_score',
			type: 'number',
			label: 'Minimum Qualify Score',
			description: 'Contacts scoring below this (0-100) are dropped',
			defaultValue: GTM_DEFAULT_SETTINGS.qualifyMinScore,
			validation: { min: 0, max: 100 },
			group: 'qualification'
		},
		{
			name: 'risk_exclude_threshold',
			type: 'number',
			label: 'Risk Exclusion Threshold',
			description: 'Contacts with risk score at or above this (0-10) are excluded',
			defaultValue: GTM_DEFAULT_SETTINGS.riskExcludeThreshold,
			validation: { min: 0, max: 10 },
			group: 'qualification'
		},
		{
			name: 'review_required',
			type: 'boolean',
			label: 'Require Human Review',
			description: 'Pause before the act stage until drafts are approved (recommended)',
			defaultValue: GTM_DEFAULT_SETTINGS.reviewRequired,
			group: 'review'
		},
		{
			name: 'follow_up_quiet_days',
			type: 'number',
			label: 'Follow-up Quiet Days',
			description: 'Days of silence before a prepared action queues a follow-up',
			defaultValue: GTM_DEFAULT_SETTINGS.followUpQuietDays,
			validation: { min: 1, max: 90 },
			group: 'review'
		}
	];
}

export function getGtmFormGroups(): FormFieldGroup[] {
	return [
		{
			name: 'campaign',
			title: 'Campaign',
			description: 'Channels, tone, and cadence',
			order: 1,
			collapsible: true,
			collapsed: false
		},
		{
			name: 'qualification',
			title: 'Qualification',
			description: 'Scoring and risk filtering',
			order: 2,
			collapsible: true,
			collapsed: true
		},
		{
			name: 'review',
			title: 'Review & Follow-up',
			description: 'Human gate and re-engagement',
			order: 3,
			collapsible: true,
			collapsed: true
		}
	];
}

export function validateGtmFormInput(values: Record<string, unknown>): ValidationResult {
	const errors: Array<{ path: string; message: string }> = [];

	const numericFields = [
		{ name: 'max_contacts_per_run', min: 1, max: 200 },
		{ name: 'qualify_min_score', min: 0, max: 100 },
		{ name: 'risk_exclude_threshold', min: 0, max: 10 },
		{ name: 'follow_up_quiet_days', min: 1, max: 90 }
	];
	for (const field of numericFields) {
		const value = values[field.name];
		if (value !== undefined && value !== null) {
			const num = Number(value);
			if (Number.isNaN(num)) {
				errors.push({ path: field.name, message: `${field.name} must be a number` });
			} else if (num < field.min || num > field.max) {
				errors.push({
					path: field.name,
					message: `${field.name} must be between ${field.min} and ${field.max}`
				});
			}
		}
	}

	if (values.tone !== undefined && !(GTM_TONES as readonly string[]).includes(values.tone as string)) {
		errors.push({ path: 'tone', message: `tone must be one of: ${GTM_TONES.join(', ')}` });
	}
	if (values.cadence !== undefined && !(GTM_CADENCES as readonly string[]).includes(values.cadence as string)) {
		errors.push({ path: 'cadence', message: `cadence must be one of: ${GTM_CADENCES.join(', ')}` });
	}
	if (values.target_channels !== undefined) {
		if (!Array.isArray(values.target_channels)) {
			errors.push({ path: 'target_channels', message: 'target_channels must be an array of channel names' });
		} else {
			for (let i = 0; i < values.target_channels.length; i++) {
				const channel = values.target_channels[i];
				if (typeof channel !== 'string' || channel.trim().length === 0) {
					errors.push({
						path: `target_channels[${i}]`,
						message: 'each target channel must be a non-empty string'
					});
				}
			}
		}
	}
	if (values.review_required !== undefined && typeof values.review_required !== 'boolean') {
		errors.push({ path: 'review_required', message: 'review_required must be a boolean' });
	}

	return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };
}
