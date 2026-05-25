import {
    findMissionTemplateConfig,
    listMissionTemplates,
    MISSION_TEMPLATES,
} from '../mission-template.config';

/**
 * Phase 8 PR X — lock the curated Mission Templates catalog so a
 * downstream tick can't silently drop a seeded id (which would
 * orphan existing user forks pointing at that id). Mirrors the
 * shape of the website-template config spec.
 */
describe('mission-template.config (Phase 8 PR X)', () => {
    it('seeds at least one curated Mission Template', () => {
        expect(MISSION_TEMPLATES.length).toBeGreaterThan(0);
    });

    it('every curated template has the required catalog-shape fields', () => {
        for (const template of MISSION_TEMPLATES) {
            expect(typeof template.id).toBe('string');
            expect(template.id.length).toBeGreaterThan(0);
            expect(typeof template.name).toBe('string');
            expect(typeof template.description).toBe('string');
            expect(typeof template.owner).toBe('string');
            expect(typeof template.repo).toBe('string');
            expect(typeof template.branch).toBe('string');
            expect(Array.isArray(template.syncBranches)).toBe(true);
        }
    });

    it("listMissionTemplates returns a fresh copy (mutations don't affect the source)", () => {
        const a = listMissionTemplates();
        const b = listMissionTemplates();
        expect(a).not.toBe(b);
        a.push({
            id: 'sentinel',
            name: 'x',
            description: 'x',
            owner: 'x',
            repo: 'x',
            branch: 'main',
            syncBranches: [],
        });
        expect(b.some((t) => t.id === 'sentinel')).toBe(false);
    });

    it('findMissionTemplateConfig returns the matching template by id', () => {
        const first = MISSION_TEMPLATES[0];
        const found = findMissionTemplateConfig(first.id);
        expect(found).toEqual(first);
    });

    it('findMissionTemplateConfig returns null for unknown / empty / null ids', () => {
        expect(findMissionTemplateConfig('does-not-exist')).toBeNull();
        expect(findMissionTemplateConfig(null)).toBeNull();
        expect(findMissionTemplateConfig(undefined)).toBeNull();
    });

    it('locks the v1 seed: starter-business and starter-content', () => {
        // The Templates page Mission tab depends on these two ids
        // being present in v1. A downstream tick that wants to
        // remove either should update this lock + add a migration
        // path for orphaned user forks.
        const ids = MISSION_TEMPLATES.map((t) => t.id);
        expect(ids).toContain('starter-business');
        expect(ids).toContain('starter-content');
    });
});
