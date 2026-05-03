/**
 * Regression tests for the website-templates registry.
 *
 * Background: the bulk Directory→Work rename briefly changed the concrete
 * GitHub repo name `directory-web-template` to `work-web-template` (which
 * does not exist). Result: every newly-generated Work cloned a missing
 * repo and the website-init flow broke. This test pins the repo names so
 * a future blanket rename can't re-introduce the same outage.
 */

import {
    DEFAULT_WEBSITE_TEMPLATE_ID,
    findWebsiteTemplateConfig,
    getDefaultWebsiteTemplateId,
    listWebsiteTemplates,
} from '../website-template.config';

describe('Website templates registry', () => {
    describe('classic template', () => {
        it('is registered and points at the real ever-works/directory-web-template repo', () => {
            const classic = findWebsiteTemplateConfig('classic');
            expect(classic).not.toBeNull();
            expect(classic!.id).toBe('classic');
            expect(classic!.owner).toBe('ever-works');
            // The bulk Directory→Work rename mistakenly changed this to
            // `work-web-template`. The real published repo on GitHub is
            // `directory-web-template` — the template for directory-style
            // websites (independent of the platform's own product naming).
            expect(classic!.repo).toBe('directory-web-template');
            expect(classic!.branch).toBe('main');
            expect(classic!.syncBranches).toEqual(
                expect.arrayContaining(['main', 'stage', 'develop']),
            );
        });

        it('is the default template id', () => {
            expect(DEFAULT_WEBSITE_TEMPLATE_ID).toBe('classic');
            expect(getDefaultWebsiteTemplateId()).toBe('classic');
        });
    });

    describe('minimal template (opt-in via env)', () => {
        const ENV_KEYS = [
            'WEBSITE_TEMPLATE_MINIMAL_REPO',
            'WEBSITE_TEMPLATE_MINIMAL_OWNER',
            'WEBSITE_TEMPLATE_MINIMAL_BRANCH',
        ];
        const previous: Record<string, string | undefined> = {};

        beforeAll(() => {
            for (const k of ENV_KEYS) previous[k] = process.env[k];
        });

        afterAll(() => {
            for (const k of ENV_KEYS) {
                if (previous[k] === undefined) delete process.env[k];
                else process.env[k] = previous[k];
            }
            // Reset module cache so subsequent tests see the original env.
            jest.resetModules();
        });

        it('does not appear in listWebsiteTemplates() unless WEBSITE_TEMPLATE_MINIMAL_REPO is set', () => {
            // Default test-runner env should not have the minimal repo set.
            // (work-lifecycle.service.spec.ts opts in by setting it; that
            // does not affect this isolated module load.)
            jest.resetModules();
            delete process.env.WEBSITE_TEMPLATE_MINIMAL_REPO;
            const reloaded =
                require('../website-template.config') as typeof import('../website-template.config');

            const minimal = reloaded.findWebsiteTemplateConfig('minimal');
            expect(minimal).toBeNull();

            const ids = reloaded.listWebsiteTemplates().map((t) => t.id);
            expect(ids).not.toContain('minimal');
        });

        it('appears with the correct GitHub repo when env opts in', () => {
            jest.resetModules();
            // The real published repo on GitHub:
            //   https://github.com/ever-works/directory-web-minimal-template
            // Bulk renames must NOT change this string to a `work-…` form.
            process.env.WEBSITE_TEMPLATE_MINIMAL_REPO = 'directory-web-minimal-template';
            process.env.WEBSITE_TEMPLATE_MINIMAL_OWNER = 'ever-works';
            const reloaded =
                require('../website-template.config') as typeof import('../website-template.config');

            const minimal = reloaded.findWebsiteTemplateConfig('minimal');
            expect(minimal).not.toBeNull();
            expect(minimal!.id).toBe('minimal');
            expect(minimal!.owner).toBe('ever-works');
            expect(minimal!.repo).toBe('directory-web-minimal-template');
        });
    });

    describe('listWebsiteTemplates()', () => {
        it('always includes classic and returns a fresh array each call', () => {
            const a = listWebsiteTemplates();
            const b = listWebsiteTemplates();
            expect(a).not.toBe(b);
            expect(a.find((t) => t.id === 'classic')).toBeTruthy();
        });
    });

    describe('findWebsiteTemplateConfig()', () => {
        it('returns null for unknown ids', () => {
            expect(findWebsiteTemplateConfig('does-not-exist')).toBeNull();
            expect(findWebsiteTemplateConfig('')).toBeNull();
            expect(findWebsiteTemplateConfig(null)).toBeNull();
            expect(findWebsiteTemplateConfig(undefined)).toBeNull();
        });
    });
});
