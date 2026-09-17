import { ROLE_OPTIONS, ROSTER_BLUEPRINT_SLUGS, ROSTER_MAX_LANES } from '@ever-works/contracts/api';
import type { OnboardingRoleId } from '@ever-works/contracts/api';
import { AGENT_TEMPLATES } from '../agent-templates';
import {
    LANE_CATALOG,
    ROLE_BLUEPRINT_VOTES,
    ROSTER_BLUEPRINTS,
    getLaneSpec,
    laneCapForTeamSize,
    listLaneCatalog,
    proposeRoster,
    selectBlueprint,
} from '../roster-blueprints';

/**
 * AW-20 P1 — catalog-integrity and determinism pins for the roster
 * blueprints.
 *
 * Two classes of failure this suite exists to stop:
 *
 *  1. **A silent coverage gap.** A role added to `ROLE_OPTIONS` without a
 *     blueprint would fall through to "general" and look tailored. That
 *     is the exact failure `ROLE_SEED_KITS` was introduced to fix, and
 *     the same pin is what keeps it fixed here.
 *  2. **A lane pointing at nothing.** A `templateSlug` that no longer
 *     exists turns a proposed agent into a create that 404s at the worst
 *     possible moment — halfway through provisioning, after the user
 *     already pressed the button.
 */
describe('roster blueprint catalogue integrity', () => {
    it('maps every onboarding role to a blueprint that exists', () => {
        const missing: string[] = [];
        for (const option of ROLE_OPTIONS) {
            const slug = ROLE_BLUEPRINT_VOTES[option.id as OnboardingRoleId];
            if (!slug || !ROSTER_BLUEPRINTS[slug]) missing.push(option.id);
        }
        expect(missing).toEqual([]);
        expect(Object.keys(ROLE_BLUEPRINT_VOTES).sort()).toEqual(
            ROLE_OPTIONS.map((option) => option.id).sort(),
        );
    });

    it('points every lane at a template the catalog actually ships', () => {
        const slugs = new Set(AGENT_TEMPLATES.map((template) => template.slug));
        const broken: string[] = [];
        for (const spec of listLaneCatalog()) {
            if (!slugs.has(spec.templateSlug))
                broken.push(`${spec.laneKey} → ${spec.templateSlug}`);
        }
        expect(broken).toEqual([]);
    });

    it('opens every blueprint with the coordinator, and marks no other lane as one', () => {
        for (const slug of ROSTER_BLUEPRINT_SLUGS) {
            const blueprint = ROSTER_BLUEPRINTS[slug];
            expect(blueprint.slug).toBe(slug);
            expect(blueprint.lanes.length).toBeGreaterThan(0);
            expect(blueprint.lanes[0].isCoordinator).toBe(true);
            expect(blueprint.lanes.slice(1).some((lane) => lane.isCoordinator)).toBe(false);
        }
    });

    it('keeps every blueprint inside the lane ceiling and free of repeats', () => {
        for (const slug of ROSTER_BLUEPRINT_SLUGS) {
            const lanes = ROSTER_BLUEPRINTS[slug].lanes;
            expect(lanes.length).toBeLessThanOrEqual(ROSTER_MAX_LANES);
            const keys = lanes.map((lane) => lane.laneKey);
            expect(new Set(keys).size).toBe(keys.length);
        }
    });

    it('caps the lane catalogue at twelve entries with one template each', () => {
        const catalog = listLaneCatalog();
        expect(catalog.length).toBeLessThanOrEqual(12);
        const templates = catalog.map((spec) => spec.templateSlug);
        expect(new Set(templates).size).toBe(templates.length);
        // Only the coordination lane is a coordinator, catalogue-wide.
        expect(catalog.filter((spec) => spec.isCoordinator).map((spec) => spec.laneKey)).toEqual([
            'coordination',
        ]);
    });

    it('gives every lane a camelCase, dot-free i18n leaf', () => {
        for (const spec of listLaneCatalog()) {
            // A literal dot in a leaf name makes next-intl throw at
            // runtime and reds whole e2e shards.
            expect(spec.labelKey).not.toContain('.');
            expect(spec.labelKey).toMatch(/^[a-z][a-zA-Z0-9]*$/);
            expect(spec.defaultName.trim().length).toBeGreaterThan(0);
        }
    });

    it('resolves a lane by key and returns undefined for one it does not ship', () => {
        expect(getLaneSpec('research')?.templateSlug).toBe('lead-researcher');
        expect(getLaneSpec('not-a-lane')).toBeUndefined();
        expect(Object.keys(LANE_CATALOG)).toContain('coordination');
    });
});

