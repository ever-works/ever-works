import { describe, expect, it } from 'vitest';
import { DEFAULT_DESKTOP_CONSENTS } from '../../shared/ipc-contract';
import {
	WIZARD_CONSENT_CHOICES,
	WIZARD_STEPS,
	toggleWizardConsent,
	wizardConsents,
	type WizardProgress
} from './steps';

/**
 * Fleet node link (FL-02 T-26, spec §5.5, S13) — the wizard's "What may this
 * computer do?" choices: on the capabilities step (the step list is
 * unchanged), defaulting to how the app always ran, each one a toggle.
 */
describe('the wizard consents', () => {
	const progress = (overrides: Partial<WizardProgress> = {}): WizardProgress => ({ enrolled: false, ...overrides });

	it('offers the three consents in order, without adding a step', () => {
		expect(WIZARD_CONSENT_CHOICES.map((choice) => choice.key)).toEqual(['work', 'attend', 'manage']);
		expect(WIZARD_STEPS).toHaveLength(7);
	});

	it('defaults to work only until the owner chooses', () => {
		expect(wizardConsents(progress())).toEqual(DEFAULT_DESKTOP_CONSENTS);
	});

	it('toggles one consent and keeps the others', () => {
		const once = toggleWizardConsent(progress(), 'manage');
		expect(wizardConsents(once)).toEqual({ work: true, attend: false, manage: true });
		const twice = toggleWizardConsent(once, 'work');
		expect(wizardConsents(twice)).toEqual({ work: false, attend: false, manage: true });
	});
});
