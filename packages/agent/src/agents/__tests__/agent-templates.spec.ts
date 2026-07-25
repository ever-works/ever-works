import { GTM_SKILL_SLUGS, GTM_SKILLS, getGtmSkill } from '@ever-works/contracts';
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

/**
 * The load-bearing cross-package pin.
 *
 * A template's `suggestedSkills` is the contract the Skills catalog has to
 * honour: activating a template hands the caller a list of Skill slugs to
 * wire up, and a slug that resolves to nothing turns a "ready-to-run" preset
 * into a dead end that only shows up in a live run. This suite makes the
 * drift a build failure and names the offending slug.
 */
describe('agent templates ↔ go-to-market Skills catalog integrity', () => {
    it('every suggested skill of every template resolves in the catalog', () => {
        const missing: string[] = [];
        for (const template of AGENT_TEMPLATES) {
            for (const slug of template.suggestedSkills) {
                if (!getGtmSkill(slug)) {
                    missing.push(`${template.slug} → ${slug}`);
                }
            }
        }
        expect(missing).toEqual([]);
    });

    it('covers every template with at least one resolvable skill', () => {
        for (const template of AGENT_TEMPLATES) {
            const resolved = template.suggestedSkills.filter((slug) => getGtmSkill(slug));
            expect(resolved.length).toBeGreaterThan(0);
        }
    });

    it('no template repeats a suggested skill', () => {
        for (const template of AGENT_TEMPLATES) {
            const slugs = [...template.suggestedSkills];
            expect(new Set(slugs).size).toBe(slugs.length);
        }
    });

    it('the six shipped templates cover the go-to-market work they advertise', () => {
        const suggested = (slug: string) => getAgentTemplate(slug)?.suggestedSkills ?? [];
        // Each template's headline job must be backed by a real Skill, not
        // only by the generic reporting pair every template could claim.
        expect(suggested('content-marketer')).toContain('newsletter-drafting');
        expect(suggested('seo-auditor')).toContain('seo-audit');
        expect(suggested('lead-researcher')).toContain('lead-research');
        expect(suggested('outreach-drafter')).toContain('outreach-personalization');
        expect(suggested('social-scheduler')).toContain('social-scheduling');
        expect(suggested('competitive-analyst')).toContain('competitor-watch');
    });

    it('templates driving the go-to-market pipeline suggest skills from more than one stage', () => {
        for (const template of AGENT_TEMPLATES) {
            if (template.suggestedPipeline !== 'gtm-pipeline') continue;
            const stages = new Set(
                template.suggestedSkills
                    .map((slug) => getGtmSkill(slug)?.stage)
                    .filter((stage): stage is NonNullable<typeof stage> => Boolean(stage)),
            );
            expect(stages.size).toBeGreaterThan(1);
        }
    });

    it('skill bodies are secret-free — they are written into Agent files verbatim', () => {
        for (const skill of GTM_SKILLS) {
            expect(() => assertNoSecrets(skill.body, `skill ${skill.slug}`)).not.toThrow();
        }
    });

    it('exposes a slug list consistent with the catalog itself', () => {
        expect(GTM_SKILL_SLUGS).toEqual(GTM_SKILLS.map((skill) => skill.slug));
        expect(new Set(GTM_SKILL_SLUGS).size).toBe(GTM_SKILL_SLUGS.length);
    });
});
