import { describe, expect, it } from 'vitest';
import { SKILL_CARD_STATES, type SkillRequirement } from '@ever-works/contracts';
import en from '../../messages/en.json';
import {
    SKILL_CARD_STATE_BODY_KEYS,
    SKILL_CARD_STATE_TITLE_KEYS,
    SKILL_REQUIREMENT_KIND_KEYS,
    skillRequirementFixHref,
    skillRequirementFixLabelKey,
    skillRequirementStatusKey,
    unmetSkillRequirements,
} from './skill-readiness';

/**
 * Skills shelf — presentation rules shared by the card, the badge and the
 * detail panel. Every key they name must exist in `en.json` (a missing key
 * renders the raw path), no leaf may contain a dot, and a fix link is only
 * ever an in-app route built from an identifier.
 */
const skillsPage = (
    en as unknown as {
        dashboard: {
            skillsPage: { readiness: Record<string, string>; shelf: Record<string, string> };
        };
    }
).dashboard.skillsPage;
const readiness = skillsPage.readiness;
const shelf = skillsPage.shelf;

const row = (over: Partial<SkillRequirement>): SkillRequirement => ({
    kind: 'tool',
    id: 'x',
    status: 'missing',
    ...over,
});

describe('skill readiness copy', () => {
    it('names a title and a body for every card state, all present in en.json', () => {
        for (const state of SKILL_CARD_STATES) {
            expect(readiness[SKILL_CARD_STATE_TITLE_KEYS[state]]).toBeTruthy();
            expect(readiness[SKILL_CARD_STATE_BODY_KEYS[state]]).toBeTruthy();
        }
        for (const key of Object.values(SKILL_REQUIREMENT_KIND_KEYS)) {
            expect(readiness[key]).toBeTruthy();
        }
    });

    it('never uses a dotted leaf key in the shelf sub-trees', () => {
        for (const key of [...Object.keys(readiness), ...Object.keys(shelf)]) {
            expect(key).toMatch(/^[a-z][A-Za-z0-9]*$/);
        }
    });

    it.each([
        [row({ reason: 'notSet' }), 'statusNotSet'],
        [row({ reason: 'notConnected' }), 'statusNotConnected'],
        [row({ reason: 'disabled' }), 'statusDisabled'],
        [row({ status: 'refused', reason: 'refusedByGrants' }), 'statusRefused'],
        [row({ status: 'unknown', reason: 'checkFailed' }), 'statusUnknown'],
        [row({ status: 'met' }), 'statusMet'],
        [row({ status: 'missing' }), 'statusMissing'],
        [row({ status: 'unknown' }), 'statusUnknown'],
    ])('status key for %o is %s and exists', (requirement, key) => {
        expect(skillRequirementStatusKey(requirement)).toBe(key);
        expect(readiness[key]).toBeTruthy();
    });

    it('builds fix links from identifiers only', () => {
        expect(
            skillRequirementFixHref(row({ fixTarget: { surface: 'connections', ref: 'crm' } })),
        ).toBe('/settings/connections');
        expect(
            skillRequirementFixHref(row({ fixTarget: { surface: 'access', ref: 'agent-1' } })),
        ).toBe('/agents/agent-1/capabilities');
        expect(
            skillRequirementFixHref(row({ fixTarget: { surface: 'plugins', ref: 'mail' } })),
        ).toBe('/plugins/mail');
        expect(
            skillRequirementFixHref(
                row({ fixTarget: { surface: 'credentials', ref: 'stripe_key' } }),
            ),
        ).toBeNull();
        expect(
            skillRequirementFixHref(row({ fixTarget: { surface: 'access', ref: '' } })),
        ).toBeNull();
        expect(skillRequirementFixHref(row({}))).toBeNull();
        expect(
            skillRequirementFixLabelKey(row({ fixTarget: { surface: 'access', ref: 'a' } })),
        ).toBe('fixReviewAccess');
        expect(readiness[skillRequirementFixLabelKey(row({}))]).toBeTruthy();
    });

    it('lists only what asks something of a person', () => {
        expect(
            unmetSkillRequirements({
                requirements: [
                    row({ id: 'a', status: 'met' }),
                    row({ id: 'b' }),
                    row({ id: 'c', status: 'refused' }),
                ],
                boundTargetCount: 1,
                mutedBindingCount: 0,
                evaluatedForAgentIds: [],
                evaluatedAt: '2026-09-14T00:00:00.000Z',
            }).map((requirement) => requirement.id),
        ).toEqual(['b', 'c']);
        expect(unmetSkillRequirements(null)).toEqual([]);
    });
});
