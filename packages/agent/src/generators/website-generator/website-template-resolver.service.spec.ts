import { WebsiteTemplateResolverService } from './website-template-resolver.service';

describe('WebsiteTemplateResolverService', () => {
    let templateRepository: any;
    let userTemplatePreferenceRepository: any;
    let service: WebsiteTemplateResolverService;

    beforeEach(() => {
        templateRepository = {
            findById: jest.fn(),
            findVisibleById: jest.fn(),
        };
        userTemplatePreferenceRepository = {
            findByUserAndKind: jest.fn(),
        };

        service = new WebsiteTemplateResolverService(
            templateRepository,
            userTemplatePreferenceRepository,
        );
    });

    it('returns active catalog templates when available', async () => {
        templateRepository.findById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            isActive: true,
            name: 'Custom',
            description: 'Custom template',
            repositoryOwner: 'user',
            repositoryName: 'repo',
            branch: 'main',
            syncBranches: ['main'],
            betaBranch: null,
        });

        await expect(service.resolve('custom-1')).resolves.toEqual(
            expect.objectContaining({
                id: 'custom-1',
                owner: 'user',
                repo: 'repo',
                branch: 'main',
            }),
        );
    });

    it('throws when a non-static template id is unavailable or inactive', async () => {
        const errorSpy = jest
            .spyOn((service as any).logger, 'error')
            .mockImplementation(() => undefined);
        templateRepository.findById.mockResolvedValue({
            id: 'custom-1',
            kind: 'website',
            isActive: false,
        });

        await expect(service.resolve('custom-1')).rejects.toThrow(
            'Website template "custom-1" is unavailable or inactive.',
        );

        expect(errorSpy).toHaveBeenCalledWith(
            'Website template "custom-1" is unavailable or inactive and cannot be resolved',
        );
    });

    // A retired catalog row (templates-catalog FR-5 c — an App Blueprint an
    // earlier discovery saved as a website template) stays ACTIVE precisely so
    // the Works already on it keep resolving: retirement only takes it out of
    // the picker and refuses it as a new selection. Resolution must not start
    // reading the retirement marker.
    describe('a retired catalog row', () => {
        const retiredRow = {
            id: 'cal-template',
            kind: 'website',
            sourceType: 'built_in',
            isActive: true,
            name: 'Cal Template',
            description: 'Cal.com App Blueprint',
            repositoryOwner: 'ever-works',
            repositoryName: 'cal-template',
            branch: 'main',
            syncBranches: ['main'],
            betaBranch: null,
            metadata: {
                discoveredFromOrganization: 'ever-works',
                retiredReason: 'app_blueprint',
                retiredAt: '2026-09-26T00:00:00.000Z',
            },
        };

        it('still resolves for a Work that names it', async () => {
            templateRepository.findById.mockResolvedValue(retiredRow);

            await expect(
                service.resolveForWork({ userId: 'user-1', websiteTemplateId: 'cal-template' }),
            ).resolves.toEqual(
                expect.objectContaining({
                    id: 'cal-template',
                    owner: 'ever-works',
                    repo: 'cal-template',
                }),
            );
        });

        it('still resolves for a Work inheriting a user default set to it', async () => {
            userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue({
                templateId: 'cal-template',
            });
            templateRepository.findVisibleById.mockResolvedValue(retiredRow);

            await expect(
                service.resolveForWork({ userId: 'user-7', websiteTemplateId: null }),
            ).resolves.toEqual(
                expect.objectContaining({ id: 'cal-template', repo: 'cal-template' }),
            );
            expect(templateRepository.findVisibleById).toHaveBeenCalledWith(
                'cal-template',
                'user-7',
            );
        });
    });

    it('still resolves static built-in template ids', async () => {
        templateRepository.findById.mockResolvedValue(null);

        await expect(service.resolve('classic')).resolves.toEqual(
            expect.objectContaining({
                id: 'classic',
                repo: 'directory-web-template',
            }),
        );
    });

    // ─────────────────────────────────────────────────────────────────
    // resolveForWork — kind-aware default (PR #1681, activated by
    // persisting `work.kind` at creation). No explicit template + no
    // saved preference: general-purpose kinds map to `web`; everything
    // else must keep resolving to the system default (`classic`) so
    // existing Works and the flagship directory flow are untouched.
    // ─────────────────────────────────────────────────────────────────
    describe('resolveForWork — kind-aware default', () => {
        const workOfKind = (kind: string | null | undefined) => ({
            userId: 'user-1',
            websiteTemplateId: null,
            kind,
        });

        beforeEach(() => {
            // No saved user preference and no catalog hits — isolates the
            // kind → template mapping under test.
            userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue(null);
            templateRepository.findById.mockResolvedValue(null);
            templateRepository.findVisibleById.mockResolvedValue(null);
        });

        it.each(['website', 'landing-page', 'landing', 'blog'])(
            'kind %s → the general `web` template',
            async (kind) => {
                await expect(service.resolveForWork(workOfKind(kind))).resolves.toEqual(
                    expect.objectContaining({ id: 'web', repo: 'web-template' }),
                );
            },
        );

        // `repo` is listed for completeness only: a Repository Work never
        // reaches the website generator (`WORK_KIND_CAPABILITIES.repo.repos.website`
        // is false and the create path persists `websiteTemplateId: null`),
        // so the fall-through is documented here, not relied on.
        it.each(['default', 'directory', 'awesome-repo', 'repo', 'company', 'not-a-kind'])(
            'kind %s → still the system default (classic)',
            async (kind) => {
                await expect(service.resolveForWork(workOfKind(kind))).resolves.toEqual(
                    expect.objectContaining({ id: 'classic', repo: 'directory-web-template' }),
                );
            },
        );

        it('missing kind (pre-existing Works) → still the system default (classic)', async () => {
            await expect(service.resolveForWork(workOfKind(null))).resolves.toEqual(
                expect.objectContaining({ id: 'classic' }),
            );
            await expect(service.resolveForWork(workOfKind(undefined))).resolves.toEqual(
                expect.objectContaining({ id: 'classic' }),
            );
        });

        it('never auto-selects the opt-in `web-minimal` template from a kind', async () => {
            for (const kind of ['website', 'landing-page', 'blog']) {
                const resolved = await service.resolveForWork(workOfKind(kind));
                expect(resolved.id).not.toBe('web-minimal');
            }
        });

        it('an explicit websiteTemplateId wins over the kind mapping', async () => {
            await expect(
                service.resolveForWork({
                    userId: 'user-1',
                    websiteTemplateId: 'classic',
                    kind: 'landing-page',
                }),
            ).resolves.toEqual(expect.objectContaining({ id: 'classic' }));
        });

        it('a saved user preference (catalog hit) wins over the kind mapping', async () => {
            userTemplatePreferenceRepository.findByUserAndKind.mockResolvedValue({
                templateId: 'custom-pref',
            });
            templateRepository.findVisibleById.mockResolvedValue({
                id: 'custom-pref',
                kind: 'website',
                isActive: true,
                name: 'Preferred',
                description: 'Preferred template',
                repositoryOwner: 'user',
                repositoryName: 'preferred-repo',
                branch: 'main',
                syncBranches: ['main'],
                betaBranch: null,
            });

            await expect(service.resolveForWork(workOfKind('landing-page'))).resolves.toEqual(
                expect.objectContaining({ id: 'custom-pref' }),
            );
        });
    });
});
