export type OnboardingStatus =
	| 'received'
	| 'validating'
	| 'validated'
	| 'queued'
	| 'generating'
	| 'deployed'
	| 'failed'
	| 'rejected';

export const ONBOARDING_TERMINAL_STATUSES: ReadonlyArray<OnboardingStatus> = ['deployed', 'failed', 'rejected'];

export function isTerminalOnboardingStatus(status: OnboardingStatus): boolean {
	return ONBOARDING_TERMINAL_STATUSES.includes(status);
}
