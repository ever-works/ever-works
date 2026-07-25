import { describe, expect, it } from 'vitest';
import { GtmPipelinePlugin } from '../gtm-pipeline.plugin.js';
import { GTM_DEFAULT_SETTINGS, resolveGtmSettings, validateGtmFormInput } from '../settings.js';

describe('GTM settings — resolution', () => {
	it('falls back to safe defaults when config is missing or malformed', () => {
		expect(resolveGtmSettings(undefined)).toEqual(GTM_DEFAULT_SETTINGS);
		const resolved = resolveGtmSettings({
			target_channels: 'not-an-array',
			tone: 'aggressive',
			cadence: 42,
			max_contacts_per_run: 'NaN',
			review_required: 'yes'
		});
		expect(resolved).toEqual(GTM_DEFAULT_SETTINGS);
	});

	it('honors explicit values and clamps out-of-range numbers', () => {
		const resolved = resolveGtmSettings({
			target_channels: ['email', 'social', '  '],
			tone: 'friendly',
			cadence: 'daily',
			max_contacts_per_run: 9999,
			review_required: false,
			qualify_min_score: -5,
			risk_exclude_threshold: 3,
			follow_up_quiet_days: 7
		});
		expect(resolved.targetChannels).toEqual(['email', 'social']);
		expect(resolved.tone).toBe('friendly');
		expect(resolved.cadence).toBe('daily');
		expect(resolved.maxContactsPerRun).toBe(200); // clamped to max
		expect(resolved.reviewRequired).toBe(false);
		expect(resolved.qualifyMinScore).toBe(0); // clamped to min
		expect(resolved.riskExcludeThreshold).toBe(3);
		expect(resolved.followUpQuietDays).toBe(7);
	});
});

describe('GTM settings — form validation', () => {
	it('accepts a valid settings payload', () => {
		const result = validateGtmFormInput({
			target_channels: ['email', 'newsletter'],
			tone: 'professional',
			cadence: 'weekly',
			max_contacts_per_run: 25,
			qualify_min_score: 50,
			risk_exclude_threshold: 7,
			review_required: true,
			follow_up_quiet_days: 4
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toBeUndefined();
	});

	it('rejects unknown tone/cadence and out-of-range numbers with paths', () => {
		const result = validateGtmFormInput({
			tone: 'sarcastic',
			cadence: 'hourly',
			max_contacts_per_run: 0,
			risk_exclude_threshold: 11
		});
		expect(result.valid).toBe(false);
		const paths = (result.errors ?? []).map((e) => e.path);
		expect(paths).toContain('tone');
		expect(paths).toContain('cadence');
		expect(paths).toContain('max_contacts_per_run');
		expect(paths).toContain('risk_exclude_threshold');
	});

	it('rejects non-array and empty-string target channels', () => {
		expect(validateGtmFormInput({ target_channels: 'email' }).valid).toBe(false);
		const result = validateGtmFormInput({ target_channels: ['email', ''] });
		expect(result.valid).toBe(false);
		expect((result.errors ?? [])[0].path).toBe('target_channels[1]');
	});

	it('plugin form surface exposes defaults for the settings knobs', () => {
		const plugin = new GtmPipelinePlugin();
		const defaults = plugin.getDefaultValues();
		expect(defaults.tone).toBe(GTM_DEFAULT_SETTINGS.tone);
		expect(defaults.cadence).toBe(GTM_DEFAULT_SETTINGS.cadence);
		expect(defaults.review_required).toBe(true);
		expect(defaults.target_channels).toEqual([...GTM_DEFAULT_SETTINGS.targetChannels]);
		expect(plugin.validateFormInput({ review_required: 'nope' }).valid).toBe(false);
		// transformFormValues drops empty arrays so form submits stay clean.
		expect(plugin.transformFormValues({ target_channels: [] })).not.toHaveProperty('target_channels');
	});
});
