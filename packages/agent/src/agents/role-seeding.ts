import { GTM_SKILLS } from '@ever-works/contracts';
import { ROLE_OPTIONS } from '@ever-works/contracts/api';
import type {
    OnboardingRoleId,
    OnboardingSeedAgentSuggestion,
    OnboardingSeedSkillSuggestion,
    OnboardingSeedSuggestionsResponse,
} from '@ever-works/contracts/api';
import { AGENT_TEMPLATES, getAgentTemplate } from './agent-templates';

/**
 * Role → starter-kit mapping for the onboarding "What do you do" step.
 *
 * ## Why this is server-side and exhaustive
 *
 * The first cut derived suggestions in the browser by intersecting the
 * agent catalog's `suggestedRoles` with the selected roles. That made
 * coverage a SIDE EFFECT of how six template authors happened to tag
 * their templates: three of the fourteen roles the step offers produced
 * anything at all, and the other eleven silently got nothing. "Nothing
 * suggested" and "nobody wrote a mapping" look identical to a user, and
 * only one of them is honest.
 *
 * So the mapping is explicit and total. `ROLE_SEED_KITS` has an entry
 * for EVERY id in `ROLE_OPTIONS`, and the spec fails the build when a
 * role is added without one — the coverage guarantee is enforced, not
 * asserted in a comment.
 *
 * ## Why it is not Agents-only
 *
 * A role implies a starting kit, not a starting agent. An agent with no
 * skills is a prompt; the skills are what make it do the job. Each kit
 * therefore names both, and the API returns both.
 *
 * ## Honesty about fit
 *
 * The first-party catalog is go-to-market shaped. For roles it covers
 * well (marketing, sales, founder) the kits are genuinely tailored; for
 * roles it covers loosely (legal, HR, finance) the kit is the closest
 * useful starting point — a monitoring/digest agent and the reporting
 * skills — rather than a pretend-tailored recommendation. Every kit is
 * a suggestion the user can ignore; nothing is gated on the answer.
 */

/** The agents + skills offered for one onboarding role. */
export interface RoleSeedKit {
    /** Prebuilt agent-template slugs, in the order they should be shown. */
    readonly agents: readonly string[];
    /** First-party Skill catalog slugs. */
    readonly skills: readonly string[];
}

/**
 * The mapping. Keyed by `OnboardingRoleId`, so a role added to
 * `ROLE_OPTIONS` without a kit is a TYPE error here and a failing spec
 * — which is the whole point of pinning it.
 */
export const ROLE_SEED_KITS: Readonly<Record<OnboardingRoleId, RoleSeedKit>> = {
    'founder-ceo': {
        agents: ['content-marketer', 'lead-researcher', 'competitive-analyst'],
        skills: ['digest-compilation', 'competitor-watch', 'campaign-reporting'],
    },
    engineering: {
        agents: ['seo-auditor', 'competitive-analyst'],
        skills: ['seo-audit', 'news-signal-detection', 'digest-compilation'],
    },
    product: {
        agents: ['competitive-analyst', 'seo-auditor'],
        skills: ['competitor-watch', 'news-signal-detection', 'engagement-analysis'],
    },
    marketing: {
        agents: ['content-marketer', 'social-scheduler', 'seo-auditor'],
        skills: ['newsletter-drafting', 'social-scheduling', 'seo-audit', 'campaign-reporting'],
    },
    sales: {
        agents: ['lead-researcher', 'outreach-drafter'],
        skills: ['lead-research', 'lead-scoring', 'outreach-personalization', 'follow-up-cadence'],
    },
    consultant: {
        agents: ['competitive-analyst', 'content-marketer'],
        skills: ['competitor-watch', 'digest-compilation', 'newsletter-drafting'],
    },
    research: {
        agents: ['competitive-analyst', 'lead-researcher'],
        skills: ['competitor-watch', 'news-signal-detection', 'digest-compilation'],
    },
    operations: {
        agents: ['competitive-analyst', 'content-marketer'],
        skills: ['crm-sync-hygiene', 'digest-compilation', 'campaign-reporting'],
    },
    support: {
        agents: ['content-marketer'],
        skills: ['reply-detection', 'follow-up-cadence', 'engagement-analysis'],
    },
    finance: {
        agents: ['competitive-analyst'],
        skills: ['campaign-reporting', 'digest-compilation', 'engagement-analysis'],
    },
    hr: {
        agents: ['content-marketer', 'social-scheduler'],
        skills: ['newsletter-drafting', 'digest-compilation', 'social-scheduling'],
    },
    legal: {
        agents: ['competitive-analyst'],
        skills: ['risk-filter', 'competitor-watch', 'digest-compilation'],
    },
    education: {
        agents: ['content-marketer', 'social-scheduler'],
        skills: ['newsletter-drafting', 'social-scheduling', 'digest-compilation'],
    },
    other: {
        agents: ['content-marketer'],
        skills: ['digest-compilation', 'newsletter-drafting'],
    },
};

/** Every role id the onboarding step offers, as a lookup set. */
const KNOWN_ROLE_IDS: ReadonlySet<string> = new Set(ROLE_OPTIONS.map((option) => option.id));

