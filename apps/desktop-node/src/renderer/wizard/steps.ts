import { API_HOST_OPTIONS, MAX_TOKEN_LENGTH, MIN_TOKEN_LENGTH, type ApiHostChoice } from '../../shared/ipc-contract';

/**
 * Pure sequencing logic for the Desktop Node setup wizard:
 * welcome → API host → enrollment token → enroll → running.
 *
 * Mirrors `apps/desktop`'s `computeStepList` pattern (itself modelled on the
 * web onboarding wizard) so later steps — capability selection and resource
 * limits, PRD §3.2 steps 3-4 — slot in without new machinery.
 */

export const WIZARD_STEPS = ['welcome', 'host', 'token', 'enroll', 'running'] as const;
export type WizardStepId = (typeof WIZARD_STEPS)[number];

export interface WizardProgress {
	host?: ApiHostChoice;
	/** Only meaningful when `host === 'self-hosted'`. */
	customApiUrl?: string;
	token?: string;
	/** Flipped once the platform has accepted the enrollment. */
	enrolled: boolean;
}

export function computeStepList(_progress: WizardProgress): WizardStepId[] {
	// Every step always applies today; the conditional capability/limits
	// sub-steps hook in here (same extension point the web wizard uses).
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

/** Whether the given step's completion condition is met. */
export function canAdvance(step: WizardStepId, progress: WizardProgress): boolean {
	switch (step) {
		case 'welcome':
			return true;
		case 'host':
			return hostSelectionValid(progress);
		case 'token':
			return tokenValid(progress.token);
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
