/**
 * Wire format for the onboarding wizard's server-side state.
 *
 * Persisted on `users.onboarding_state` (jsonb / simple-json). The web
 * wizard loads this on dashboard mount and PATCHes it on every step
 * transition so progress survives a cookie wipe or device switch.
 */

export type OnboardingAiChoice =
	| 'ever-works'
	| 'openrouter'
	| 'claude-code'
	| 'codex'
	| 'gemini'
	| 'grok';

export type OnboardingStorageChoice =
	| 'ever-works-git'
	| 'user-github'
	| 'user-gitlab'
	| 'user-git';

export type OnboardingDeployChoice = 'ever-works' | 'vercel' | 'k8s';

export interface OnboardingWizardStateV2 {
	readonly version: 2;
	readonly lastStep: number;
	readonly ai: { readonly choice: OnboardingAiChoice };
	readonly storage: { readonly choice: OnboardingStorageChoice };
	readonly deploy: { readonly choice: OnboardingDeployChoice };
	readonly skippedSteps: readonly string[];
	readonly pluginsReviewed: boolean;
}

/** Wire shape of `GET /api/onboarding/state`. */
export interface OnboardingStateResponse {
	readonly completedAt: string | null;
	readonly dismissedAt: string | null;
	readonly state: OnboardingWizardStateV2;
}

/**
 * Wire shape of `PATCH /api/onboarding/state`. All fields are optional;
 * `state` accepts a partial object that the server deep-merges with the
 * persisted version-2 shape (re-using existing values for missing keys).
 */
export interface OnboardingStatePatchRequest {
	readonly state?: Partial<{
		readonly lastStep: number;
		readonly ai: Partial<{ choice: OnboardingAiChoice }>;
		readonly storage: Partial<{ choice: OnboardingStorageChoice }>;
		readonly deploy: Partial<{ choice: OnboardingDeployChoice }>;
		readonly skippedSteps: readonly string[];
		readonly pluginsReviewed: boolean;
	}>;
}

/** Wire shape of `GET /api/onboarding/catalog`. */
export interface OnboardingCatalogResponse {
	readonly ai: ReadonlyArray<OnboardingCard<OnboardingAiChoice>>;
	readonly storage: ReadonlyArray<OnboardingCard<OnboardingStorageChoice>>;
	readonly deploy: ReadonlyArray<OnboardingCard<OnboardingDeployChoice>>;
	/** Plugins to surface in the "Plugins & Integrations" wizard step. */
	readonly plugins: ReadonlyArray<OnboardingPluginCard>;
}

export interface OnboardingCard<Choice extends string> {
	readonly choice: Choice;
	readonly title: string;
	readonly description: string;
	readonly default: boolean;
	readonly available: boolean;
	readonly badges: ReadonlyArray<OnboardingCardBadge>;
	/** Plugin id behind this card, when applicable. */
	readonly pluginId?: string;
}

export type OnboardingCardBadge = 'default' | 'byok' | 'planned';

export interface OnboardingPluginCard {
	readonly pluginId: string;
	readonly name: string;
	readonly category: string;
	readonly description: string;
	readonly onboardingPriority: number;
}

export const ONBOARDING_DEFAULT_STATE: OnboardingWizardStateV2 = {
	version: 2,
	lastStep: 0,
	ai: { choice: 'ever-works' },
	storage: { choice: 'ever-works-git' },
	deploy: { choice: 'ever-works' },
	skippedSteps: [],
	pluginsReviewed: false
};
