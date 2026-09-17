import { ROLE_OPTIONS, ROSTER_BLUEPRINT_SLUGS, ROSTER_MAX_LANES } from '@ever-works/contracts/api';
import type {
    OnboardingRoleId,
    RosterBlueprintSlug,
    RosterLaneKey,
} from '@ever-works/contracts/api';
import { AGENT_TEMPLATES } from './agent-templates';

/**
 * AW-20 P1 — roster blueprints: which agents we propose to a new owner,
 * and why.
 *
 * ## Why this is code and not a table
 *
 * A blueprint changes when we ship, never when a user acts. It carries no
 * per-person state and it has to mean the same thing in a bug report as
 * it does in production. Persisting it would buy a migration, a seeder, a
 * drift risk between environments and an admin surface nobody asked for.
 * `AGENT_TEMPLATES` and `ROLE_SEED_KITS` are already carried this way;
 * this is the third instance of the same call.
 *
 * ## Why the role map is exhaustive
 *
 * `ROLE_BLUEPRINT_VOTES` is keyed by `OnboardingRoleId`, so a role added
 * to `ROLE_OPTIONS` without a blueprint is a TYPE error here and a
 * failing spec — the same pin `ROLE_SEED_KITS` uses, for the same reason
 * it was introduced there: "nothing suggested" and "nobody wrote a
 * mapping" look identical to a user, and only one of them is honest. A
 * user who answers a role we forgot must not silently fall through to a
 * default that pretends to be tailored.
 *
 * ## What a lane is, and is not
 *
 * A lane is a label naming the area of work one Agent owns. It grants
 * nothing and restricts nothing, and no authorization decision may read
 * it. It exists so provisioning can ask "is this lane already filled?"
 * and the starter-brief picker can ask "who owns research here?" without
 * guessing from free text.
 */

/** One proposed roster member: a lane, the template behind it, its default name. */
export interface RosterLaneSpec {
    readonly laneKey: RosterLaneKey;
    /** i18n leaf under `onboarding.rosterStep.lanes` — camelCase, never dotted. */
    readonly labelKey: string;
    /** Must exist in `AGENT_TEMPLATES`; pinned by the integrity spec. */
    readonly templateSlug: string;
    readonly defaultName: string;
    /** Exactly one lane per blueprint carries this, and it is always index 0. */
    readonly isCoordinator?: true;
}

/** A named, ordered list of lanes. `lanes[0].isCoordinator === true` always. */
export interface RosterBlueprint {
    readonly slug: RosterBlueprintSlug;
    readonly lanes: readonly RosterLaneSpec[];
}

/**
 * Every lane the platform knows how to provision — the menu behind
 * "+ Add a lane" as well as the source every blueprint composes from.
 * Capped at 12 entries (FR-30); each maps to exactly one prebuilt
 * template.
 */
export const LANE_CATALOG: Readonly<Record<RosterLaneKey, RosterLaneSpec>> = {
    coordination: {
        laneKey: 'coordination',
        labelKey: 'coordination',
        templateSlug: 'workspace-coordinator',
        defaultName: 'Ada',
        isCoordinator: true,
    },
    research: {
        laneKey: 'research',
        labelKey: 'research',
        templateSlug: 'lead-researcher',
        defaultName: 'Research',
    },
    content: {
        laneKey: 'content',
        labelKey: 'content',
        templateSlug: 'content-marketer',
        defaultName: 'Content',
    },
    outreach: {
        laneKey: 'outreach',
        labelKey: 'outreach',
        templateSlug: 'outreach-drafter',
        defaultName: 'Outreach',
    },
    visibility: {
        laneKey: 'visibility',
        labelKey: 'visibility',
        templateSlug: 'seo-auditor',
        defaultName: 'Visibility',
    },
    social: {
        laneKey: 'social',
        labelKey: 'social',
        templateSlug: 'social-scheduler',
        defaultName: 'Social',
    },
    'market-watch': {
        laneKey: 'market-watch',
        labelKey: 'marketWatch',
        templateSlug: 'competitive-analyst',
        defaultName: 'Market watch',
    },
};

/** Compose a blueprint from lane keys; coordination is always first. */
function blueprint(slug: RosterBlueprintSlug, laneKeys: readonly RosterLaneKey[]): RosterBlueprint {
    return { slug, lanes: laneKeys.map((key) => LANE_CATALOG[key]) };
}

/**
 * The five blueprints. Every one opens with `coordination` (FR-8): a
 * roster without somewhere to hand an ambiguous request is a list of
 * specialists, which is the thing this epic exists to stop shipping.
 */
