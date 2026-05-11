jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));
jest.mock('@src/generators/markdown-generator/markdown-generator.service', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
}));
jest.mock('@src/generators/website-generator/website-generator.service', () => ({
    WebsiteGeneratorService: class WebsiteGeneratorService {},
}));
jest.mock('@src/generators/website-generator/website-update.service', () => ({
    WebsiteUpdateService: class WebsiteUpdateService {},
}));

import { WorkLifecycleService } from '../work-lifecycle.service';
import { EverWorksDeployQuotaExceededError } from '../../ever-works-providers';
import { CreateWorkDto } from '@src/dto/create-work.dto';
import type { User } from '@src/entities/user.entity';
import type { OnboardingWizardStateV2 } from '@ever-works/contracts/api';

/**
 * Focused tests for `WorkLifecycleService.createWork`'s new behaviour:
 *
 *   1. Seeds `storageProvider` / `deployProvider` from the user's
 *      onboarding state when the DTO doesn't carry them.
 *   2. Honours the DTO override over the onboarding state.
 *   3. Falls back to historical defaults (`user-github` / `vercel`) when
 *      both are missing.
 *   4. Invokes the Ever Works Deploy quota check before any side effects
 *      when `deployProvider === 'ever-works'`.
 *   5. Skips the quota check for other deploy providers.
 *   6. Bubbles up `EverWorksDeployQuotaExceededError` so callers can map
 *      it to a 429.
 *
 * Each test wires a minimal set of mocks — only the collaborators the
 * code path touches.
 */

const baseUser = { id: 'u-1', email: 'u@example.com' } as User;

const baseDto: CreateWorkDto = {
    slug: 'my-work',
    name: 'My Work',
    description: 'A description',
    organization: false,
    gitProvider: 'github',
} as CreateWorkDto;

interface MockDeps {
    workRepo: { create: jest.Mock; updateGenerateStatus: jest.Mock };
    userRepo: { findById: jest.Mock };
    quota: { assertWithinQuota: jest.Mock };
}

function makeService(onboardingState: OnboardingWizardStateV2 | null = null): {
    service: WorkLifecycleService;
    deps: MockDeps;
} {
    const workRepo = {
        create: jest.fn(async (data: Record<string, unknown>) => ({
            id: 'w-1',
            ...data,
            getRepoOwner: () => 'evereq',
        })),
        updateGenerateStatus: jest.fn().mockResolvedValue(undefined),
    };
    const userRepo = {
        findById: jest.fn().mockResolvedValue({ id: baseUser.id, onboardingState }),
    };
    const dataGenerator = { getItems: jest.fn().mockResolvedValue([]) };
    const ownership = {};
    const templateCatalog = {
        getVisibleTemplateForUser: jest.fn().mockResolvedValue(null),
        getDefaultTemplateIdForUser: jest.fn().mockResolvedValue(null),
    };
    const quota = { assertWithinQuota: jest.fn().mockResolvedValue(undefined) };

    const service = new WorkLifecycleService(
        workRepo as never,
        userRepo as never,
        dataGenerator as never,
        {} as never,
        {} as never,
        {} as never,
        ownership as never,
        {} as never,
        templateCatalog as never,
        {} as never,
        quota as never,
    );

    return { service, deps: { workRepo, userRepo, quota } };
}

describe('WorkLifecycleService.createWork — provider defaults + quota', () => {
    it('falls back to user-github + vercel when the user has no onboarding state and the DTO is silent', async () => {
        const { service, deps } = makeService(null);

        await service.createWork(baseDto, baseUser);

        expect(deps.workRepo.create).toHaveBeenCalledTimes(1);
        const persisted = deps.workRepo.create.mock.calls[0][0];
        expect(persisted.storageProvider).toBe('user-github');
        expect(persisted.deployProvider).toBe('vercel');
        expect(deps.quota.assertWithinQuota).not.toHaveBeenCalled();
    });

    it('seeds defaults from the user onboarding state when the DTO is silent', async () => {
        const state: OnboardingWizardStateV2 = {
            version: 2,
            lastStep: 0,
            ai: { choice: 'openrouter' },
            storage: { choice: 'ever-works-git' },
            deploy: { choice: 'k8s' },
            skippedSteps: [],
            pluginsReviewed: false,
        };
        const { service, deps } = makeService(state);

        await service.createWork(baseDto, baseUser);

        const persisted = deps.workRepo.create.mock.calls[0][0];
        expect(persisted.storageProvider).toBe('ever-works-git');
        expect(persisted.deployProvider).toBe('k8s');
        expect(deps.quota.assertWithinQuota).not.toHaveBeenCalled();
    });

    it('honours an explicit DTO override even when onboarding state has a different choice', async () => {
        const state: OnboardingWizardStateV2 = {
            version: 2,
            lastStep: 0,
            ai: { choice: 'ever-works' },
            storage: { choice: 'ever-works-git' },
            deploy: { choice: 'ever-works' },
            skippedSteps: [],
            pluginsReviewed: false,
        };
        const { service, deps } = makeService(state);

        await service.createWork(
            { ...baseDto, storageProvider: 'user-github', deployProvider: 'vercel' },
            baseUser,
        );

        const persisted = deps.workRepo.create.mock.calls[0][0];
        expect(persisted.storageProvider).toBe('user-github');
        expect(persisted.deployProvider).toBe('vercel');
        expect(deps.quota.assertWithinQuota).not.toHaveBeenCalled();
    });

    it('invokes the Ever Works Deploy quota check when deploy === ever-works', async () => {
        const { service, deps } = makeService(null);

        await service.createWork({ ...baseDto, deployProvider: 'ever-works' }, baseUser);

        expect(deps.quota.assertWithinQuota).toHaveBeenCalledWith(baseUser.id);
        expect(deps.workRepo.create).toHaveBeenCalledTimes(1);
    });

    it('bubbles up EverWorksDeployQuotaExceededError before any DB write', async () => {
        const { service, deps } = makeService(null);
        deps.quota.assertWithinQuota.mockRejectedValueOnce(
            new EverWorksDeployQuotaExceededError(3, 3),
        );

        let caught: unknown;
        try {
            await service.createWork({ ...baseDto, deployProvider: 'ever-works' }, baseUser);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(EverWorksDeployQuotaExceededError);
        expect(deps.workRepo.create).not.toHaveBeenCalled();
    });

    it('tolerates a userRepository.findById failure and falls back to safe defaults', async () => {
        const { service, deps } = makeService(null);
        deps.userRepo.findById.mockRejectedValueOnce(new Error('db down'));

        await service.createWork(baseDto, baseUser);

        const persisted = deps.workRepo.create.mock.calls[0][0];
        expect(persisted.storageProvider).toBe('user-github');
        expect(persisted.deployProvider).toBe('vercel');
    });
});
