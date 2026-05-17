// The `minimal` website template is conditionally created based on env vars
// (config.websiteTemplate.getMinimalRepo()) which aren't set in unit tests.
// Stub the template-config module so the service sees a customizable minimal
// template without depending on env state.
jest.mock('@src/generators/website-generator/config/website-template.config', () => {
    const minimal = {
        id: 'minimal',
        name: 'Minimal',
        description: 'Minimal',
        owner: 'ever-works',
        repo: 'directory-web-minimal-template',
        branch: 'main',
        syncBranches: ['main'],
        betaBranch: null,
        customizable: true,
    };
    const classic = {
        id: 'classic',
        name: 'Classic',
        description: 'Classic',
        owner: 'ever-works',
        repo: 'directory-web-template',
        branch: 'main',
        syncBranches: ['main'],
        betaBranch: null,
        customizable: false,
    };
    return {
        findWebsiteTemplateConfig: (id?: string | null) => {
            if (id === 'minimal') return minimal;
            if (id === 'classic') return classic;
            return null;
        },
    };
});

import { BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { TemplateCustomizationService } from '../template-customization.service';
import { TemplateCustomizationStatus } from '../../entities/template-customization.entity';

// The service touches a lot of collaborators; mock at the boundary.
type AnyMock = jest.Mock;

interface Mocks {
    templateRepository: {
        findById: AnyMock;
        findOwnedCustomById: AnyMock;
        updateById: AnyMock;
    };
    customizationRepository: {
        findLatestRunning: AnyMock;
        create: AnyMock;
        findById: AnyMock;
        findByIdForUser: AnyMock;
        listForTemplate: AnyMock;
        updateById: AnyMock;
    };
    userRepository: { findById: AnyMock };
    gitFacade: {
        getUser: AnyMock;
        getCommitter: AnyMock;
        cloneOrPull: AnyMock;
        addAll: AnyMock;
        commit: AnyMock;
        push: AnyMock;
    };
    codeEditFacade: { execute: AnyMock };
    templateCatalogService: { forkTemplateForUser: AnyMock };
}

function makeService(): { service: TemplateCustomizationService; mocks: Mocks } {
    const mocks: Mocks = {
        templateRepository: {
            findById: jest.fn(),
            findOwnedCustomById: jest.fn(),
            updateById: jest.fn().mockResolvedValue(undefined),
        },
        customizationRepository: {
            findLatestRunning: jest.fn(),
            create: jest.fn(),
            findById: jest.fn(),
            findByIdForUser: jest.fn(),
            listForTemplate: jest.fn(),
            updateById: jest.fn().mockResolvedValue(undefined),
        },
        userRepository: { findById: jest.fn() },
        gitFacade: {
            getUser: jest.fn().mockResolvedValue({ login: 'evereq' }),
            getCommitter: jest.fn().mockResolvedValue({ name: 'evereq', email: 'e@v.co' }),
            cloneOrPull: jest.fn().mockResolvedValue('/tmp/workspace'),
            addAll: jest.fn().mockResolvedValue(undefined),
            commit: jest.fn().mockResolvedValue(undefined),
            push: jest.fn().mockResolvedValue(undefined),
        },
        codeEditFacade: {
            execute: jest.fn().mockResolvedValue({
                success: true,
                summary: 'Applied UI changes',
                filesChanged: [{ path: 'src/styles/theme.css', status: 'modified' }],
            }),
        },
        templateCatalogService: {
            forkTemplateForUser: jest.fn().mockResolvedValue({
                created: true,
                template: { id: 'custom-abc' },
                defaultTemplateId: 'custom-abc',
                repository: {
                    owner: 'evereq',
                    name: 'directory-web-minimal-template',
                    fullName: 'evereq/directory-web-minimal-template',
                    url: 'https://github.com/evereq/directory-web-minimal-template',
                },
            }),
        },
    };
    const service = new TemplateCustomizationService(
        mocks.templateRepository as any,
        mocks.customizationRepository as any,
        mocks.userRepository as any,
        mocks.gitFacade as any,
        mocks.codeEditFacade as any,
        mocks.templateCatalogService as any,
    );
    return { service, mocks };
}

describe('TemplateCustomizationService.createAndStart', () => {
    it('rejects when the base template id is not customizable', async () => {
        const { service } = makeService();
        // 'classic' exists in WebsiteTemplateConfig with customizable=false.
        await expect(
            service.createAndStart('user-1', { baseTemplateId: 'classic', prompt: 'dark mode' }),
        ).rejects.toThrow(BadRequestException);
    });

    it('rejects when the prompt is missing or whitespace-only', async () => {
        const { service } = makeService();
        await expect(
            service.createAndStart('user-1', { baseTemplateId: 'minimal', prompt: '   ' }),
        ).rejects.toThrow(BadRequestException);
    });

    it('rejects when the base template id is unknown', async () => {
        const { service } = makeService();
        await expect(
            service.createAndStart('user-1', {
                baseTemplateId: 'no-such-template',
                prompt: 'dark mode',
            }),
        ).rejects.toThrow(NotFoundException);
    });

    it('rejects when a customization is already running for the same custom template', async () => {
        const { service, mocks } = makeService();
        mocks.templateRepository.findById.mockResolvedValue({
            id: 'minimal',
            kind: 'website',
            sourceType: 'built_in',
            repositoryOwner: 'ever-works',
            repositoryName: 'directory-web-minimal-template',
            branch: 'main',
        });
        mocks.templateRepository.findOwnedCustomById.mockResolvedValue({
            id: 'custom-abc',
            kind: 'website',
            sourceType: 'custom',
            ownerUserId: 'user-1',
            repositoryOwner: 'evereq',
            repositoryName: 'directory-web-minimal-template',
            branch: 'main',
            metadata: { forkedFromTemplateId: 'minimal' },
        });
        mocks.customizationRepository.findLatestRunning.mockResolvedValue({
            id: 'cust-running',
            status: TemplateCustomizationStatus.CUSTOMIZING,
        });

        await expect(
            service.createAndStart('user-1', {
                baseTemplateId: 'minimal',
                prompt: 'dark mode with purple accents',
            }),
        ).rejects.toThrow(ConflictException);
        expect(mocks.customizationRepository.create).not.toHaveBeenCalled();
    });

    it('happy path: forks if needed, persists the row, kicks off async run', async () => {
        const { service, mocks } = makeService();
        mocks.templateRepository.findById.mockResolvedValue({
            id: 'minimal',
            kind: 'website',
            sourceType: 'built_in',
            repositoryOwner: 'ever-works',
            repositoryName: 'directory-web-minimal-template',
            branch: 'main',
        });
        mocks.templateRepository.findOwnedCustomById.mockResolvedValue({
            id: 'custom-abc',
            kind: 'website',
            sourceType: 'custom',
            ownerUserId: 'user-1',
            repositoryOwner: 'evereq',
            repositoryName: 'directory-web-minimal-template',
            branch: 'main',
            metadata: { forkedFromTemplateId: 'minimal' },
        });
        mocks.customizationRepository.findLatestRunning.mockResolvedValue(null);
        mocks.customizationRepository.create.mockResolvedValue({
            id: 'cust-1',
            templateId: 'custom-abc',
            baseTemplateId: 'minimal',
            prompt: 'dark mode with purple accents',
            status: TemplateCustomizationStatus.PENDING,
        });
        // Stub execute() so the async run is a no-op
        const executeSpy = jest.spyOn(service, 'execute').mockResolvedValue(undefined);

        const result = await service.createAndStart('user-1', {
            baseTemplateId: 'minimal',
            prompt: 'dark mode with purple accents',
        });

        expect(mocks.templateCatalogService.forkTemplateForUser).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'website',
                templateId: 'minimal',
                targetOwner: 'evereq',
            }),
            'user-1',
        );
        expect(mocks.customizationRepository.create).toHaveBeenCalledWith({
            templateId: 'custom-abc',
            userId: 'user-1',
            baseTemplateId: 'minimal',
            prompt: 'dark mode with purple accents',
            providerId: null,
        });
        expect(result.customization.id).toBe('cust-1');
        expect(result.template.id).toBe('custom-abc');
        expect(result.created).toBe(true);

        // Flush the microtask the service queued via `void this.runAsync(...)`.
        await new Promise((resolve) => setImmediate(resolve));
        expect(executeSpy).toHaveBeenCalledWith('cust-1');
    });
});

