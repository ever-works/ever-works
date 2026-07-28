import {
	API_HOST_OPTIONS,
	DEFAULT_LIMITS_VIEW,
	MAX_CONCURRENCY,
	MAX_CPU_CEILING,
	MAX_TOKEN_LENGTH,
	MIN_CONCURRENCY,
	MIN_CPU_CEILING,
	MIN_MEMORY_CEILING_MB,
	MIN_TOKEN_LENGTH,
	type ApiHostChoice,
	type EnrollMode,
	type NodeResourceLimits
} from '../../shared/ipc-contract';

/**
 * Pure sequencing logic for the Desktop Node setup wizard:
 * welcome → API host → credentials → capabilities → limits → enroll → running.
 *
 * Mirrors `apps/desktop`'s `computeStepList` pattern (itself modelled on the
 * web onboarding wizard).
 *
 * The `credentials` step covers BOTH ways onto a fleet (A14):
 *   - `token`   paste a one-time token issued in Fleet settings (original)
 *   - `sign-in` sign in here and let the app mint the token itself
 * They are two ways to obtain the same single-use token — the enroll protocol
 * is identical either way.
 *
 * The `capabilities` (A15) and `limits` (A16) steps are what turn "this machine
 * is enrolled" into "this machine offers exactly this much": the operator
 * decides which detected capabilities to advertise and how much of the machine
 * the platform may consume.
 */

export const WIZARD_STEPS = ['welcome', 'host', 'token', 'capabilities', 'limits', 'enroll', 'running'] as const;
export type WizardStepId = (typeof WIZARD_STEPS)[number];

export interface WizardProgress {
	host?: ApiHostChoice;
	/** Only meaningful when `host === 'self-hosted'`. */
	customApiUrl?: string;
	/** How this machine will prove it may join (A14). Defaults to `token`. */
	mode?: EnrollMode;
	token?: string;
	/** Only meaningful when `mode === 'sign-in'`. */
	email?: string;
	/** Only meaningful when `mode === 'sign-in'`. Never leaves the process. */
	password?: string;
	/** Flipped once the main process has verified the credentials. */
	signedIn?: boolean;
	/**
	 * Capability tags the operator chose to offer (A15). `undefined` means the
	 * step has not been visited yet and everything detected will be advertised.
	 */
	capabilities?: string[];
	/** Resource ceilings this machine will enforce on itself (A16). */
	limits?: NodeResourceLimits;
	/** Flipped once the platform has accepted the enrollment. */
	enrolled: boolean;
}

export function computeStepList(_progress: WizardProgress): WizardStepId[] {
	// Every step always applies today; further conditional sub-steps hook in
	// here (same extension point the web wizard uses).
	return [...WIZARD_STEPS];
}

/**
 * The API URL implied by the current selection: the preset URL for the
 * local-desktop and cloud choices, the operator's own for self-hosted. Returns
 * null when the selection cannot yet produce a usable URL.
 */
export function resolveApiUrl(progress: WizardProgress): string | null {
	const option = API_HOST_OPTIONS.find((candidate) => candidate.id === progress.host);
	if (!option) {
		return null;
	}
	if (option.url) {
		return option.url;
	}
	const custom = progress.customApiUrl?.trim();
	if (!custom) {
		return null;
	}
	try {
		const parsed = new URL(custom);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return null;
		}
		return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
	} catch {
		return null;
	}
}

export function hostSelectionValid(progress: WizardProgress): boolean {
	return resolveApiUrl(progress) !== null;
}

/** The enrollment mode in force; `token` remains the default. */
export function enrollMode(progress: WizardProgress): EnrollMode {
	return progress.mode === 'sign-in' ? 'sign-in' : 'token';
}

/**
 * Local shape check on the pasted token, matching the credential bounds the
 * API enforces — so an obviously truncated paste is caught before it burns the
 * single-use token on a round trip.
 */
export function tokenValid(token: string | undefined): boolean {
	if (typeof token !== 'string') {
		return false;
	}
	const trimmed = token.trim();
	return trimmed.length >= MIN_TOKEN_LENGTH && trimmed.length <= MAX_TOKEN_LENGTH;
}

