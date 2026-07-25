import { describe, expect, it } from 'vitest';
import { CLOUD_API_URL, LOCAL_DESKTOP_API_URL } from '../../shared/ipc-contract';
import {
	WIZARD_STEPS,
	canAdvance,
	computeStepList,
	firstIncompleteStep,
	hostSelectionValid,
	nextStep,
	previousStep,
	resolveApiUrl,
	tokenValid,
	type WizardProgress
} from './steps';

const TOKEN = 'ZmFrZS1lbnJvbGxtZW50LXRva2VuLWZvci10ZXN0aW5n';

function progress(overrides: Partial<WizardProgress> = {}): WizardProgress {
	return { enrolled: false, ...overrides };
}

describe('computeStepList', () => {
	it('runs welcome → host → token → enroll → running', () => {
		expect(computeStepList(progress())).toEqual(['welcome', 'host', 'token', 'enroll', 'running']);
		expect(WIZARD_STEPS).toHaveLength(5);
	});
});

describe('resolveApiUrl / hostSelectionValid', () => {
	it('uses the preset URL for the local-desktop and cloud choices', () => {
		expect(resolveApiUrl(progress({ host: 'local-desktop' }))).toBe(LOCAL_DESKTOP_API_URL);
		expect(resolveApiUrl(progress({ host: 'cloud' }))).toBe(CLOUD_API_URL);
		expect(hostSelectionValid(progress({ host: 'cloud' }))).toBe(true);
	});

	it('requires a URL for the self-hosted choice and canonicalizes it', () => {
		expect(resolveApiUrl(progress({ host: 'self-hosted' }))).toBeNull();
		expect(resolveApiUrl(progress({ host: 'self-hosted', customApiUrl: '   ' }))).toBeNull();
		expect(resolveApiUrl(progress({ host: 'self-hosted', customApiUrl: ' https://works.acme.dev/ ' }))).toBe(
			'https://works.acme.dev'
		);
		expect(resolveApiUrl(progress({ host: 'self-hosted', customApiUrl: 'http://10.0.0.5:3100' }))).toBe(
			'http://10.0.0.5:3100'
		);
	});

	it('rejects a malformed or non-http(s) self-hosted URL', () => {
		for (const bad of ['not a url', 'ftp://host', 'file:///etc/passwd', 'works.acme.dev']) {
			expect(resolveApiUrl(progress({ host: 'self-hosted', customApiUrl: bad }))).toBeNull();
		}
		expect(hostSelectionValid(progress({ host: 'self-hosted', customApiUrl: 'nope' }))).toBe(false);
	});

	it('is invalid until a host is chosen at all', () => {
		expect(hostSelectionValid(progress())).toBe(false);
	});
});

describe('tokenValid', () => {
	it('accepts a real-shaped token, trimming stray paste whitespace', () => {
		expect(tokenValid(TOKEN)).toBe(true);
		expect(tokenValid(`  ${TOKEN}\n`)).toBe(true);
	});

	it('rejects missing, truncated and absurdly long pastes before burning the token', () => {
		expect(tokenValid(undefined)).toBe(false);
		expect(tokenValid('')).toBe(false);
		expect(tokenValid('short')).toBe(false);
		expect(tokenValid('x'.repeat(257))).toBe(false);
		expect(tokenValid('x'.repeat(16))).toBe(true);
	});
});

describe('canAdvance / nextStep gating', () => {
	it('blocks the host step until the selection resolves to a URL', () => {
		expect(canAdvance('host', progress())).toBe(false);
		expect(canAdvance('host', progress({ host: 'self-hosted' }))).toBe(false);
		expect(canAdvance('host', progress({ host: 'local-desktop' }))).toBe(true);
		expect(nextStep('host', progress())).toBeNull();
	});

	it('blocks the token step until a plausible token is pasted', () => {
		const base = progress({ host: 'cloud' });
		expect(nextStep('token', base)).toBeNull();
		expect(nextStep('token', { ...base, token: 'nope' })).toBeNull();
		expect(nextStep('token', { ...base, token: TOKEN })).toBe('enroll');
	});

	it('blocks the enroll step until the platform has accepted the node', () => {
		const base = progress({ host: 'cloud', token: TOKEN });
		expect(nextStep('enroll', base)).toBeNull();
		expect(nextStep('enroll', { ...base, enrolled: true })).toBe('running');
	});

	it('walks the happy path in order once each condition is met', () => {
		const complete = progress({ host: 'cloud', token: TOKEN, enrolled: true });
		expect(nextStep('welcome', complete)).toBe('host');
		expect(nextStep('host', complete)).toBe('token');
		expect(nextStep('token', complete)).toBe('enroll');
		expect(nextStep('enroll', complete)).toBe('running');
		expect(nextStep('running', complete)).toBeNull();
	});

	it('supports going back except from the first step', () => {
		expect(previousStep('welcome', progress())).toBeNull();
		expect(previousStep('token', progress())).toBe('host');
		expect(previousStep('running', progress())).toBe('enroll');
	});
});

describe('firstIncompleteStep', () => {
	it('resumes at the first unmet condition', () => {
		expect(firstIncompleteStep(progress())).toBe('host');
		expect(firstIncompleteStep(progress({ host: 'cloud' }))).toBe('token');
		expect(firstIncompleteStep(progress({ host: 'cloud', token: TOKEN }))).toBe('enroll');
		expect(firstIncompleteStep(progress({ host: 'cloud', token: TOKEN, enrolled: true }))).toBe('running');
	});
});
