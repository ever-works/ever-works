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
import {
    EverWorksDeployQuotaExceededError,
    EverWorksGitDisabledError,
    EverWorksGitRequestError,
} from '../../ever-works-providers';
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
    everWorksGit: { isEnabled: jest.Mock; createRepository: jest.Mock };
    everWorksDns: {
        getProvider: jest.Mock;
        ensureWorkSubdomain: jest.Mock;
        removeWorkSubdomain: jest.Mock;
        ingressHostFor: jest.Mock;
    };
    funnel: { emit: jest.Mock };
    eventEmitter: { emit: jest.Mock };
}

function makeService(onboardingState: OnboardingWizardStateV2 | null = null): {
    service: WorkLifecycleService;
    deps: MockDeps;
} {
    const workRepo = {
        create: jest.fn(async (data: Record<string, unknown>) => ({
            id: (data.id as string) ?? 'w-1',
            ...data,
            getRepoOwner: () => (data.owner as string) ?? 'evereq',
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

    // EW-614 — `EverWorksGitProvider` is called from `createWork` when
    // `storageProvider === 'ever-works-git'` AND `isEnabled()` returns true.
    // Default the mock to disabled; individual tests flip it on as needed.
    const everWorksGit = {
        isEnabled: jest.fn().mockReturnValue(false),
        createRepository: jest.fn(),
    };

    const eventEmitter = { emit: jest.fn() };

    // EW-617 G5: DNS provider mock — no-op by default.
    const everWorksDns = {
        getProvider: jest.fn().mockReturnValue(null),
        ensureWorkSubdomain: jest.fn().mockResolvedValue(undefined),
        removeWorkSubdomain: jest.fn().mockResolvedValue(undefined),
        ingressHostFor: jest.fn((slug: string) => `${slug}.ever.works`),
    };

    // EW-617 G8: funnel emit sink — no-op stub by default.
    const funnel = { emit: jest.fn() };

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
        everWorksGit as never,
        everWorksDns as never,
        funnel as never,
        eventEmitter as never,
    );

    return {
        service,
        deps: { workRepo, userRepo, quota, everWorksGit, everWorksDns, funnel, eventEmitter },
    };
}

describe('WorkLifecycleService.createWork — provider defaults + quota', () => {
    // `resolveProviderDefaults` reads `config.everWorks.deploy.isEnabled()`,
    // which derives from `DEPLOY_EVER_WORKS_ENABLED`. Tests that exercise
    // the `ever-works` deploy path need the flag on; tests that exercise
    // the fallback path need it off.
    const previousFlag = process.env.DEPLOY_EVER_WORKS_ENABLED;
    afterEach(() => {
        if (previousFlag === undefined) {
            delete process.env.DEPLOY_EVER_WORKS_ENABLED;
        } else {
            process.env.DEPLOY_EVER_WORKS_ENABLED = previousFlag;
        }
    });

    it('falls back to user-github + vercel when the user has no onboarding state and the DTO is silent', async () => {
        const { service, deps } = makeService(null);

        await service.createWork(baseDto, baseUser);

        expect(deps.workRepo.create).toHaveBeenCalledTimes(1);
        const persisted = deps.workRepo.create.mock.calls[0][0];
        expect(persisted.storageProvider).toBe('user-github');
        expect(persisted.deployProvider).toBe('vercel');
        expect(persisted.gitProvider).toBe('github');
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
        process.env.DEPLOY_EVER_WORKS_ENABLED = 'true';
        const { service, deps } = makeService(null);

        await service.createWork({ ...baseDto, deployProvider: 'ever-works' }, baseUser);

        expect(deps.quota.assertWithinQuota).toHaveBeenCalledWith(baseUser.id);
        expect(deps.workRepo.create).toHaveBeenCalledTimes(1);
        const persisted = deps.workRepo.create.mock.calls[0][0];
        expect(persisted.deployProvider).toBe('ever-works');
    });

    it('bubbles up EverWorksDeployQuotaExceededError before any DB write', async () => {
        process.env.DEPLOY_EVER_WORKS_ENABLED = 'true';
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
        expect(persisted.gitProvider).toBe('github');
    });

    it('rewrites deploy=ever-works → vercel when DEPLOY_EVER_WORKS_ENABLED is off', async () => {
        // Critical safeguard: there is no plugin registered with id
        // `ever-works`. Persisting it on the Work would break the deploy
        // facade later. The wizard's default state still says `ever-works`,
        // so the rewrite has to live in the seed code.
        delete process.env.DEPLOY_EVER_WORKS_ENABLED;
        const state: OnboardingWizardStateV2 = {
            version: 2,
            lastStep: 0,
            ai: { choice: 'ever-works' },
            storage: { choice: 'user-github' },
            deploy: { choice: 'ever-works' },
            skippedSteps: [],
            pluginsReviewed: false,
        };
        const { service, deps } = makeService(state);

        await service.createWork(baseDto, baseUser);

        const persisted = deps.workRepo.create.mock.calls[0][0];
        expect(persisted.deployProvider).toBe('vercel');
        expect(deps.quota.assertWithinQuota).not.toHaveBeenCalled();
    });

    it("derives gitProvider from the onboarding storage choice (ever-works-git → 'github')", async () => {
        const state: OnboardingWizardStateV2 = {
            version: 2,
            lastStep: 0,
            ai: { choice: 'ever-works' },
            storage: { choice: 'ever-works-git' },
            deploy: { choice: 'vercel' },
            skippedSteps: [],
            pluginsReviewed: false,
        };
        const { service, deps } = makeService(state);

        // Don't pass gitProvider in the DTO so the seed code has to derive it.
        const dtoNoGit = { ...baseDto } as CreateWorkDto;
        delete (dtoNoGit as { gitProvider?: string }).gitProvider;

        await service.createWork(dtoNoGit, baseUser);

        const persisted = deps.workRepo.create.mock.calls[0][0];
        expect(persisted.storageProvider).toBe('ever-works-git');
        expect(persisted.gitProvider).toBe('github');
    });

    it("derives gitProvider from the onboarding storage choice (user-gitlab → 'gitlab')", async () => {
        const state: OnboardingWizardStateV2 = {
            version: 2,
            lastStep: 0,
            ai: { choice: 'ever-works' },
            storage: { choice: 'user-gitlab' },
            deploy: { choice: 'vercel' },
            skippedSteps: [],
            pluginsReviewed: false,
        };
        const { service, deps } = makeService(state);

        const dtoNoGit = { ...baseDto } as CreateWorkDto;
        delete (dtoNoGit as { gitProvider?: string }).gitProvider;

        await service.createWork(dtoNoGit, baseUser);

        const persisted = deps.workRepo.create.mock.calls[0][0];
        expect(persisted.gitProvider).toBe('gitlab');
    });

    it('honours an explicit DTO gitProvider override even when storage choice would derive a different one', async () => {
        const state: OnboardingWizardStateV2 = {
            version: 2,
            lastStep: 0,
            ai: { choice: 'ever-works' },
            storage: { choice: 'user-gitlab' },
            deploy: { choice: 'vercel' },
            skippedSteps: [],
            pluginsReviewed: false,
        };
        const { service, deps } = makeService(state);

        await service.createWork({ ...baseDto, gitProvider: 'github' }, baseUser);

        const persisted = deps.workRepo.create.mock.calls[0][0];
        expect(persisted.gitProvider).toBe('github');
    });

    // ─────────────────────────────────────────────────────────────────────
    // EW-614 — EverWorksGitProvider wire-up
    //
    // When `storageProvider==='ever-works-git'` AND `everWorksGit.isEnabled()`
    // is true, `createWork` MUST:
    //   1. Pre-generate a UUID and pass it to `everWorksGit.createRepository`
    //      so the provider can derive a deterministic collision-suffix.
    //   2. Persist the Work with `owner = <platform org>` and
    //      `organization = true` so `getRepoOwner()` returns the platform org.
    //   3. Persist `sourceRepository.relatedRepositories.work` from the
    //      provider's response (captures the actual repo name in collision
    //      cases).
    //   4. Emit `WorkCreatedEvent` with a `platformActor` payload so the
    //      activity-log listener records "Ever Works on user's behalf".
    //   5. Map provider errors onto HTTP-shaped exceptions:
    //      - `EverWorksGitDisabledError`     → `BadRequestException`
    //      - `EverWorksGitMisconfiguredError`→ `ServiceUnavailableException`
    //      - `EverWorksGitRequestError`      → `ServiceUnavailableException`
    // ─────────────────────────────────────────────────────────────────────
    const everWorksRepoRef = {
        owner: 'ever-works-cloud',
        repo: 'evereq-my-work',
        fullName: 'ever-works-cloud/evereq-my-work',
        htmlUrl: 'https://github.com/ever-works-cloud/evereq-my-work',
        cloneUrl: 'https://github.com/ever-works-cloud/evereq-my-work.git',
        privateRepo: true,
    };

    it('EW-614: ever-works-git + flag on → calls provider, persists platform org, emits platformActor', async () => {
        const state: OnboardingWizardStateV2 = {
            version: 2,
            lastStep: 0,
            ai: { choice: 'ever-works' },
            storage: { choice: 'ever-works-git' },
            deploy: { choice: 'vercel' },
            skippedSteps: [],
            pluginsReviewed: false,
        };
        const { service, deps } = makeService(state);
        deps.everWorksGit.isEnabled.mockReturnValue(true);
        deps.everWorksGit.createRepository.mockResolvedValue(everWorksRepoRef);
        const dtoNoGit = { ...baseDto } as CreateWorkDto;
        delete (dtoNoGit as { gitProvider?: string }).gitProvider;

        await service.createWork(dtoNoGit, { ...baseUser, username: 'evereq' } as never);

        expect(deps.everWorksGit.createRepository).toHaveBeenCalledTimes(1);
        const provArg = deps.everWorksGit.createRepository.mock.calls[0][0];
        expect(provArg.work.userId).toBe(baseUser.id);
        expect(provArg.work.userSlug).toBe('evereq');
        expect(provArg.work.slug).toBe('my-work');
        // Pre-generated UUID is what gets persisted as work.id.
        expect(typeof provArg.work.id).toBe('string');
        expect(provArg.work.id.length).toBeGreaterThan(0);

        const persisted = deps.workRepo.create.mock.calls[0][0];
        expect(persisted.id).toBe(provArg.work.id);
        expect(persisted.owner).toBe('ever-works-cloud');
        expect(persisted.organization).toBe(true);
        expect(persisted.storageProvider).toBe('ever-works-git');
        expect(persisted.gitProvider).toBe('github');
        expect(persisted.sourceRepository).toEqual(
            expect.objectContaining({
                owner: 'ever-works-cloud',
                repo: 'evereq-my-work',
                relatedRepositories: {
                    work: { owner: 'ever-works-cloud', repo: 'evereq-my-work' },
                },
            }),
        );

        // WorkCreatedEvent emitted with platformActor payload.
        expect(deps.eventEmitter.emit).toHaveBeenCalledWith(
            'work.created',
            expect.objectContaining({
                platformActor: {
                    actorKind: 'platform',
                    actor: 'ever-works-cloud',
                    repoFullName: 'ever-works-cloud/evereq-my-work',
                    htmlUrl: 'https://github.com/ever-works-cloud/evereq-my-work',
                },
            }),
        );
    });

    it('EW-614: ever-works-git + flag OFF → provider NOT called, falls through to existing path', async () => {
        const state: OnboardingWizardStateV2 = {
            version: 2,
            lastStep: 0,
            ai: { choice: 'ever-works' },
            storage: { choice: 'ever-works-git' },
            deploy: { choice: 'vercel' },
            skippedSteps: [],
            pluginsReviewed: false,
        };
        const { service, deps } = makeService(state);
        deps.everWorksGit.isEnabled.mockReturnValue(false);

        await service.createWork(baseDto, baseUser);

        expect(deps.everWorksGit.createRepository).not.toHaveBeenCalled();
        const persisted = deps.workRepo.create.mock.calls[0][0];
        expect(persisted.storageProvider).toBe('ever-works-git');
        expect(persisted.owner).toBe(baseDto.owner); // not overridden
        // Event still emitted, but without platformActor payload.
        const emitted = deps.eventEmitter.emit.mock.calls[0]?.[1];
        expect(emitted?.platformActor).toBeUndefined();
    });

    it('EW-614: provider EverWorksGitDisabledError → BadRequestException, no Work persisted', async () => {
        const { EverWorksGitDisabledError } = await import('../../ever-works-providers/types.js');
        const state: OnboardingWizardStateV2 = {
            version: 2,
            lastStep: 0,
            ai: { choice: 'ever-works' },
            storage: { choice: 'ever-works-git' },
            deploy: { choice: 'vercel' },
            skippedSteps: [],
            pluginsReviewed: false,
        };
        const { service, deps } = makeService(state);
        deps.everWorksGit.isEnabled.mockReturnValue(true);
        deps.everWorksGit.createRepository.mockRejectedValue(new EverWorksGitDisabledError());

        await expect(service.createWork(baseDto, baseUser)).rejects.toMatchObject({
            status: 400,
        });
        expect(deps.workRepo.create).not.toHaveBeenCalled();
    });

    it('EW-614: provider EverWorksGitRequestError → ServiceUnavailableException, no Work persisted', async () => {
        const { EverWorksGitRequestError } = await import('../../ever-works-providers/types.js');
        const state: OnboardingWizardStateV2 = {
            version: 2,
            lastStep: 0,
            ai: { choice: 'ever-works' },
            storage: { choice: 'ever-works-git' },
            deploy: { choice: 'vercel' },
            skippedSteps: [],
            pluginsReviewed: false,
        };
        const { service, deps } = makeService(state);
        deps.everWorksGit.isEnabled.mockReturnValue(true);
        deps.everWorksGit.createRepository.mockRejectedValue(
            new EverWorksGitRequestError(502, 'upstream down'),
        );

        await expect(service.createWork(baseDto, baseUser)).rejects.toMatchObject({
            status: 503,
        });
        expect(deps.workRepo.create).not.toHaveBeenCalled();
    });

    it('EW-614: non-ever-works-git storage → provider never called even if flag on', async () => {
        const state: OnboardingWizardStateV2 = {
            version: 2,
            lastStep: 0,
            ai: { choice: 'ever-works' },
            storage: { choice: 'user-github' },
            deploy: { choice: 'vercel' },
            skippedSteps: [],
            pluginsReviewed: false,
        };
        const { service, deps } = makeService(state);
        deps.everWorksGit.isEnabled.mockReturnValue(true);

        await service.createWork(baseDto, baseUser);

        expect(deps.everWorksGit.createRepository).not.toHaveBeenCalled();
    });
});
