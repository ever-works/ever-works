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
import { BadRequestException } from '@nestjs/common';
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
    workRepo: {
        create: jest.Mock;
        updateGenerateStatus: jest.Mock;
        findRepositoryWorksWrapping: jest.Mock;
    };
    userRepo: { findById: jest.Mock };
    gitFacade: { hasRepositoryAccess: jest.Mock };
    quota: { assertWithinQuota: jest.Mock };
    everWorksGit: { isEnabled: jest.Mock; createRepository: jest.Mock };
    everWorksDns: {
        getProvider: jest.Mock;
        ensureWorkSubdomain: jest.Mock;
        removeWorkSubdomain: jest.Mock;
        ingressHostFor: jest.Mock;
    };
    funnel: { emit: jest.Mock };
    eventEmitter: { emit: jest.Mock; emitAsync: jest.Mock };
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
        // Self-build slice D (EW-766): nobody else wraps the repo by default.
        findRepositoryWorksWrapping: jest.fn().mockResolvedValue([]),
    };
    const userRepo = {
        findById: jest.fn().mockResolvedValue({ id: baseUser.id, onboardingState }),
    };
    // Self-build slice D (EW-766): the Repository Work create path probes
    // the caller's access to the repository before persisting anything.
    // Default to "accessible"; the repo-kind tests flip it.
    const gitFacade = { hasRepositoryAccess: jest.fn().mockResolvedValue(true) };
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

    const eventEmitter = { emit: jest.fn(), emitAsync: jest.fn().mockResolvedValue([]) };

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
        // organizationRepository (EW-711 #27) — appended after the event
        // emitter; unused by the createWork defaults path under test, so a
        // bare stub suffices.
        {} as never,
        gitFacade as never,
    );

    return {
        service,
        deps: {
            workRepo,
            userRepo,
            gitFacade,
            quota,
            everWorksGit,
            everWorksDns,
            funnel,
            eventEmitter,
        },
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
            db: { choice: 'ever-works-db' },
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
            db: { choice: 'ever-works-db' },
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
            db: { choice: 'ever-works-db' },
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
            db: { choice: 'ever-works-db' },
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
            db: { choice: 'ever-works-db' },
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
            db: { choice: 'ever-works-db' },
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
            db: { choice: 'ever-works-db' },
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
        // EW-028 — the provisioned repo is registered under BOTH roles.
        // Managed storage is a single-repo model, and `getDataRepo()` reads the
        // `data` role: with only `work` recorded it fell through to the DERIVED
        // name `${slug}-data`, a repo nobody creates. This expectation used to
        // pin the `work`-only shape, i.e. it agreed with the bug.
        //
        // Note `relatedRepositories` is a PLAIN object inside `objectContaining`,
        // so it is matched EXACTLY — an extra role here is a failure, not a pass.
        // That is deliberate: it keeps this assertion honest about the roles a
        // managed Work actually gets.
        expect(persisted.sourceRepository).toEqual(
            expect.objectContaining({
                owner: 'ever-works-cloud',
                repo: 'evereq-my-work',
                relatedRepositories: {
                    work: { owner: 'ever-works-cloud', repo: 'evereq-my-work' },
                    data: { owner: 'ever-works-cloud', repo: 'evereq-my-work' },
                },
            }),
        );

        // WorkCreatedEvent emitted with platformActor payload.
        // Switched `emit` → `emitAsync` in commit 1652b3f8 so the
        // ActivityLog listener completes BEFORE createWork returns.
        expect(deps.eventEmitter.emitAsync).toHaveBeenCalledWith(
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
            db: { choice: 'ever-works-db' },
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
        // Event still emitted (via emitAsync — see comment above on the
        // EW-614 success-path assertion), but without platformActor payload.
        const emitted = deps.eventEmitter.emitAsync.mock.calls[0]?.[1];
        expect(emitted?.platformActor).toBeUndefined();
    });

    it('EW-614: provider EverWorksGitDisabledError → BadRequestException, no Work persisted', async () => {
        const { EverWorksGitDisabledError } = await import('../../ever-works-providers/types.js');
        const state: OnboardingWizardStateV2 = {
            version: 2,
            lastStep: 0,
            ai: { choice: 'ever-works' },
            storage: { choice: 'ever-works-git' },
            db: { choice: 'ever-works-db' },
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
            db: { choice: 'ever-works-db' },
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

    // ─────────────────────────────────────────────────────────────────────
    // Work-kind persistence — the create path stamps `work.kind` from the
    // DTO (normalized + whitelisted) so the kind-aware default website
    // template (PR #1681) can key off it. Omitted → the column default
    // `'default'` applies (workData must NOT carry a kind key at all).
    // ─────────────────────────────────────────────────────────────────────
    describe('work.kind persistence', () => {
        it.each(['website', 'landing-page', 'blog', 'directory', 'awesome-repo'])(
            'persists a user-selectable kind (%s) from the DTO',
            async (kind) => {
                const { service, deps } = makeService(null);

                await service.createWork({ ...baseDto, kind }, baseUser);

                const persisted = deps.workRepo.create.mock.calls[0][0];
                expect(persisted.kind).toBe(kind);
            },
        );

        it('normalizes the `landing` alias to the canonical `landing-page`', async () => {
            const { service, deps } = makeService(null);

            await service.createWork({ ...baseDto, kind: 'landing' }, baseUser);

            const persisted = deps.workRepo.create.mock.calls[0][0];
            expect(persisted.kind).toBe('landing-page');
        });

        it('leaves kind unset when the DTO omits it (column default applies)', async () => {
            const { service, deps } = makeService(null);

            await service.createWork(baseDto, baseUser);

            const persisted = deps.workRepo.create.mock.calls[0][0];
            expect('kind' in persisted).toBe(false);
        });

        it('coerces unknown kinds to `default` — arbitrary input never reaches the column', async () => {
            const { service, deps } = makeService(null);

            await service.createWork(
                { ...baseDto, kind: '<script>alert(1)</script>' } as CreateWorkDto,
                baseUser,
            );

            const persisted = deps.workRepo.create.mock.calls[0][0];
            expect(persisted.kind).toBe('default');
        });

        it('coerces `company` to `default` — Company Works only via the Register-Company flow', async () => {
            const { service, deps } = makeService(null);

            await service.createWork({ ...baseDto, kind: 'company' } as CreateWorkDto, baseUser);

            const persisted = deps.workRepo.create.mock.calls[0][0];
            expect(persisted.kind).toBe('default');
        });
    });

    it('EW-614: non-ever-works-git storage → provider never called even if flag on', async () => {
        const state: OnboardingWizardStateV2 = {
            version: 2,
            lastStep: 0,
            ai: { choice: 'ever-works' },
            storage: { choice: 'user-github' },
            db: { choice: 'ever-works-db' },
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

/**
 * Repository Work (self-build slice D, EW-766) — `kind: 'repo'` registers an
 * EXISTING code repository as the Work's data repository and provisions
 * nothing. These pin the create-path contract the fleet relies on:
 * `getDataRepo()` / `getRepoOwner()` resolve to the user's repo, and no
 * template, managed repo, deploy or generation is touched.
 */
describe('WorkLifecycleService.createWork — repository kind', () => {
    const repoDto: CreateWorkDto = {
        ...baseDto,
        slug: 'platform',
        name: 'Platform',
        kind: 'repo',
        repositoryUrl: 'https://github.com/ever-works/ever-works',
    } as CreateWorkDto;

    it('registers the repository as the data repository and provisions nothing', async () => {
        const { service, deps } = makeService(null);
        const dataGenerator = (service as unknown as { dataGenerator: { getItems: jest.Mock } })
            .dataGenerator;

        const result = await service.createWork(repoDto, baseUser);

        expect(result.status).toBe('success');
        expect(deps.workRepo.create).toHaveBeenCalledTimes(1);
        const persisted = deps.workRepo.create.mock.calls[0][0];
        expect(persisted.kind).toBe('repo');
        expect(persisted.owner).toBe('ever-works');
        expect(persisted.gitProvider).toBe('github');
        expect(persisted.storageProvider).toBe('user-github');
        expect(persisted.deployProvider).toBeNull();
        expect(persisted.websiteTemplateId).toBeNull();
        expect(persisted.generateStatus).toEqual({ status: 'generated', step: 'linked' });
        expect(persisted.sourceRepository).toMatchObject({
            url: 'https://github.com/ever-works/ever-works',
            owner: 'ever-works',
            repo: 'ever-works',
            type: 'link_existing',
            relatedRepositories: { data: { owner: 'ever-works', repo: 'ever-works' } },
        });
        expect(persisted.sourceRepository.relatedRepositories.work).toBeUndefined();
        expect(persisted.sourceRepository.relatedRepositories.website).toBeUndefined();
        // Not opted into the EW-628 poller: nothing to sync, and the default
        // of 5 would have the dispatcher hit the wrapped repo's API with the
        // owner's token every five minutes, forever.
        expect(persisted.syncIntervalMinutes).toBe(0);
        // No clone of a code repository looking for directory items.
        expect(dataGenerator.getItems).not.toHaveBeenCalled();
        expect(deps.workRepo.updateGenerateStatus).not.toHaveBeenCalled();
        // The caller's own access to the repository was verified first, with
        // the provider the URL names — not whatever the DTO defaulted to.
        expect(deps.gitFacade.hasRepositoryAccess).toHaveBeenCalledWith(
            'ever-works',
            'ever-works',
            {
                userId: baseUser.id,
                providerId: 'github',
            },
        );
    });

    it('skips the deploy quota and the managed Ever Works Git repo even when both would apply', async () => {
        process.env.DEPLOY_EVER_WORKS_ENABLED = 'true';
        const { service, deps } = makeService(null);
        deps.everWorksGit.isEnabled.mockReturnValue(true);

        await service.createWork(
            { ...repoDto, storageProvider: 'ever-works-git', deployProvider: 'ever-works' },
            baseUser,
        );

        expect(deps.quota.assertWithinQuota).not.toHaveBeenCalled();
        expect(deps.everWorksGit.createRepository).not.toHaveBeenCalled();
        const persisted = deps.workRepo.create.mock.calls[0][0];
        // The user's repository wins over the managed-storage choice: a
        // fresh platform-org repo is the opposite of "wrap this repo".
        expect(persisted.owner).toBe('ever-works');
        expect(persisted.storageProvider).toBe('user-github');
        expect(persisted.deployProvider).toBeNull();
        expect(persisted.id).toBeUndefined();
    });

    it('ignores a website template selection — a code repository has no template', async () => {
        const { service } = makeService(null);
        const templateCatalog = (
            service as unknown as {
                templateCatalogService: { getVisibleTemplateForUser: jest.Mock };
            }
        ).templateCatalogService;

        await service.createWork({ ...repoDto, websiteTemplateId: 'classic' }, baseUser);

        expect(templateCatalog.getVisibleTemplateForUser).not.toHaveBeenCalled();
    });

    it.each([
        ['missing', undefined],
        ['blank', '   '],
        ['not a repository URL', 'https://example.com/not-a-repo'],
        ['an ssh remote', 'git@github.com:ever-works/ever-works.git'],
        // Only the GitHub git-provider plugin exists; a GitLab Work would be
        // one no Task can ever clone, so it is refused at the door.
        ['a GitLab URL (no GitLab git-provider plugin yet)', 'https://gitlab.com/group/project'],
    ])(
        'rejects a repo Work whose repositoryUrl is %s before any side effect',
        async (_label, url) => {
            const { service, deps } = makeService(null);

            await expect(
                service.createWork({ ...repoDto, repositoryUrl: url } as CreateWorkDto, baseUser),
            ).rejects.toBeInstanceOf(BadRequestException);

            expect(deps.workRepo.create).not.toHaveBeenCalled();
            expect(deps.eventEmitter.emitAsync).not.toHaveBeenCalled();
        },
    );

    it('leaves every other kind on the existing path — repositoryUrl is ignored there', async () => {
        const { service, deps } = makeService(null);

        await service.createWork(
            { ...baseDto, kind: 'directory', repositoryUrl: 'https://github.com/o/r' },
            baseUser,
        );

        const persisted = deps.workRepo.create.mock.calls[0][0];
        expect(persisted.kind).toBe('directory');
        expect(persisted.sourceRepository).toBeUndefined();
        expect(persisted.deployProvider).toBe('vercel');
        // Nothing to verify for a generated data repository.
        expect(deps.gitFacade.hasRepositoryAccess).not.toHaveBeenCalled();
    });

    // ─────────────────────────────────────────────────────────────────────
    // Registration is verified, not just parsed: the repository must be
    // reachable with the caller's own connection, hosted on the provider
    // they selected, and not already wrapped by another account. All of it
    // BEFORE any row exists.
    // ─────────────────────────────────────────────────────────────────────
    it('rejects a repository the caller cannot read (404/403 from the provider) with a 400 and no row', async () => {
        const { service, deps } = makeService(null);
        deps.gitFacade.hasRepositoryAccess.mockResolvedValue(false);

        await expect(service.createWork(repoDto, baseUser)).rejects.toMatchObject({
            status: 400,
            response: expect.objectContaining({
                message: expect.stringContaining('not found or is not accessible'),
            }),
        });

        expect(deps.workRepo.create).not.toHaveBeenCalled();
        expect(deps.eventEmitter.emitAsync).not.toHaveBeenCalled();
    });

    it('turns "no connected account" from the git facade into a 400 that says so, with no row', async () => {
        const { service, deps } = makeService(null);
        deps.gitFacade.hasRepositoryAccess.mockRejectedValue(
            new Error('No connected account found for user u-1 with provider github'),
        );

        await expect(service.createWork(repoDto, baseUser)).rejects.toMatchObject({
            status: 400,
            response: expect.objectContaining({
                message: expect.stringContaining('Could not verify access'),
            }),
        });

        expect(deps.workRepo.create).not.toHaveBeenCalled();
    });

    it('rejects a URL hosted on a different provider than the one the caller selected, before probing anything', async () => {
        const { service, deps } = makeService(null);

        await expect(
            service.createWork({ ...repoDto, gitProvider: 'gitlab' } as CreateWorkDto, baseUser),
        ).rejects.toMatchObject({
            status: 400,
            response: expect.objectContaining({
                message: expect.stringContaining('hosted on github'),
            }),
        });

        expect(deps.gitFacade.hasRepositoryAccess).not.toHaveBeenCalled();
        expect(deps.workRepo.create).not.toHaveBeenCalled();
    });

    it('refuses (409) a repository another account already wraps — the checkout is keyed by owner/repo, not by Work', async () => {
        const { service, deps } = makeService(null);
        deps.workRepo.findRepositoryWorksWrapping.mockResolvedValue([
            { id: 'w-other', userId: 'someone-else', slug: 'their-platform' },
        ]);

        await expect(service.createWork(repoDto, baseUser)).rejects.toMatchObject({
            status: 409,
        });

        expect(deps.workRepo.findRepositoryWorksWrapping).toHaveBeenCalledWith(
            'ever-works',
            'ever-works',
        );
        expect(deps.workRepo.create).not.toHaveBeenCalled();
    });

    it('lets the SAME account register the repository again — one token, one checkout, no cross-tenant clobber', async () => {
        const { service, deps } = makeService(null);
        deps.workRepo.findRepositoryWorksWrapping.mockResolvedValue([
            { id: 'w-mine', userId: baseUser.id, slug: 'platform' },
        ]);

        const result = await service.createWork(
            { ...repoDto, slug: 'platform-again' } as CreateWorkDto,
            baseUser,
        );

        expect(result.status).toBe('success');
        expect(deps.workRepo.create).toHaveBeenCalledTimes(1);
    });

    it('rejects the quick-create shape (kind repo, no repositoryUrl on the DTO) with a 400 before any row', async () => {
        // `POST /api/works/quick-create` builds a CreateWorkDto without
        // `repositoryUrl` (QuickCreateWorkDto has none) — this is exactly
        // what reaches createWork from that controller.
        const { service, deps } = makeService(null);
        const quickCreateShape = Object.assign(new CreateWorkDto(), {
            slug: 'platform',
            name: 'Platform',
            description: 'A description',
            owner: undefined,
            organization: false,
            gitProvider: 'github',
            kind: 'repo',
        });

        await expect(service.createWork(quickCreateShape, baseUser)).rejects.toMatchObject({
            status: 400,
            response: expect.objectContaining({
                message: expect.stringContaining('repositoryUrl'),
            }),
        });

        expect(deps.workRepo.create).not.toHaveBeenCalled();
        expect(deps.gitFacade.hasRepositoryAccess).not.toHaveBeenCalled();
        expect(deps.eventEmitter.emitAsync).not.toHaveBeenCalled();
    });
});
