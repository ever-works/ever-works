// `minimal` is conditionally created from env vars in production; stub the
// config lookup so tests don't depend on env.
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
        ...minimal,
        id: 'classic',
        repo: 'directory-web-template',
        customizable: false,
    };
    return {
        findWebsiteTemplateConfig: (id?: string | null) =>
            id === 'minimal' ? minimal : id === 'classic' ? classic : null,
    };
});

jest.mock('@src/utils/git-repository.utils', () => ({
    assertCreatedRepositoryTarget: (created: any) => created,
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TemplateCustomizationService } from '../template-customization.service';
import { TemplateCustomizationStatus } from '../../entities/template-customization.entity';

type AnyMock = jest.Mock;

interface Mocks {
    templateRepository: {
        findById: AnyMock;
        upsert: AnyMock;
        updateById: AnyMock;
    };
    customizationRepository: {
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
        createRepository: AnyMock;
        getCloneUrl: AnyMock;
        getWebUrl: AnyMock;
        replaceRemote: AnyMock;
        addAll: AnyMock;
        commit: AnyMock;
        push: AnyMock;
    };
    codeEditFacade: { listProviders: AnyMock; execute: AnyMock };
}

function makeService(): { service: TemplateCustomizationService; mocks: Mocks } {
    const mocks: Mocks = {
        templateRepository: {
            findById: jest.fn(),
            upsert: jest.fn().mockImplementation(async (t) => t),
            updateById: jest.fn().mockResolvedValue(undefined),
        },
        customizationRepository: {
            create: jest.fn().mockImplementation(async (input) => ({
                id: 'cust-1',
                ...input,
                status: TemplateCustomizationStatus.PENDING,
            })),
            findById: jest.fn(),
            findByIdForUser: jest.fn(),
            listForTemplate: jest.fn(),
            updateById: jest.fn().mockResolvedValue(undefined),
        },
        userRepository: {
            findById: jest
                .fn()
                .mockResolvedValue({ id: 'user-1', username: 'evereq', email: 'e@v.co' }),
        },
        gitFacade: {
            getUser: jest.fn().mockResolvedValue({ login: 'evereq' }),
            getCommitter: jest.fn().mockResolvedValue({ name: 'evereq', email: 'e@v.co' }),
            cloneOrPull: jest.fn().mockResolvedValue('/tmp/base-repo'),
            createRepository: jest.fn().mockResolvedValue({
                owner: 'evereq',
                name: 'tpl-minimal-mytheme-abc123',
                defaultBranch: 'main',
                url: 'https://github.com/evereq/tpl-minimal-mytheme-abc123',
            }),
            getCloneUrl: jest
                .fn()
                .mockReturnValue('https://github.com/evereq/tpl-minimal-mytheme-abc123.git'),
            getWebUrl: jest
                .fn()
                .mockReturnValue('https://github.com/evereq/tpl-minimal-mytheme-abc123'),
            replaceRemote: jest.fn().mockResolvedValue(undefined),
            addAll: jest.fn().mockResolvedValue(undefined),
            commit: jest.fn().mockResolvedValue(undefined),
            push: jest.fn().mockResolvedValue(undefined),
        },
        codeEditFacade: {
            listProviders: jest.fn().mockReturnValue([
                { id: 'claude-code', name: 'Claude Code', enabled: true },
                { id: 'codex', name: 'Codex', enabled: false },
            ]),
            execute: jest.fn().mockResolvedValue({
                success: true,
                summary: 'Applied UI changes',
                filesChanged: [{ path: 'src/styles/theme.css', status: 'modified' }],
            }),
        },
    };
    const service = new TemplateCustomizationService(
        mocks.templateRepository as any,
        mocks.customizationRepository as any,
        mocks.userRepository as any,
        mocks.gitFacade as any,
        mocks.codeEditFacade as any,
    );
    return { service, mocks };
}

const baseInput = {
    baseTemplateId: 'minimal',
    name: 'My Theme',
    prompt: 'dark mode with purple accents',
    providerId: 'claude-code',
};

describe('TemplateCustomizationService.createAndStart', () => {
    it('rejects when name, prompt, or providerId are missing', async () => {
        const { service } = makeService();
        await expect(
            service.createAndStart('user-1', { ...baseInput, name: '' } as any),
        ).rejects.toThrow(BadRequestException);
        await expect(
            service.createAndStart('user-1', { ...baseInput, prompt: ' ' } as any),
        ).rejects.toThrow(BadRequestException);
        await expect(
            service.createAndStart('user-1', { ...baseInput, providerId: '' } as any),
        ).rejects.toThrow(BadRequestException);
    });

    it('rejects non-customizable bases (e.g. classic)', async () => {
        const { service } = makeService();
        await expect(
            service.createAndStart('user-1', { ...baseInput, baseTemplateId: 'classic' }),
        ).rejects.toThrow(BadRequestException);
    });

    it('rejects unknown bases', async () => {
        const { service } = makeService();
        await expect(
            service.createAndStart('user-1', { ...baseInput, baseTemplateId: 'no-such' }),
        ).rejects.toThrow(NotFoundException);
    });

    it('rejects when the selected provider is not installed/enabled', async () => {
        const { service, mocks } = makeService();
        mocks.codeEditFacade.listProviders.mockReturnValue([
            { id: 'codex', name: 'Codex', enabled: false },
        ]);
        await expect(service.createAndStart('user-1', baseInput)).rejects.toThrow(
            BadRequestException,
        );
    });

    it('rejects when no code-edit providers are installed at all', async () => {
        const { service, mocks } = makeService();
        mocks.codeEditFacade.listProviders.mockReturnValue([]);
        await expect(service.createAndStart('user-1', baseInput)).rejects.toThrow(
            BadRequestException,
        );
    });

    it('provisions a new repo and persists the Template + customization rows', async () => {
        const { service, mocks } = makeService();
        const executeSpy = jest.spyOn(service, 'execute').mockResolvedValue(undefined);

        const result = await service.createAndStart('user-1', baseInput);

        // Cloned the base, created a new repo on the user's account, pushed.
        expect(mocks.gitFacade.cloneOrPull).toHaveBeenCalledWith(
            expect.objectContaining({
                owner: 'ever-works',
                repo: 'directory-web-minimal-template',
            }),
            expect.objectContaining({ userId: 'user-1', providerId: 'github' }),
        );
        expect(mocks.gitFacade.createRepository).toHaveBeenCalledWith(
            expect.objectContaining({ isPrivate: true }),
            expect.any(Object),
        );
        const newRepoName = mocks.gitFacade.createRepository.mock.calls[0][0].name;
        expect(newRepoName).toMatch(/^tpl-minimal-/);
        expect(mocks.gitFacade.replaceRemote).toHaveBeenCalled();
        expect(mocks.gitFacade.push).toHaveBeenCalledWith(
            expect.objectContaining({ force: true }),
            expect.any(Object),
        );

        expect(mocks.templateRepository.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                sourceType: 'custom',
                ownerUserId: 'user-1',
                repositoryOwner: 'evereq',
                metadata: expect.objectContaining({ baseTemplateId: 'minimal' }),
            }),
        );
        expect(mocks.customizationRepository.create).toHaveBeenCalledWith({
            templateId: expect.any(String),
            userId: 'user-1',
            baseTemplateId: 'minimal',
            prompt: baseInput.prompt,
            providerId: 'claude-code',
        });
        expect(result.customization.id).toBe('cust-1');

        await new Promise((r) => setImmediate(r));
        expect(executeSpy).toHaveBeenCalledWith('cust-1');
    });
});

