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

/**
 * Whether an {@link OnboardingStatus} marks the end of the onboarding
 * flow — i.e. the status will not transition further. Currently
 * `'deployed'` (success), `'failed'` (generic error), and `'rejected'`
 * (input refused upfront) per {@link ONBOARDING_TERMINAL_STATUSES}.
 * Callers polling for completion should stop polling once this returns
 * `true`.
 *
 * @param status - The status to test.
 * @returns `true` when the onboarding flow has ended for this status.
 */
export function isTerminalOnboardingStatus(status: OnboardingStatus): boolean {
	return ONBOARDING_TERMINAL_STATUSES.includes(status);
}