/**
 * Local shape check on the sign-in form. Deliberately loose — the platform
 * owns email validation — so the operator gets an instant answer on obviously
 * empty input rather than a round trip.
 */
export function signInInputValid(progress: WizardProgress): boolean {
	const email = progress.email?.trim() ?? '';
	const password = progress.password ?? '';
	return email.length >= 3 && email.includes('@') && password.length > 0;
}

/**
 * Whether the credentials step is satisfied. In `sign-in` mode a filled-in
 * form is not enough: the main process must have actually verified it
 * (`signedIn`), so a wrong password is caught at the credentials step rather
 * than surfacing three steps later as a mysterious enroll failure.
 */
export function credentialsValid(progress: WizardProgress): boolean {
	return enrollMode(progress) === 'sign-in' ? progress.signedIn === true : tokenValid(progress.token);
}

/**
 * Coerce a partially-filled limits form into a coherent set of ceilings.
 * Mirrors the core's `clampResourceLimits` so what the wizard shows is exactly
 * what the node will enforce.
 */
export function normalizeLimits(input: Partial<NodeResourceLimits> | undefined): NodeResourceLimits {
	const concurrency = Number(input?.maxConcurrentJobs);
	const cpu = input?.maxCpuPercent;
	const memory = input?.maxMemoryMb;
	return {
		maxConcurrentJobs: Number.isFinite(concurrency)
			? Math.min(Math.max(Math.round(concurrency), MIN_CONCURRENCY), MAX_CONCURRENCY)
			: DEFAULT_LIMITS_VIEW.maxConcurrentJobs,
		maxCpuPercent:
			typeof cpu === 'number' && Number.isFinite(cpu)
				? Math.min(Math.max(Math.round(cpu), MIN_CPU_CEILING), MAX_CPU_CEILING)
				: null,
		maxMemoryMb:
			typeof memory === 'number' && Number.isFinite(memory)
				? Math.max(Math.round(memory), MIN_MEMORY_CEILING_MB)
				: null
	};
}

/**
 * A limits selection is valid when it normalizes to itself — i.e. the operator
 * is looking at exactly the numbers the node will apply, with no silent
 * clamping between the form and the config file.
 */
export function limitsValid(limits: NodeResourceLimits | undefined): boolean {
	if (!limits) {
		return false;
	}
	const normalized = normalizeLimits(limits);
	return (
		normalized.maxConcurrentJobs === limits.maxConcurrentJobs &&
		normalized.maxCpuPercent === limits.maxCpuPercent &&
		normalized.maxMemoryMb === limits.maxMemoryMb
	);
}

/**
 * Whether the given step's completion condition is met.
 *
 * The capabilities step is intentionally always passable: offering NOTHING but
 * the machine's identity tags is a legitimate choice (visibility-only
 * enrollment), and refusing to advance would make that choice unreachable.
 */
export function canAdvance(step: WizardStepId, progress: WizardProgress): boolean {
	switch (step) {
		case 'welcome':
			return true;
		case 'host':
			return hostSelectionValid(progress);
		case 'token':
			return credentialsValid(progress);
		case 'capabilities':
			return Array.isArray(progress.capabilities);
		case 'limits':
			return limitsValid(progress.limits);
		case 'enroll':
			return progress.enrolled;
		case 'running':
			return false;
	}
}

export function nextStep(step: WizardStepId, progress: WizardProgress): WizardStepId | null {
	if (!canAdvance(step, progress)) {
		return null;
	}
	const steps = computeStepList(progress);
	const index = steps.indexOf(step);
	return index >= 0 && index < steps.length - 1 ? steps[index + 1] : null;
}

export function previousStep(step: WizardStepId, progress: WizardProgress): WizardStepId | null {
	const steps = computeStepList(progress);
	const index = steps.indexOf(step);
	return index > 0 ? steps[index - 1] : null;
}

/** Where a resumed wizard should land: the first step whose condition is unmet. */
export function firstIncompleteStep(progress: WizardProgress): WizardStepId {
	const steps = computeStepList(progress);
	for (const step of steps) {
		if (step === 'welcome') {
			continue;
		}
		if (!canAdvance(step, progress)) {
			return step;
		}
	}
	return steps[steps.length - 1];
}