describe('TemplateCustomizationService.execute', () => {
    function withRunningRecord(mocks: Mocks) {
        mocks.customizationRepository.findById.mockResolvedValue({
            id: 'cust-1',
            templateId: 'custom-abc',
            userId: 'user-1',
            baseTemplateId: 'minimal',
            prompt: 'dark mode',
            status: TemplateCustomizationStatus.PENDING,
            providerId: null,
        });
        mocks.templateRepository.findById.mockResolvedValue({
            id: 'custom-abc',
            kind: 'website',
            sourceType: 'custom',
            ownerUserId: 'user-1',
            repositoryOwner: 'evereq',
            repositoryName: 'directory-web-minimal-template',
            branch: 'main',
            metadata: { forkedFromTemplateId: 'minimal' },
        });
        mocks.userRepository.findById.mockResolvedValue({
            id: 'user-1',
            username: 'evereq',
            email: 'e@v.co',
        });
    }

    it('clones, runs the agent, commits, pushes, then marks the row succeeded', async () => {
        const { service, mocks } = makeService();
        withRunningRecord(mocks);

        await service.execute('cust-1');

        // Agent ran with composed prompt (base + user)
        expect(mocks.codeEditFacade.execute).toHaveBeenCalledTimes(1);
        const callArgs = mocks.codeEditFacade.execute.mock.calls[0];
        expect(callArgs[0].workspaceDir).toBe('/tmp/workspace');
        expect(callArgs[0].prompt).toMatch(/UI/i);
        expect(callArgs[0].prompt).toMatch(/dark mode/);

        // Pushed and template metadata updated
        expect(mocks.gitFacade.push).toHaveBeenCalled();
        expect(mocks.templateRepository.updateById).toHaveBeenCalledWith(
            'custom-abc',
            expect.objectContaining({
                metadata: expect.objectContaining({
                    forkedFromTemplateId: 'minimal',
                    lastCustomizedAt: expect.any(String),
                }),
            }),
        );

        // Final status = SUCCEEDED
        const finalCall = mocks.customizationRepository.updateById.mock.calls.find(
            ([, patch]) => patch.status === TemplateCustomizationStatus.SUCCEEDED,
        );
        expect(finalCall).toBeTruthy();
    });

    it('marks the row failed when the agent produces no changes', async () => {
        const { service, mocks } = makeService();
        withRunningRecord(mocks);
        mocks.codeEditFacade.execute.mockResolvedValueOnce({
            success: true,
            summary: 'No changes',
            filesChanged: [],
        });

        await service.execute('cust-1');

        expect(mocks.gitFacade.push).not.toHaveBeenCalled();
        const failedCall = mocks.customizationRepository.updateById.mock.calls.find(
            ([, patch]) => patch.status === TemplateCustomizationStatus.FAILED,
        );
        expect(failedCall).toBeTruthy();
        expect(failedCall[1].errorMessage).toMatch(/no file changes/i);
    });

    it('marks the row failed when the agent itself returns success: false', async () => {
        const { service, mocks } = makeService();
        withRunningRecord(mocks);
        mocks.codeEditFacade.execute.mockResolvedValueOnce({
            success: false,
            error: 'agent crashed',
            summary: 'crash',
            filesChanged: [],
        });

        await service.execute('cust-1');

        expect(mocks.gitFacade.push).not.toHaveBeenCalled();
        const failedCall = mocks.customizationRepository.updateById.mock.calls.find(
            ([, patch]) => patch.status === TemplateCustomizationStatus.FAILED,
        );
        expect(failedCall).toBeTruthy();
        expect(failedCall[1].errorMessage).toBe('agent crashed');
    });

    it('skips silently when the customization is already terminal', async () => {
        const { service, mocks } = makeService();
        mocks.customizationRepository.findById.mockResolvedValue({
            id: 'cust-1',
            status: TemplateCustomizationStatus.SUCCEEDED,
        });

        await service.execute('cust-1');

        expect(mocks.gitFacade.cloneOrPull).not.toHaveBeenCalled();
        expect(mocks.codeEditFacade.execute).not.toHaveBeenCalled();
    });
});
