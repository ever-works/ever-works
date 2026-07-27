/**
 * Role-driven starter seeding for the onboarding "What do you do" step.
 *
 * The first cut of this feature resolved suggestions IN THE BROWSER: the
 * step fetched the whole prebuilt-agent catalog and intersected
 * `suggestedRoles` client-side. Three things were wrong with that.
 *
 *  1. Coverage was accidental. Only the roles that happened to appear in
 *     a go-to-market template's `suggestedRoles` produced anything —
 *     3 of the 14 roles the step actually offers. The other 11 selected
 *     a role and were shown nothing, which reads as "we have nothing
 *     for you" rather than "nobody wrote the mapping".
 *  2. It was Agents-only. A role implies a starting KIT — the agents to
 *     activate AND the skills that make them useful — and the skills
 *     half simply did not exist.
 *  3. The mapping lived in the client bundle, so every non-web surface
 *     (desktop shell, chat, API consumers) had no way to ask "what
 *     should a Marketing person start with?".
 *
 * The mapping is therefore server-side (`@ever-works/agent/agents`,
 * `role-seeding.ts`), exposed over `/api/onboarding/suggestions`, and
 * pinned by a spec that fails if ANY role in `ROLE_OPTIONS` is missing.
 * These are the wire shapes for that surface.
 */

/** One prebuilt Agent template offered for the selected roles. */
export interface OnboardingSeedAgentSuggestion {
	/** Template slug — the id `POST /api/agents/from-template/:slug` takes. */
	readonly slug: string;
	readonly name: string;
	readonly title: string;
	readonly description: string;
	/** Template category, e.g. `marketing` / `sales` / `ops`. */
	readonly category: string;
	/** Role ids (from `ROLE_OPTIONS`) that caused this template to surface. */
	readonly matchedRoles: readonly string[];
}

/** One first-party Skill offered for the selected roles. */
export interface OnboardingSeedSkillSuggestion {
	/** Skill catalog slug. */
	readonly slug: string;
	readonly title: string;
	readonly description: string;
	/** Go-to-market stage the Skill powers. */
	readonly stage: string;
	/** Role ids (from `ROLE_OPTIONS`) that caused this Skill to surface. */
	readonly matchedRoles: readonly string[];
}

/**
 * Wire shape of `GET /api/onboarding/suggestions`.
 *
 * `roles` echoes the RECOGNISED subset of the request (unknown ids are
 * dropped, never defaulted, matching how the wizard state validates its
 * own `profile.roles`). An empty `roles` yields empty suggestion lists
 * rather than a "here is everything" dump.
 */
export interface OnboardingSeedSuggestionsResponse {
	readonly roles: readonly string[];
	/** Ids that were sent but are not in `ROLE_OPTIONS` — echoed so the caller can notice a typo. */
	readonly unknownRoles: readonly string[];
	readonly agents: readonly OnboardingSeedAgentSuggestion[];
	readonly skills: readonly OnboardingSeedSkillSuggestion[];
}

/**
 * Request body of `POST /api/onboarding/suggestions/seed`.
 *
 * `roles` is optional: omitted, the server uses the roles already saved
 * on the caller's onboarding state, so the client never has to be the
 * authority on what the user picked.
 */
export interface OnboardingSeedRequest {
	readonly roles?: readonly string[];
}

/** Per-template outcome of a seeding run. */
export type OnboardingSeedOutcome = 'created' | 'already-exists' | 'failed';

export interface OnboardingSeedResultEntry {
	readonly slug: string;
	readonly outcome: OnboardingSeedOutcome;
	/** Id of the Agent created by THIS run; null for every other outcome. */
	readonly agentId: string | null;
	/** Short, non-sensitive reason — present only for `failed`. */
	readonly reason?: string;
}

/**
 * Wire shape of `POST /api/onboarding/suggestions/seed`.
 *
 * Seeding is idempotent and best-effort per template: a template that
 * is already activated reports `already-exists` instead of failing the
 * whole call, so re-running the step never produces duplicates and a
 * single bad template never blocks the rest of the kit.
 */
export interface OnboardingSeedResponse {
	readonly roles: readonly string[];
	readonly agents: readonly OnboardingSeedResultEntry[];
	/** Skills recommended alongside the seeded agents (informational). */
	readonly skills: readonly OnboardingSeedSkillSuggestion[];
	readonly createdCount: number;
	readonly skippedCount: number;
	readonly failedCount: number;
}
