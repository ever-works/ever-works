import { describe, expect, it } from 'vitest';
import { getAstTemplate, listAstTemplates } from './agent-templates';

/**
 * agent-prompt-first-creation — runnable coverage for the named-role
 * starters that back the `/agents` quick-pick chips. (The sibling
 * `agent-templates.spec.ts` predates the `*.unit.spec.ts` convention
 * the web vitest config matches, so this file is the one that actually
 * executes.)
 */
describe('agent-templates — named-role starters', () => {
    it('exposes CEO/CTO/Lead Engineer/Copywriter/Sales/Brand Specialist as agent templates', async () => {
        const agents = await listAstTemplates('agent');
        const slugs = new Set(agents.map((a) => a.slug));
        for (const role of [
            'ceo',
            'cto',
            'lead-engineer',
            'copywriter',
            'sales',
            'brand-specialist',
        ]) {
            expect(slugs.has(role)).toBe(true);
        }
    });

    it('each named-role starter has a title, one-line description, and an icon', async () => {
        for (const role of ['ceo', 'cto', 'lead-engineer']) {
            const tpl = await getAstTemplate('agent', role);
            expect(tpl).not.toBeNull();
            expect(tpl?.title.length).toBeGreaterThan(0);
            expect(tpl?.description.length).toBeGreaterThan(0);
            expect(tpl?.iconName).toBeTruthy();
        }
    });

    it('keeps the original PM/Coder/Researcher starters (additive, not a replacement)', async () => {
        const slugs = new Set((await listAstTemplates('agent')).map((a) => a.slug));
        expect(slugs.has('starter-pm')).toBe(true);
        expect(slugs.has('starter-coder')).toBe(true);
        expect(slugs.has('starter-researcher')).toBe(true);
    });
});
