import { describe, it, expect } from 'vitest';
import {
	ONBOARDING_TERMINAL_STATUSES,
	isTerminalOnboardingStatus,
	type OnboardingStatus
} from '../onboarding-status.js';

describe('ONBOARDING_TERMINAL_STATUSES', () => {
	it('contains exactly the three terminal statuses (deployed, failed, rejected)', () => {
		expect([...ONBOARDING_TERMINAL_STATUSES].sort()).toEqual(['deployed', 'failed', 'rejected']);
	});
});

describe('isTerminalOnboardingStatus', () => {
	it.each(['deployed', 'failed', 'rejected'] as const)('returns true for %s', (s) => {
		expect(isTerminalOnboardingStatus(s)).toBe(true);
	});

	it.each(['received', 'validating', 'validated', 'queued', 'generating'] as const)('returns false for %s', (s) => {
		expect(isTerminalOnboardingStatus(s)).toBe(false);
	});

	it('every OnboardingStatus value is classified as either terminal or non-terminal', () => {
		const all: OnboardingStatus[] = [
			'received',
			'validating',
			'validated',
			'queued',
			'generating',
			'deployed',
			'failed',
			'rejected'
		];
		for (const s of all) {
			const terminal = isTerminalOnboardingStatus(s);
			expect(typeof terminal).toBe('boolean');
		}
	});
});