describe('TemplateCustomizationService.execute', () => {
    function seedRunning(mocks: Mocks) {
        mocks.customizationRepository.findById.mockResolvedValue({
            id: 'cust-1',
            templateId: 'custom-abc',
            userId: 'user-1',
            baseTemplateId: 'minimal',
            prompt: 'dark mode',
            providerId: 'claude-code',
            status: TemplateCustomizationStatus.PENDING,
        });
        mocks.templateRepository.findById.mockResolvedValue({
            id: 'custom-abc',
            kind: 'website',
            sourceType: 'custom',
            ownerUserId: 'user-1',
            repositoryOwner: 'evereq',
            repositoryName: 'tpl-minimal-x',
            branch: 'main',
            metadata: { baseTemplateId: 'minimal' },
        });
    }

    it('clones, runs the agent, commits, pushes, marks succeeded', async () => {
        const { service, mocks } = makeService();
        seedRunning(mocks);
        await service.execute('cust-1');
        expect(mocks.codeEditFacade.execute).toHaveBeenCalledTimes(1);
        expect(mocks.gitFacade.push).toHaveBeenCalled();
        const finalCall = mocks.customizationRepository.updateById.mock.calls.find(
            ([, patch]) => patch.status === TemplateCustomizationStatus.SUCCEEDED,
        );
        expect(finalCall).toBeTruthy();
    });

    it('fails the row when the agent reports no changes', async () => {
        const { service, mocks } = makeService();
        seedRunning(mocks);
        mocks.codeEditFacade.execute.mockResolvedValueOnce({
            success: true,
            summary: '',
            filesChanged: [],
        });
        await service.execute('cust-1');
        expect(mocks.gitFacade.push).not.toHaveBeenCalled();
        const failed = mocks.customizationRepository.updateById.mock.calls.find(
            ([, patch]) => patch.status === TemplateCustomizationStatus.FAILED,
        );
        expect(failed[1].errorMessage).toMatch(/no file changes/i);
    });

    it('skips terminal records', async () => {
        const { service, mocks } = makeService();
        mocks.customizationRepository.findById.mockResolvedValue({
            id: 'cust-1',
            status: TemplateCustomizationStatus.SUCCEEDED,
        });
        await service.execute('cust-1');
        expect(mocks.gitFacade.cloneOrPull).not.toHaveBeenCalled();
    });
});
