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

        it.each(['default', 'directory', 'awesome-repo', 'company', 'not-a-kind'])(
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
