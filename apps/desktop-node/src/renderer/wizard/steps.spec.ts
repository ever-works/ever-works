import { describe, expect, it } from 'vitest';
import { CLOUD_API_URL, LOCAL_DESKTOP_API_URL, type NodeResourceLimits } from '../../shared/ipc-contract';
import {
	WIZARD_STEPS,
	canAdvance,
	computeStepList,
	credentialsValid,
	enrollMode,
	firstIncompleteStep,
	hostSelectionValid,
	limitsValid,
	nextStep,
	normalizeLimits,
	previousStep,
	resolveApiUrl,
	signInInputValid,
	tokenValid,
	type WizardProgress
} from './steps';

const TOKEN = 'ZmFrZS1lbnJvbGxtZW50LXRva2VuLWZvci10ZXN0aW5n';
const LIMITS: NodeResourceLimits = { maxConcurrentJobs: 2, maxCpuPercent: null, maxMemoryMb: null };

function progress(overrides: Partial<WizardProgress> = {}): WizardProgress {
	return { enrolled: false, ...overrides };
}

/** Everything answered — used wherever a test only cares about one gate. */
function complete(overrides: Partial<WizardProgress> = {}): WizardProgress {
	return progress({ host: 'cloud', token: TOKEN, capabilities: ['terminal'], limits: LIMITS, ...overrides });
}

describe('computeStepList', () => {
	it('runs welcome → host → credentials → capabilities → limits → enroll → running', () => {
		expect(computeStepList(progress())).toEqual([
			'welcome',
			'host',
			'token',
			'capabilities',
			'limits',
			'enroll',
			'running'
		]);
		expect(WIZARD_STEPS).toHaveLength(7);
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

	it('blocks the credentials step until a plausible token is pasted', () => {
		const base = progress({ host: 'cloud', capabilities: [], limits: LIMITS });
		expect(nextStep('token', base)).toBeNull();
		expect(nextStep('token', { ...base, token: 'nope' })).toBeNull();
		expect(nextStep('token', { ...base, token: TOKEN })).toBe('capabilities');
	});

	it('blocks the capabilities step until the operator has actually chosen', () => {
		// `undefined` = never visited; `[]` = "identity only", a real choice.
		expect(canAdvance('capabilities', complete({ capabilities: undefined }))).toBe(false);
		expect(canAdvance('capabilities', complete({ capabilities: [] }))).toBe(true);
	});

	it('blocks the limits step until the ceilings are coherent', () => {
		expect(canAdvance('limits', complete({ limits: undefined }))).toBe(false);
		expect(canAdvance('limits', complete({ limits: LIMITS }))).toBe(true);
		// A number the node would silently clamp is not an answer the operator
		// gave — make them look at the real one.
		expect(canAdvance('limits', complete({ limits: { ...LIMITS, maxConcurrentJobs: 99 } }))).toBe(false);
	});

	it('blocks the enroll step until the platform has accepted the node', () => {
		expect(nextStep('enroll', complete())).toBeNull();
		expect(nextStep('enroll', complete({ enrolled: true }))).toBe('running');
	});

	it('walks the happy path in order once each condition is met', () => {
		const answered = complete({ enrolled: true });
		expect(nextStep('welcome', answered)).toBe('host');
		expect(nextStep('host', answered)).toBe('token');
		expect(nextStep('token', answered)).toBe('capabilities');
		expect(nextStep('capabilities', answered)).toBe('limits');
		expect(nextStep('limits', answered)).toBe('enroll');
		expect(nextStep('enroll', answered)).toBe('running');
		expect(nextStep('running', answered)).toBeNull();
	});

	it('supports going back except from the first step', () => {
		expect(previousStep('welcome', progress())).toBeNull();
		expect(previousStep('token', progress())).toBe('host');
		expect(previousStep('running', progress())).toBe('enroll');
	});
});

describe('enrollMode / credentialsValid (A14 — authenticate leg)', () => {
	it('defaults to the paste-a-token mode so existing muscle memory still works', () => {
		expect(enrollMode(progress())).toBe('token');
		expect(credentialsValid(progress({ token: TOKEN }))).toBe(true);
	});

	it('requires a VERIFIED sign-in, not just a filled-in form', () => {
		const typed = progress({ mode: 'sign-in', email: 'a@b.co', password: 'pw' });
		expect(signInInputValid(typed)).toBe(true);
		// A filled form is not proof: the main process has to have checked it,
		// or a wrong password surfaces three steps later as "enrollment failed".
		expect(credentialsValid(typed)).toBe(false);
		expect(credentialsValid({ ...typed, signedIn: true })).toBe(true);
	});

	it('ignores a pasted token once the operator switched to signing in', () => {
		expect(credentialsValid(progress({ mode: 'sign-in', token: TOKEN }))).toBe(false);
	});

	it('rejects obviously unusable sign-in input up front', () => {
		expect(signInInputValid(progress({ mode: 'sign-in' }))).toBe(false);
		expect(signInInputValid(progress({ mode: 'sign-in', email: 'nope', password: 'pw' }))).toBe(false);
		expect(signInInputValid(progress({ mode: 'sign-in', email: 'a@b.co', password: '' }))).toBe(false);
	});
});

describe('normalizeLimits / limitsValid (A16 — resource ceilings)', () => {
	it('clamps concurrency into the range the node actually supports', () => {
		expect(normalizeLimits({ maxConcurrentJobs: 0 }).maxConcurrentJobs).toBe(1);
		expect(normalizeLimits({ maxConcurrentJobs: 99 }).maxConcurrentJobs).toBe(16);
	});

	it('treats an absent or nonsense ceiling as "no ceiling"', () => {
		expect(normalizeLimits({}).maxCpuPercent).toBeNull();
		expect(normalizeLimits({ maxMemoryMb: Number.NaN }).maxMemoryMb).toBeNull();
	});

	it('raises a too-small ceiling to the floor rather than idling the node', () => {
		expect(normalizeLimits({ maxCpuPercent: 1 }).maxCpuPercent).toBe(5);
		expect(normalizeLimits({ maxMemoryMb: 10 }).maxMemoryMb).toBe(256);
	});

	it('accepts only values that survive normalization unchanged', () => {
		expect(limitsValid(undefined)).toBe(false);
		expect(limitsValid(LIMITS)).toBe(true);
		expect(limitsValid({ maxConcurrentJobs: 1, maxCpuPercent: 1, maxMemoryMb: null })).toBe(false);
	});
});

describe('firstIncompleteStep', () => {
	it('resumes at the first unmet condition', () => {
		expect(firstIncompleteStep(progress())).toBe('host');
		expect(firstIncompleteStep(progress({ host: 'cloud' }))).toBe('token');
		expect(firstIncompleteStep(progress({ host: 'cloud', token: TOKEN }))).toBe('capabilities');
		expect(firstIncompleteStep(progress({ host: 'cloud', token: TOKEN, capabilities: [] }))).toBe('limits');
		expect(firstIncompleteStep(complete())).toBe('enroll');
		expect(firstIncompleteStep(complete({ enrolled: true }))).toBe('running');
	});
});