export const ROSTER_BLUEPRINTS: Readonly<Record<RosterBlueprintSlug, RosterBlueprint>> = {
    general: blueprint('general', ['coordination', 'research', 'content', 'market-watch']),
    growth: blueprint('growth', [
        'coordination',
        'content',
        'social',
        'visibility',
        'market-watch',
    ]),
    revenue: blueprint('revenue', ['coordination', 'outreach', 'research', 'content']),
    insight: blueprint('insight', ['coordination', 'research', 'market-watch']),
    'solo-starter': blueprint('solo-starter', ['coordination', 'content']),
};

/**
 * Role → blueprint vote. Total over `ROLE_OPTIONS` by construction: a new
 * role without an entry fails to compile.
 *
 * Honesty about fit, same as `ROLE_SEED_KITS`: the first-party catalog is
 * go-to-market shaped. Roles it covers well (marketing, sales, founder)
 * get a genuinely tailored blueprint; roles it covers loosely (legal, HR,
 * finance) get the closest useful starting point rather than a
 * pretend-tailored one. Every proposal is editable before anything is
 * created.
 */
export const ROLE_BLUEPRINT_VOTES: Readonly<Record<OnboardingRoleId, RosterBlueprintSlug>> = {
    'founder-ceo': 'general',
    engineering: 'insight',
    product: 'insight',
    marketing: 'growth',
    sales: 'revenue',
    consultant: 'revenue',
    research: 'insight',
    operations: 'general',
    support: 'general',
    finance: 'insight',
    hr: 'general',
    legal: 'insight',
    education: 'growth',
    other: 'general',
};

const KNOWN_ROLE_IDS: ReadonlySet<string> = new Set(ROLE_OPTIONS.map((option) => option.id));

/**
 * Pick the blueprint for a set of answered roles.
 *
 * Pure and deterministic (FR-4): votes are counted, the highest count
 * wins, ties break on `ROSTER_BLUEPRINT_SLUGS` order, and an empty or
 * entirely unrecognised list returns `general`. Determinism matters
 * because the proposal is shown, edited and then re-derived when the user
 * walks back to the roles step — a shuffled answer order must not change
 * what we propose.
 */
export function selectBlueprint(roles: readonly string[] | null | undefined): RosterBlueprint {
    const votes = new Map<RosterBlueprintSlug, number>();
    for (const raw of roles ?? []) {
        if (typeof raw !== 'string') continue;
        const id = raw.trim().toLowerCase();
        if (!KNOWN_ROLE_IDS.has(id)) continue;
        const slug = ROLE_BLUEPRINT_VOTES[id as OnboardingRoleId];
        votes.set(slug, (votes.get(slug) ?? 0) + 1);
    }

    let winner: RosterBlueprintSlug = 'general';
    let best = 0;
    // Iterate the catalogue, not the map: catalogue order IS the
    // tie-break, and a Map iterates in insertion order — which is the
    // user's answer order, the one thing that must not decide this.
    for (const slug of ROSTER_BLUEPRINT_SLUGS) {
        const count = votes.get(slug) ?? 0;
        if (count > best) {
            best = count;
            winner = slug;
        }
    }
    return ROSTER_BLUEPRINTS[winner];
}

/**
 * How many lanes we propose for a team of this size (FR-5). Unanswered —
 * and anything we do not recognise — is 5: the middle of the range, not
 * the largest, because over-proposing costs seats.
 */
export function laneCapForTeamSize(teamSize: string | null | undefined): number {
    switch (teamSize) {
        case 'solo':
            return 3;
        case 'small-2-10':
            return 5;
        case 'mid-11-50':
            return 6;
        case 'large-51-200':
            return 8;
        case 'enterprise-200-plus':
            return 8;
        default:
            return 5;
    }
}

/**
 * The proposal: the selected blueprint's lanes, trimmed from the END to
 * the team-size cap. Index 0 — the coordinator — is never trimmed, even
 * at a cap of 1: a roster with no coordinator is exactly the shape this
 * epic set out to replace.
 */
export function proposeRoster(
    roles: readonly string[] | null | undefined,
    teamSize: string | null | undefined,
): readonly RosterLaneSpec[] {
    const { lanes } = selectBlueprint(roles);
    const cap = Math.min(Math.max(1, laneCapForTeamSize(teamSize)), ROSTER_MAX_LANES);
    return lanes.slice(0, cap);
}

/** Every lane spec, in catalogue order — the "+ Add a lane" menu. */
export function listLaneCatalog(): readonly RosterLaneSpec[] {
    return Object.values(LANE_CATALOG);
}

/** One lane spec by key; undefined when the key is not in the catalogue. */
export function getLaneSpec(laneKey: string): RosterLaneSpec | undefined {
    return (LANE_CATALOG as Record<string, RosterLaneSpec>)[laneKey];
}

/** Exposed for the integrity spec: the catalog lane templates resolve against. */
export const ROSTER_TEMPLATE_SLUGS: readonly string[] = AGENT_TEMPLATES.map(
    (template) => template.slug,
);