describe('selectBlueprint', () => {
    it('returns the general blueprint for no roles, unknown roles and null', () => {
        expect(selectBlueprint(null).slug).toBe('general');
        expect(selectBlueprint([]).slug).toBe('general');
        expect(selectBlueprint(['not-a-role', 'also-not']).slug).toBe('general');
    });

    it('picks the blueprint the answered roles vote for', () => {
        expect(selectBlueprint(['marketing']).slug).toBe('growth');
        expect(selectBlueprint(['sales']).slug).toBe('revenue');
        expect(selectBlueprint(['research']).slug).toBe('insight');
    });

    it('proposes a different blueprint for marketing-shaped than research-shaped answers', () => {
        expect(selectBlueprint(['marketing', 'marketing']).slug).not.toBe(
            selectBlueprint(['research', 'product']).slug,
        );
    });

    it('is deterministic across shuffles of the same answers', () => {
        const roles = ['marketing', 'sales', 'research', 'product'];
        const expected = selectBlueprint(roles).slug;
        for (let i = 0; i < 100; i += 1) {
            const shuffled = [...roles].sort(() => Math.random() - 0.5);
            expect(selectBlueprint(shuffled).slug).toBe(expected);
        }
    });

    it('breaks a tie on catalogue order, not on the order the user answered in', () => {
        // marketing → growth, sales → revenue: one vote each. `growth`
        // precedes `revenue` in ROSTER_BLUEPRINT_SLUGS, so it wins both
        // ways round.
        expect(selectBlueprint(['marketing', 'sales']).slug).toBe('growth');
        expect(selectBlueprint(['sales', 'marketing']).slug).toBe('growth');
    });

    it('ignores values it does not recognise rather than defaulting them', () => {
        expect(selectBlueprint(['sales', 'not-a-role']).slug).toBe('revenue');
        expect(selectBlueprint([' SALES ']).slug).toBe('revenue');
    });
});

describe('laneCapForTeamSize', () => {
    it('returns the five documented numbers', () => {
        expect(laneCapForTeamSize('solo')).toBe(3);
        expect(laneCapForTeamSize('small-2-10')).toBe(5);
        expect(laneCapForTeamSize('mid-11-50')).toBe(6);
        expect(laneCapForTeamSize('large-51-200')).toBe(8);
        expect(laneCapForTeamSize('enterprise-200-plus')).toBe(8);
    });

    it('falls back to five for unanswered and unrecognised sizes', () => {
        expect(laneCapForTeamSize(undefined)).toBe(5);
        expect(laneCapForTeamSize(null)).toBe(5);
        expect(laneCapForTeamSize('enormous')).toBe(5);
    });
});

describe('proposeRoster', () => {
    it('trims from the end to the team-size cap', () => {
        const solo = proposeRoster(['marketing'], 'solo');
        expect(solo).toHaveLength(3);
        expect(solo.map((lane) => lane.laneKey)).toEqual(
            ROSTER_BLUEPRINTS.growth.lanes.slice(0, 3).map((lane) => lane.laneKey),
        );
    });

    it('allows eight lanes for a large team without exceeding the blueprint', () => {
        const large = proposeRoster(['marketing'], 'large-51-200');
        expect(large.length).toBeLessThanOrEqual(8);
        expect(large.map((lane) => lane.laneKey)).toEqual(
            ROSTER_BLUEPRINTS.growth.lanes.map((lane) => lane.laneKey),
        );
    });

    it('never drops the coordinator, whatever the cap', () => {
        for (const teamSize of [
            'solo',
            'small-2-10',
            'mid-11-50',
            'large-51-200',
            'enterprise-200-plus',
            undefined,
        ]) {
            const proposal = proposeRoster(['marketing', 'sales', 'research'], teamSize);
            expect(proposal.length).toBeGreaterThan(0);
            expect(proposal[0].isCoordinator).toBe(true);
        }
    });

    it('never proposes more lanes than the ceiling', () => {
        for (const slug of ROSTER_BLUEPRINT_SLUGS) {
            const roles = Object.entries(ROLE_BLUEPRINT_VOTES)
                .filter(([, vote]) => vote === slug)
                .map(([role]) => role);
            const proposal = proposeRoster(roles, 'enterprise-200-plus');
            expect(proposal.length).toBeLessThanOrEqual(ROSTER_MAX_LANES);
        }
    });
});
