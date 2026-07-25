import { AGENT_PERMISSIONS_DEFAULT } from '../../entities/agent.entity';
import { assertNoSecrets } from '../../utils/secret-scan';
import { slugifyText } from '../../utils/text.utils';
import { validateGuardrails } from '../guardrails';
import { AGENT_TEMPLATES, getAgentTemplate, listAgentTemplates } from '../agent-templates';

/**
 * Catalog-integrity pins for the Wave 10 prebuilt agent templates.
 * These are pure-data checks — if a template entry drifts out of
 * contract (duplicate slug, empty prompt, invalid guardrails, unknown
 * permission key), the suite names the offending entry.
 */
describe('agent-templates catalog integrity', () => {
    it('ships at least the six go-to-market templates', () => {
        expect(AGENT_TEMPLATES.length).toBeGreaterThanOrEqual(6);
        const slugs = AGENT_TEMPLATES.map((t) => t.slug);
        expect(slugs).toEqual(
            expect.arrayContaining([
                'content-marketer',
                'seo-auditor',
                'lead-researcher',
                'outreach-drafter',
                'social-scheduler',
                'competitive-analyst',
            ]),
        );
    });

    it('slugs are unique and kebab-case', () => {
        const slugs = AGENT_TEMPLATES.map((t) => t.slug);
        expect(new Set(slugs).size).toBe(slugs.length);
        for (const slug of slugs) {
            expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
        }
    });

    it('every template name produces a valid Agent slug (create() precondition)', () => {
        for (const template of AGENT_TEMPLATES) {
            const slug = slugifyText(template.name);
            expect(slug && /[a-z0-9]/i.test(slug)).toBe(true);
        }
    });

    it('system prompts are substantial, secret-free, and review-first', () => {
        for (const template of AGENT_TEMPLATES) {
            expect(template.systemPrompt.trim().length).toBeGreaterThan(200);
            // AgentFileService.write() hard-rejects secrets — the catalog
            // must never trip that gate at activation time.
            expect(() =>
                assertNoSecrets(template.systemPrompt, `template ${template.slug}`),
            ).not.toThrow();
            expect(template.description.trim().length).toBeGreaterThan(40);
            expect(template.capabilities.trim().length).toBeGreaterThan(20);
        }
    });

    it('default guardrails validate and default to the require-approval posture', () => {
        for (const template of AGENT_TEMPLATES) {
            expect(validateGuardrails(template.defaultGuardrails)).toBeNull();
            expect(template.defaultGuardrails.mode).toBe('require_approval');
        }
    });

    it('default permissions only use known permission keys (conservative subset)', () => {
        const knownKeys = new Set(Object.keys(AGENT_PERMISSIONS_DEFAULT));
        for (const template of AGENT_TEMPLATES) {
            for (const key of Object.keys(template.defaultPermissions)) {
                expect(knownKeys.has(key)).toBe(true);
            }
        }
    });

    it('categories, roles, and suggestions stay within their vocabularies', () => {
        for (const template of AGENT_TEMPLATES) {
            expect(['marketing', 'sales', 'ops']).toContain(template.category);
            expect(template.suggestedRoles.length).toBeGreaterThan(0);
            expect(template.suggestedSkills.length).toBeGreaterThan(0);
            for (const skill of template.suggestedSkills) {
                expect(skill).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
            }
            if (template.suggestedPipeline !== null) {
                expect(template.suggestedPipeline).toBe('gtm-pipeline');
            }
        }
    });

    it('lookup helpers return catalog entries by slug and undefined for unknowns', () => {
        expect(listAgentTemplates()).toBe(AGENT_TEMPLATES);
        expect(getAgentTemplate('outreach-drafter')?.name).toBe('Outreach Drafter');
        expect(getAgentTemplate('nonexistent-template')).toBeUndefined();
    });
});
