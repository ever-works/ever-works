import { listAstTemplates, getAstTemplate } from './agent-templates';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 18.6.
 *
 * Until the unified Workshop Templates catalog (ADR-010) ships, the
 * three Templates routes (`/agents/templates`, `/skills/templates`,
 * `/tasks/templates`) hydrate from this fallback list. Locking the
 * shape so a future fetch swap doesn't silently change rows on the
 * page — and so the `getAstTemplate(slug)` lookup behaves
 * predictably for the `?from=<slug>` pre-fill.
 */
describe('agent-templates fallback catalog', () => {
    it('lists at least one entry per entity type', async () => {
        const agents = await listAstTemplates('agent');
        const skills = await listAstTemplates('skill');
        const tasks = await listAstTemplates('task');
        expect(agents.length).toBeGreaterThan(0);
        expect(skills.length).toBeGreaterThan(0);
        expect(tasks.length).toBeGreaterThan(0);
    });

    it('every entry carries a slug + title + description', async () => {
        for (const entity of ['agent', 'skill', 'task'] as const) {
            const entries = await listAstTemplates(entity);
            for (const e of entries) {
                expect(typeof e.slug).toBe('string');
                expect(e.slug.length).toBeGreaterThan(0);
                expect(typeof e.title).toBe('string');
                expect(e.title.length).toBeGreaterThan(0);
                expect(typeof e.description).toBe('string');
                expect(e.description.length).toBeGreaterThan(0);
            }
        }
    });

    it('slugs are unique within each entity bucket', async () => {
        for (const entity of ['agent', 'skill', 'task'] as const) {
            const entries = await listAstTemplates(entity);
            const slugs = entries.map((e) => e.slug);
            const unique = new Set(slugs);
            expect(unique.size).toBe(slugs.length);
        }
    });

    it('getAstTemplate returns the row for a known slug', async () => {
        const found = await getAstTemplate('agent', 'starter-pm');
        expect(found).not.toBeNull();
        expect(found?.title).toBe('Project Manager');
    });

    it('getAstTemplate returns null for an unknown slug', async () => {
        const missing = await getAstTemplate('agent', 'no-such-template');
        expect(missing).toBeNull();
    });

    it('getAstTemplate is scoped to the entity (same slug across entities resolves only within type)', async () => {
        // Sanity-check: a slug that exists in `task` but not `agent`
        // returns null when queried under the agent type.
        const taskOnly = await getAstTemplate('task', 'bug-triage');
        expect(taskOnly?.slug).toBe('bug-triage');
        const sameSlugUnderAgent = await getAstTemplate('agent', 'bug-triage');
        expect(sameSlugUnderAgent).toBeNull();
    });
});
