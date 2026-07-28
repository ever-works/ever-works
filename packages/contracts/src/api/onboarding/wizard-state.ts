/**
 * Wire format for the onboarding wizard's server-side state.
 *
 * Persisted on `users.onboarding_state` (jsonb / simple-json). The web
 * wizard loads this on dashboard mount and PATCHes it on every step
 * transition so progress survives a cookie wipe or device switch.
 */

export type OnboardingAiChoice = 'ever-works' | 'openrouter' | 'claude-code' | 'codex' | 'gemini' | 'grok';

export type OnboardingStorageChoice = 'ever-works-git' | 'user-github' | 'user-gitlab' | 'user-git';

/**
 * Where a Work's database lives: the platform-managed "Ever Works DB" (shared,
 * auto-provisioned) or a bring-your-own custom database (connection details are
 * entered on the Deploy page after the Work is created — never stored in this
 * onboarding-state blob).
 */
export type OnboardingDbChoice = 'ever-works-db' | 'custom';

export type OnboardingDeployChoice = 'ever-works' | 'vercel' | 'k8s';

/**
 * A8 — where the user actually runs Ever Works, and therefore what their
 * first run should look like.
 *
 * The other four buckets all ask "which provider": AI, storage, database,
 * deployment. None of them ask the question a desktop-first user is actually
 * living — "is this thing running on my machine, and are my machines part of
 * it?" — so those users landed on a cloud-shaped first run and had to find
 * Fleet and the node apps on their own.
 *
 *   - `cloud`      the hosted platform (default; unchanged behaviour)
 *   - `desktop`    the all-in-one desktop app supervising a local stack
 *   - `own-nodes`  the platform runs elsewhere, but this person's own
 *                  machines execute the work (Fleet + node apps)
 */
export type OnboardingDesktopChoice = 'cloud' | 'desktop' | 'own-nodes';

/**
 * Wave 11 — "What do you do" onboarding step. A generic option row:
 * stable kebab-case id + English display label + one-line description.
 * The web wizard renders these through i18n keys keyed by `id`; the
 * label/description here are the canonical English fallback used by
 * non-web surfaces (desktop embeds, API docs).
 */
export interface OnboardingProfileOption<Id extends string = string> {
	readonly id: Id;
	readonly label: string;
	readonly description: string;
}

/**
 * Roles for the "What do you do" step (multi-select — picking several
 * or all is fine). Selections are hints for suggestion surfaces, never
 * gates: nothing is hidden based on them.
 */
export const ROLE_OPTIONS = [
	{ id: 'founder-ceo', label: 'Founder / CEO', description: 'I run the company and wear many hats' },
	{ id: 'engineering', label: 'Engineering', description: 'I build and ship software' },
	{ id: 'product', label: 'Product', description: 'I define what we build and why' },
	{ id: 'marketing', label: 'Marketing', description: 'I grow awareness, content, and campaigns' },
	{ id: 'sales', label: 'Sales', description: 'I find, pitch, and close customers' },
	{ id: 'consultant', label: 'Consultant', description: 'I deliver projects and advice for clients' },
	{ id: 'research', label: 'Research', description: 'I investigate, analyze, and synthesize' },
	{ id: 'operations', label: 'Operations', description: 'I keep the business running smoothly' },
	{ id: 'support', label: 'Support', description: 'I help customers succeed and resolve issues' },
	{ id: 'finance', label: 'Finance', description: 'I manage budgets, billing, and reporting' },
	{ id: 'hr', label: 'HR', description: 'I hire, onboard, and support our people' },
	{ id: 'legal', label: 'Legal', description: 'I handle contracts, compliance, and policy' },
	{ id: 'education', label: 'Education', description: 'I teach, train, or create learning content' },
	{ id: 'other', label: 'Other', description: 'Something else — tell us more later' }
] as const satisfies readonly OnboardingProfileOption[];

export type OnboardingRoleId = (typeof ROLE_OPTIONS)[number]['id'];

/** Team size for the "What do you do" step (single-select). */
export const TEAM_SIZE_OPTIONS = [
	{ id: 'solo', label: 'Solo', description: 'Just me' },
	{ id: 'small-2-10', label: 'Small (2–10)', description: '2–10 people' },
	{ id: 'mid-11-50', label: 'Mid (11–50)', description: '11–50 people' },
	{ id: 'large-51-200', label: 'Large (51–200)', description: '51–200 people' },
	{ id: 'enterprise-200-plus', label: 'Enterprise (200+)', description: 'More than 200 people' }
] as const satisfies readonly OnboardingProfileOption[];

export type OnboardingTeamSizeId = (typeof TEAM_SIZE_OPTIONS)[number]['id'];

/**
 * Wave 11 — persisted answers of the "What do you do" step. Values are
 * plain strings (not the narrowed id unions) so older clients keep
 * round-tripping payloads written by newer ones; consumers validate
 * against ROLE_OPTIONS / TEAM_SIZE_OPTIONS and DROP unrecognised values
 * (never default them).
 */
export interface OnboardingProfile {
	readonly roles?: readonly string[];
	readonly teamSize?: string;
}

export interface OnboardingWizardStateV2 {
	readonly version: 2;
	readonly lastStep: number;
	readonly ai: { readonly choice: OnboardingAiChoice };
	readonly storage: { readonly choice: OnboardingStorageChoice };
	readonly db: { readonly choice: OnboardingDbChoice };
	readonly deploy: { readonly choice: OnboardingDeployChoice };
	/**
	 * A8 — desktop-first bucket. Optional in the persisted shape so a state
	 * blob written before this bucket existed keeps round-tripping; readers
	 * fall back to {@link ONBOARDING_DEFAULT_STATE}'s `cloud`.
	 */
	readonly desktop?: { readonly choice: OnboardingDesktopChoice };
	readonly skippedSteps: readonly string[];
	readonly pluginsReviewed: boolean;
	/**
	 * EW-617 G4: prompt carried over from the landing-page input
	 * (`ever.works/?prompt=…`) so the wizard's "Generate now" step can
	 * kick off generation without re-asking the user. Bounded by the
	 * same 5000-char limit as `CreateItemsGeneratorDto.prompt`.
	 */
	readonly prompt?: string;
	/** Wave 11 — optional "What do you do" answers (roles + team size). */
	readonly profile?: OnboardingProfile;
}