/**
 * Fold a role tag to the kebab-case id space.
 *
 * Callers legitimately hold role tags in two shapes: the wizard stores
 * `ROLE_OPTIONS` ids (`founder-ceo`), while the agent templates carry
 * display-cased hints (`Founder/CEO`). Normalising both into one space
 * is what lets a template's own `suggestedRoles` stay human-readable
 * without a translation table at every call site.
 */
export function normalizeRoleId(tag: string): string {
    return tag
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Split incoming role tags into recognised ids and unknown ones.
 *
 * Unknown values are DROPPED, never defaulted — the same posture the
 * wizard state uses for `profile.roles`. Order is preserved and
 * duplicates collapse, so `['Marketing', 'marketing']` is one role.
 */
export function partitionRoles(roles: readonly string[] | undefined | null): {
    known: OnboardingRoleId[];
    unknown: string[];
} {
    const known: OnboardingRoleId[] = [];
    const unknown: string[] = [];
    for (const raw of roles ?? []) {
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const id = normalizeRoleId(raw);
        if (KNOWN_ROLE_IDS.has(id)) {
            if (!known.includes(id as OnboardingRoleId)) known.push(id as OnboardingRoleId);
        } else if (!unknown.includes(raw)) {
            unknown.push(raw);
        }
    }
    return { known, unknown };
}

/** Default cap on how many agents / skills one resolution returns. */
export const ROLE_SEED_MAX_AGENTS = 3;
export const ROLE_SEED_MAX_SKILLS = 6;

export interface ResolveRoleSeedOptions {
    maxAgents?: number;
    maxSkills?: number;
}

/**
 * Resolve the starter kit for a set of selected roles.
 *
 * Multi-select is normal (the step says so), so kits are UNIONED in
 * role order with duplicates collapsed, and each suggestion records
 * which roles produced it — the UI can say "because you picked Sales"
 * instead of presenting an unexplained list.
 *
 * A slug that no longer exists in either catalog is skipped rather than
 * emitted as a broken card; the integrity spec is what stops that from
 * happening quietly in the first place.
 */
export function resolveRoleSeedSuggestions(
    roles: readonly string[] | undefined | null,
    options: ResolveRoleSeedOptions = {},
): OnboardingSeedSuggestionsResponse {
    const { known, unknown } = partitionRoles(roles);
    const maxAgents = Math.max(0, options.maxAgents ?? ROLE_SEED_MAX_AGENTS);
    const maxSkills = Math.max(0, options.maxSkills ?? ROLE_SEED_MAX_SKILLS);

    const agentMatches = new Map<string, string[]>();
    const skillMatches = new Map<string, string[]>();
    for (const role of known) {
        const kit = ROLE_SEED_KITS[role];
        for (const slug of kit.agents) {
            const existing = agentMatches.get(slug);
            if (existing) existing.push(role);
            else agentMatches.set(slug, [role]);
        }
        for (const slug of kit.skills) {
            const existing = skillMatches.get(slug);
            if (existing) existing.push(role);
            else skillMatches.set(slug, [role]);
        }
    }

    const agents: OnboardingSeedAgentSuggestion[] = [];
    for (const [slug, matchedRoles] of agentMatches) {
        if (agents.length >= maxAgents) break;
        const template = getAgentTemplate(slug);
        if (!template) continue;
        agents.push({
            slug: template.slug,
            name: template.name,
            title: template.title,
            description: template.description,
            category: template.category,
            matchedRoles,
        });
    }

    const skills: OnboardingSeedSkillSuggestion[] = [];
    for (const [slug, matchedRoles] of skillMatches) {
        if (skills.length >= maxSkills) break;
        const skill = GTM_SKILLS.find((entry) => entry.slug === slug);
        if (!skill) continue;
        skills.push({
            slug: skill.slug,
            title: skill.title,
            description: skill.description,
            stage: skill.stage,
            matchedRoles,
        });
    }

    return { roles: known, unknownRoles: unknown, agents, skills };
}

/**
 * Agent-template slugs to seed for the given roles, in kit order and
 * capped the same way the suggestion surface is — so "seed my starter
 * agents" creates exactly the kit the user was shown, not a superset.
 */
export function resolveSeedableAgentSlugs(
    roles: readonly string[] | undefined | null,
    options: ResolveRoleSeedOptions = {},
): string[] {
    return resolveRoleSeedSuggestions(roles, options).agents.map((agent) => agent.slug);
}

/** Every template slug referenced by any kit — used by the integrity spec. */
export function listSeedReferencedAgentSlugs(): string[] {
    const slugs = new Set<string>();
    for (const kit of Object.values(ROLE_SEED_KITS)) {
        for (const slug of kit.agents) slugs.add(slug);
    }
    return [...slugs];
}

/** Every skill slug referenced by any kit — used by the integrity spec. */
export function listSeedReferencedSkillSlugs(): string[] {
    const slugs = new Set<string>();
    for (const kit of Object.values(ROLE_SEED_KITS)) {
        for (const slug of kit.skills) slugs.add(slug);
    }
    return [...slugs];
}

/** Exposed for the integrity spec: the catalog the kits resolve against. */
export const SEED_AGENT_TEMPLATE_SLUGS: readonly string[] = AGENT_TEMPLATES.map((t) => t.slug);
