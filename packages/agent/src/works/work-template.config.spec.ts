import {
    WORK_TEMPLATES,
    findWorkTemplateConfig,
    listWorkTemplates,
} from './work-template.config';

/**
 * Pins the built-in Work Templates catalog. These rows power the
 * "Work Templates" tab on the Templates page (seeded via
 * TemplateCatalogService.toBuiltInWorkTemplateRecord). Changing an
 * id / repo here changes what users can fork, so keep the assertions
 * strict.
 */
describe('work-template.config', () => {
    it('seeds exactly the two curated Work Templates', () => {
        const templates = listWorkTemplates();
        expect(templates.map((t) => t.id)).toEqual([
            'starter-directory',
            'starter-directory-minimal',
        ]);
    });

    it('points each template at a real ever-works repo with a stated framework', () => {
        expect(findWorkTemplateConfig('starter-directory')).toMatchObject({
            name: 'Starter Directory',
            owner: 'ever-works',
            repo: 'directory-web-template',
            framework: 'Next.js',
            branch: 'main',
            syncBranches: ['main'],
        });
        expect(findWorkTemplateConfig('starter-directory-minimal')).toMatchObject({
            name: 'Starter Directory (Minimal)',
            owner: 'ever-works',
            repo: 'directory-web-minimal-template',
            framework: 'Astro',
            branch: 'main',
            syncBranches: ['main'],
        });
    });

    it('returns null for an unknown template id', () => {
        expect(findWorkTemplateConfig('does-not-exist')).toBeNull();
        expect(findWorkTemplateConfig(undefined)).toBeNull();
        expect(findWorkTemplateConfig(null)).toBeNull();
    });

    it('listWorkTemplates returns a fresh copy (callers cannot mutate the source)', () => {
        const first = listWorkTemplates();
        first.push({
            id: 'tampered',
            name: 'Tampered',
            description: '',
            owner: 'x',
            repo: 'y',
            branch: 'main',
            syncBranches: ['main'],
        });
        expect(listWorkTemplates()).toHaveLength(WORK_TEMPLATES.length);
    });
});