/** Wire shape of `GET /api/onboarding/state`. */
export interface OnboardingStateResponse {
	readonly completedAt: string | null;
	readonly dismissedAt: string | null;
	readonly state: OnboardingWizardStateV2;
	/**
	 * Audit item A53 — the ORGANIZATION-level mirror of the "What do you
	 * do" answers, persisted on `organization_onboarding_profiles`.
	 *
	 * `state.profile` above stays the per-user answer that drives the
	 * wizard UI; this field is the org-wide read model (last writer
	 * inside the organization wins) so team-shaped suggestion surfaces
	 * can reason about the whole organization rather than one member.
	 *
	 * `null` when the request resolved no organization scope (e.g. a
	 * user who has not created an Organization yet) or when nobody in
	 * the organization has answered the step. Optional so older clients
	 * and the web fallback payloads keep type-checking unchanged.
	 */
	readonly organizationProfile?: OnboardingProfile | null;
}

/**
 * Wire shape of `PATCH /api/onboarding/state`. All fields are optional;
 * `state` accepts a partial object that the server deep-merges with the
 * persisted version-2 shape (re-using existing values for missing keys).
 *
 * Security: `state.prompt` MUST be validated server-side with
 * `@MaxLength(5000)` in `OnboardingStatePatchInnerDto` before it is
 * persisted or forwarded to any LLM call. Do NOT wire user-controlled
 * prompt text into agent generation without output constraints/sandboxing.
 */
export interface OnboardingStatePatchRequest {
	readonly state?: Partial<{
		readonly lastStep: number;
		readonly ai: Partial<{ choice: OnboardingAiChoice }>;
		readonly storage: Partial<{ choice: OnboardingStorageChoice }>;
		readonly db: Partial<{ choice: OnboardingDbChoice }>;
		readonly deploy: Partial<{ choice: OnboardingDeployChoice }>;
		/** A8 — desktop-first bucket. */
		readonly desktop: Partial<{ choice: OnboardingDesktopChoice }>;
		readonly skippedSteps: readonly string[];
		readonly pluginsReviewed: boolean;
		/** Max 5 000 chars — enforced by `@MaxLength(5000)` in the server DTO. */
		readonly prompt: string;
		/**
		 * Wave 11 — "What do you do" answers. `roles` entries are validated
		 * server-side against ROLE_OPTIONS ids, `teamSize` against
		 * TEAM_SIZE_OPTIONS ids (unknown values are rejected with 400).
		 */
		readonly profile: {
			readonly roles?: readonly string[];
			readonly teamSize?: string;
		};
	}>;
}

/** Wire shape of `GET /api/onboarding/catalog`. */
export interface OnboardingCatalogResponse {
	readonly ai: ReadonlyArray<OnboardingCard<OnboardingAiChoice>>;
	readonly storage: ReadonlyArray<OnboardingCard<OnboardingStorageChoice>>;
	readonly db: ReadonlyArray<OnboardingCard<OnboardingDbChoice>>;
	readonly deploy: ReadonlyArray<OnboardingCard<OnboardingDeployChoice>>;
	/** A8 — cards for the desktop-first bucket. */
	readonly desktop: ReadonlyArray<OnboardingCard<OnboardingDesktopChoice>>;
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
	db: { choice: 'ever-works-db' },
	deploy: { choice: 'ever-works' },
	desktop: { choice: 'cloud' },
	skippedSteps: [],
	pluginsReviewed: false
};

/**
 * A8 — first-run guidance implied by the desktop bucket. Consumed by the web
 * wizard's final step (and any other surface that wants to point a user at the
 * right next thing) so "which shape am I running" actually changes what the
 * user is told to do next, rather than being a stored preference nobody reads.
 */
export interface OnboardingDesktopNextStep {
	readonly choice: OnboardingDesktopChoice;
	readonly title: string;
	readonly description: string;
	/** In-app route to send the user to, when there is one. */
	readonly href?: string;
}

export const ONBOARDING_DESKTOP_NEXT_STEPS: Readonly<Record<OnboardingDesktopChoice, OnboardingDesktopNextStep>> = {
	cloud: {
		choice: 'cloud',
		title: 'Start building',
		description: 'Everything runs on the hosted platform — create your first Work and go.'
	},
	desktop: {
		choice: 'desktop',
		title: 'Finish your desktop setup',
		description:
			'Ever Works Desktop supervises the API and web app on this machine. Check the services are healthy, then pick the job runtime you want them to use.',
		href: '/settings/job-runtime'
	},
	'own-nodes': {
		choice: 'own-nodes',
		title: 'Add your first node',
		description:
			'Enroll the machines that should execute your work. Issue an enrollment token here, then run the Desktop Node app or the headless node on each machine.',
		href: '/settings/fleet'
	}
};

/** The guidance for a bucket choice, defaulting to the cloud path. */
export function desktopNextStep(choice: OnboardingDesktopChoice | undefined): OnboardingDesktopNextStep {
	return ONBOARDING_DESKTOP_NEXT_STEPS[choice ?? 'cloud'] ?? ONBOARDING_DESKTOP_NEXT_STEPS.cloud;
}
