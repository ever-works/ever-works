/**
 * AW-20 — the seam that attaches one catalog Skill to one Agent.
 *
 * A PORT, not a class. Installing a Skill from the catalog needs the
 * catalog facade, which lives api-side with the plugin capability layer;
 * `RosterProvisioningService` has to stay runtime-free so it can be unit
 * tested and run from the Trigger worker. So provisioning asks for
 * "attach this slug to that agent" and does not care who can do it.
 *
 * Unbound — a unit test, or an install with no skill catalog wired — the
 * binding step is SKIPPED silently rather than reported as a warning on
 * every lane. "We did not try" and "we tried and failed" are different
 * facts, and only the second one is worth telling the user about.
 *
 * Contract for implementors: `attach` is idempotent per
 * (user, agent, slug). Installing a Skill the user already has, or
 * re-binding one already bound, must resolve rather than throw — a lane
 * retry will call this again.
 */
export interface RosterSkillBinder {
    attach(input: {
        readonly userId: string;
        readonly agentId: string;
        readonly skillSlug: string;
        readonly organizationId: string | null;
    }): Promise<void>;
}

export const ROSTER_SKILL_BINDER = 'ROSTER_SKILL_BINDER' as const;
