/**
 * EW-617 G8 — wire format for the zero-friction prompt → deployed Work
 * funnel events.
 *
 * These types pin the canonical event names + payload shapes so the
 * emit sites (G1 landing form, G2 anon auth, G3 claim, G4 quick-create,
 * deploy.service.ts, etc.) all agree on the schema and downstream
 * consumers (PostHog dashboards, log queries, the OpenTelemetry sink)
 * can rely on stable fields.
 *
 * Emit sites in scope:
 *
 *   landing-prompt-submit       — website  (G1) — apps/web/components/global/LandingPromptForm.tsx
 *   anon-user-created           — platform (G2) — apps/api/.../anonymous-auth.service.ts
 *   wizard-finished             — platform (G4) — apps/web/components/onboarding/EverWorksOnboardingWizard.tsx
 *   work-created                — platform (G4) — apps/api/.../works.controller.ts (quickCreateWork)
 *   repos-pushed                — platform       — packages/agent/src/services/work-lifecycle.service.ts (EW-614 path)
 *   deploy-started              — platform       — apps/api/.../deploy.service.ts (deploy())
 *   deploy-ready                — platform       — apps/api/.../tasks/deployment-verifier.service.ts
 *   claim-account               — platform (G3) — apps/api/.../claim-account.service.ts
 *
 * Bumping the schema version is a follow-up PR; for now treat the
 * shapes as additive (clients should ignore unknown fields).
 */

export const ZERO_FRICTION_FUNNEL_EVENTS = {
	LANDING_PROMPT_SUBMIT: 'zero_friction.landing_prompt_submit',
	ANON_USER_CREATED: 'zero_friction.anon_user_created',
	WIZARD_FINISHED: 'zero_friction.wizard_finished',
	WORK_CREATED: 'zero_friction.work_created',
	REPOS_PUSHED: 'zero_friction.repos_pushed',
	DEPLOY_STARTED: 'zero_friction.deploy_started',
	DEPLOY_READY: 'zero_friction.deploy_ready',
	CLAIM_ACCOUNT: 'zero_friction.claim_account'
} as const;

export type ZeroFrictionFunnelEvent = (typeof ZERO_FRICTION_FUNNEL_EVENTS)[keyof typeof ZERO_FRICTION_FUNNEL_EVENTS];

export interface FunnelEventBase {
	/** ISO 8601 timestamp the event was emitted. */
	readonly timestamp: string;
	/**
	 * Correlation id that survives across the full funnel. Origin: G1
	 * mints a UUID v4 on submit, carries it via the URL fragment
	 * (`#prompt=…&corrId=…`), G4 reads it into wizard state, every
	 * downstream emit reuses it. Lets ops trace a single user across
	 * multiple services + asynchronous task runs.
	 */
	readonly correlationId: string;
	/**
	 * Numeric step (1..8) so PostHog can build a funnel without
	 * hard-coding event ordering. Pinned at the top of each interface
	 * below.
	 */
	readonly funnelStep: number;
}

export interface LandingPromptSubmitEvent extends FunnelEventBase {
	readonly funnelStep: 1;
	readonly event: typeof ZERO_FRICTION_FUNNEL_EVENTS.LANDING_PROMPT_SUBMIT;
	readonly promptLength: number;
	/** UA family for top-of-funnel segmentation; never raw UA string. */
	readonly clientKind: 'browser' | 'crawler' | 'unknown';
	readonly referer?: string | null;
}

export interface AnonUserCreatedEvent extends FunnelEventBase {
	readonly funnelStep: 2;
	readonly event: typeof ZERO_FRICTION_FUNNEL_EVENTS.ANON_USER_CREATED;
	readonly anonUserId: string;
	readonly anonymousExpiresAt: string;
	/** Truncated /24 (IPv4) or /48 (IPv6) so we never persist raw IPs. */
	readonly ipPrefix: string | null;
}

export interface WizardFinishedEvent extends FunnelEventBase {
	readonly funnelStep: 3;
	readonly event: typeof ZERO_FRICTION_FUNNEL_EVENTS.WIZARD_FINISHED;
	readonly userId: string;
	readonly isAnonymous: boolean;
	/** Choices captured at the moment Generate-now was clicked. */
	readonly aiChoice: string;
	readonly storageChoice: string;
	readonly deployChoice: string;
}

export interface WorkCreatedEvent extends FunnelEventBase {
	readonly funnelStep: 4;
	readonly event: typeof ZERO_FRICTION_FUNNEL_EVENTS.WORK_CREATED;
	readonly userId: string;
	readonly workId: string;
	readonly workSlug: string;
	/** True when the row was created via /api/works/quick-create. */
	readonly viaQuickCreate: boolean;
}

export interface ReposPushedEvent extends FunnelEventBase {
	readonly funnelStep: 5;
	readonly event: typeof ZERO_FRICTION_FUNNEL_EVENTS.REPOS_PUSHED;
	readonly workId: string;
	/** `ever-works-cloud/<slug>-data`, `<slug>-website`, `<slug>-mcp`. */
	readonly repos: readonly string[];
}

export interface DeployStartedEvent extends FunnelEventBase {
	readonly funnelStep: 6;
	readonly event: typeof ZERO_FRICTION_FUNNEL_EVENTS.DEPLOY_STARTED;
	readonly workId: string;
	readonly deployProvider: string;
	readonly ingressHost: string | null;
}

export interface DeployReadyEvent extends FunnelEventBase {
	readonly funnelStep: 7;
	readonly event: typeof ZERO_FRICTION_FUNNEL_EVENTS.DEPLOY_READY;
	readonly workId: string;
	readonly websiteUrl: string;
	/** Milliseconds from `deploy-started` to `deploy-ready`. */
	readonly elapsedMs: number;
}

export interface ClaimAccountEvent extends FunnelEventBase {
	readonly funnelStep: 8;
	readonly event: typeof ZERO_FRICTION_FUNNEL_EVENTS.CLAIM_ACCOUNT;
	readonly userId: string;
	/** True if the user came in via the zero-friction flow + claimed. */
	readonly viaZeroFriction: boolean;
}

export type ZeroFrictionFunnelPayload =
	| LandingPromptSubmitEvent
	| AnonUserCreatedEvent
	| WizardFinishedEvent
	| WorkCreatedEvent
	| ReposPushedEvent
	| DeployStartedEvent
	| DeployReadyEvent
	| ClaimAccountEvent;
