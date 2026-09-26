jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));

jest.mock('@src/generators/markdown-generator/markdown-generator.service', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
}));

jest.mock('@src/generators/website-generator/website-generator.service', () => ({
    WebsiteGeneratorService: class WebsiteGeneratorService {},
}));

import { BadRequestException } from '@nestjs/common';
import { WorkLifecycleService } from '../work-lifecycle.service';
import { WebsiteUpdateService } from '@src/generators/website-generator/website-update.service';

/**
 * `POST /api/works/:id/switch-website-template` (MCP / web-assistant tool
 * `switch-website-template`) for an App Work.
 *
 * An App Work's `website` role IS its Work Repository — the member's own
 * code. `switchWebsiteTemplate` hands an initialized repository to
 * `WebsiteUpdateService.updateRepository`, which force-pushes the chosen
 * template over it, and on anything that looks like "repository missing" it
 * RECREATES the repository from the template with `websiteGenerator.initialize`.
 *
 * The refusal lives in `updateRepository` (the funnel every caller shares).
 * This spec runs the REAL `WebsiteUpdateService` under the switch, so it pins
 * the composition: the refusal reaches the caller, is not mistaken for a
 * missing repository, nothing is recreated, persisted or pushed.
 */
describe('WorkLifecycleService.switchWebsiteTemplate — App Work', () => {
    const user = { id: 'user-1' } as any;

    it('refuses before any git call, recreates nothing and persists nothing', async () => {
        const workRepository = {
            update: jest.fn().mockResolvedValue(undefined),
        };
        const websiteGenerator = {
            initialize: jest.fn(),
            removeRepository: jest.fn(),
        };
        const gitFacade = {
            repositoryExists: jest.fn().mockResolvedValue(true),
            getLatestCommit: jest.fn(),
            removeLocalDir: jest.fn(),
            cloneOrPull: jest.fn(),
            getCloneUrl: jest.fn(),
            switchBranch: jest.fn(),
            replaceRemote: jest.fn(),
            push: jest.fn(),
            add: jest.fn(),
            commit: jest.fn(),
            listBranches: jest.fn(),
            updateRepository: jest.fn(),
        };
        const branchSyncService = { syncFromTemplate: jest.fn() };
        const websiteTemplateResolver = { resolveForWork: jest.fn() };
        const websiteUpdateService = new WebsiteUpdateService(
            gitFacade as never,
            branchSyncService as never,
            websiteTemplateResolver as never,
        );
        const work = {
            id: 'w-app',
            kind: 'app',
            slug: 'acme',
            name: 'Acme',
            gitProvider: 'github',
            user,
            websiteTemplateId: 'classic',
            websiteTemplateLastCommit: 'abc123',
            websiteTemplateLastError: null,
            getRepoOwner: jest.fn().mockReturnValue('acme-org'),
            getWebsiteRepo: jest.fn().mockReturnValue('acme-app'),
        } as any;

        const service = new WorkLifecycleService(
            workRepository as never,
            { findById: jest.fn() } as never,
            {} as never,
            {} as never,
            websiteGenerator as never,
            websiteUpdateService,
            { ensureCanEdit: jest.fn().mockResolvedValue({ work }) } as never,
            { getAvailableProviders: jest.fn().mockReturnValue([]) } as never,
            {
                getDefaultTemplateIdForUser: jest.fn().mockResolvedValue(null),
                getVisibleTemplateForUser: jest
                    .fn()
                    .mockImplementation(async (_kind: string, id: string) => ({ id })),
            } as never,
            { isInitialized: jest.fn().mockResolvedValue(true) } as never,
            {} as never,
            { isEnabled: jest.fn().mockReturnValue(false) } as never,
            {} as never,
            { emit: jest.fn() } as never,
            { emit: jest.fn() } as never,
            { findById: jest.fn() } as never,
            {} as never,
        );

        const switched = service.switchWebsiteTemplate(work.id, 'minimal', user);

        await expect(switched).rejects.toBeInstanceOf(BadRequestException);
        await expect(switched).rejects.toThrow(/Work "Acme" is an App Work/);

        // Not read as "repository missing" — nothing is recreated from the template.
        expect(websiteGenerator.initialize).not.toHaveBeenCalled();
        // The switch is not persisted and the in-memory Work is rolled back.
        expect(workRepository.update).not.toHaveBeenCalled();
        expect(work.websiteTemplateId).toBe('classic');
        expect(work.websiteTemplateLastCommit).toBe('abc123');
        // No provider or git call reached the member's repository.
        for (const call of Object.values(gitFacade)) {
            expect(call).not.toHaveBeenCalled();
        }
        expect(branchSyncService.syncFromTemplate).not.toHaveBeenCalled();
        expect(websiteTemplateResolver.resolveForWork).not.toHaveBeenCalled();
    });
});
