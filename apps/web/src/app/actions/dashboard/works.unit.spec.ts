import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression coverage for the managed "Ever Works Git" storage choice.
 *
 * The bug: `createWork` / `createWorkWithAI` gated on a *personal* connected
 * git provider before ever calling the API. A freshly registered user who
 * took the onboarding wizard's DEFAULT storage option ("Ever Works Git —
 * push your work repos to a managed Ever Works GitHub org") therefore could
 * not create a Work at all: the form showed "Git Provider — Not connected"
 * and Generate returned `requiresGitProvider` without creating anything.
 *
 * The API never required a personal provider for that choice —
 * `WorkLifecycleService.resolveProviderDefaults` reads the user's
 * `onboardingState`, maps `ever-works-git` → git provider `github`, and
 * provisions the repository in the managed org with the platform's own PAT.
 *
 * What these specs pin:
 *   1. managed storage + feature enabled → NOT blocked, reaches `workAPI.create`.
 *   2. that call carries `storageProvider: 'ever-works-git'` (zod strips
 *      undeclared keys, so this is easy to silently lose).
 *   3. personal `user-github` + unconnected provider → STILL blocked.
 *   4. personal choice + no provider id at all → STILL blocked.
 *   5. the capability is read from the platform catalog, so `ever-works-git`
 *      on an environment where the feature is OFF keeps the gate.
 *   6. a failure reading onboarding state fails CLOSED (keeps the gate).
 */

const {
    getAuthFromCookieMock,
    checkGitProviderConnectionMock,
    workAPICreateMock,
    generateDetailsMock,
    itemsGenerateMock,
    getStateMock,
    getCatalogMock,
    redirectMock,
} = vi.hoisted(() => ({
    getAuthFromCookieMock: vi.fn(),
    checkGitProviderConnectionMock: vi.fn(),
    workAPICreateMock: vi.fn(),
    generateDetailsMock: vi.fn(),
    itemsGenerateMock: vi.fn(),
    getStateMock: vi.fn(),
    getCatalogMock: vi.fn(),
    redirectMock: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
    getAuthFromCookie: getAuthFromCookieMock,
}));

vi.mock('./oauth', () => ({
    checkGitProviderConnection: checkGitProviderConnectionMock,
}));

vi.mock('@/lib/api/onboarding', () => ({
    onboardingAPI: {
        getState: getStateMock,
        getCatalog: getCatalogMock,
    },
}));

vi.mock('@/lib/api', () => ({
    workAPI: {
        create: workAPICreateMock,
        generateDetails: generateDetailsMock,
    },
    itemsGeneratorAPI: {
        generate: itemsGenerateMock,
    },
}));

vi.mock('@/lib/api/work-proposals', () => ({
    workProposalsAPI: { accept: vi.fn() },
}));

vi.mock('@/lib/api/server-api', () => ({
    serverMutation: vi.fn(),
    ApiResponseError: class ApiResponseError extends Error {},
}));

// `t('oauthRequired', { provider })` → a stable, assertable string.
vi.mock('next-intl/server', () => ({
    getTranslations: async () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${JSON.stringify(values)}` : key,
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

/** Catalog payload with the managed-storage card flipped on or off. */
function catalogWithEverWorksGit(available: boolean) {
    return {
        ai: [],
        storage: [
            {
                choice: 'ever-works-git',
                title: 'Ever Works Git',
                description: 'Push your work repos to a managed Ever Works GitHub org.',
                default: true,
                available,
                badges: available ? ['default'] : ['default', 'planned'],
            },
            {
                choice: 'user-github',
                title: 'Your GitHub',
                description: 'Push work repos to your own GitHub account or org.',
                default: false,
                available: true,
                badges: [],
                pluginId: 'github',
            },
        ],
        db: [],
        deploy: [],
        desktop: [],
        plugins: [],
    };
}

function onboardingStateWith(storageChoice: string) {
    return {
        completedAt: null,
        dismissedAt: null,
        state: {
            version: 2,
            lastStep: 3,
            ai: { choice: 'ever-works' },
            storage: { choice: storageChoice },
            db: { choice: 'ever-works-db' },
            deploy: { choice: 'ever-works' },
            skippedSteps: [],
            pluginsReviewed: false,
        },
    };
}

const AI_REQUEST = {
    name: 'K8s Operators',
    prompt: 'A directory of open-source Kubernetes database operators with maturity tags.',
};

describe('Work creation honours the managed Ever Works Git storage choice', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthFromCookieMock.mockResolvedValue({ id: 'user-1', username: 'qa-user' });
        workAPICreateMock.mockResolvedValue({ work: { id: 'work-1', slug: 'k8s-operators' } });
        // No AI provider is selected in these specs, so `generateDetails` is
        // never reached; keep it defined so an accidental call is visible.
        generateDetailsMock.mockResolvedValue({
            name: 'K8s Operators',
            slug: 'k8s-operators',
            description: 'desc',
            keywords: [],
            categories: [],
        });
        itemsGenerateMock.mockResolvedValue({});
    });

    afterEach(() => {
        vi.resetModules();
    });

    describe('managed storage (wizard choice `ever-works-git`, feature enabled)', () => {
        beforeEach(() => {
            getStateMock.mockResolvedValue(onboardingStateWith('ever-works-git'));
            getCatalogMock.mockResolvedValue(catalogWithEverWorksGit(true));
        });

        it('createWorkWithAI does NOT return requiresGitProvider and reaches the API', async () => {
            const { createWorkWithAI } = await import('./works');

            const result = await createWorkWithAI(AI_REQUEST);

            expect(result.requiresGitProvider).toBeUndefined();
            expect(result.success).toBe(true);
            expect(workAPICreateMock).toHaveBeenCalledTimes(1);
        });

        it('never asks whether a personal git provider is connected', async () => {
            const { createWorkWithAI } = await import('./works');

            await createWorkWithAI(AI_REQUEST);

            expect(checkGitProviderConnectionMock).not.toHaveBeenCalled();
        });

        it('sends storageProvider=ever-works-git so the API provisions the managed repo', async () => {
            const { createWorkWithAI } = await import('./works');

            await createWorkWithAI(AI_REQUEST);

            expect(workAPICreateMock.mock.calls[0]![0]).toMatchObject({
                storageProvider: 'ever-works-git',
            });
        });

        it('works with no gitProvider selected at all (nothing to connect)', async () => {
            const { createWorkWithAI } = await import('./works');

            const result = await createWorkWithAI({ ...AI_REQUEST, gitProvider: undefined });

            expect(result.success).toBe(true);
            expect(result.requiresGitProvider).toBeUndefined();
        });

        it('createWork (manual form) is unblocked on the same terms', async () => {
            const { createWork } = await import('./works');

            const result = await createWork({
                slug: 'k8s-operators',
                name: 'K8s Operators',
                description: 'A directory of open-source Kubernetes database operators.',
                organization: false,
            });

            expect(result.requiresGitProvider).toBeUndefined();
            expect(result.success).toBe(true);
            expect(workAPICreateMock.mock.calls[0]![0]).toMatchObject({
                storageProvider: 'ever-works-git',
            });
        });

        // Self-build slice D (EW-766): a Repository Work is verified against
        // the caller's OWN connected account on the API, so managed storage
        // is no shortcut for the kind — the gate asks for a personal
        // connection so the form can say "connect GitHub" up front.
        it('createWork with kind=repo still requires a connected personal provider under managed storage', async () => {
            checkGitProviderConnectionMock.mockResolvedValue({ success: true, connected: false });
            const { createWork } = await import('./works');

            const result = await createWork({
                slug: 'platform',
                name: 'Platform',
                description: 'The platform monorepo.',
                organization: false,
                gitProvider: 'github',
                kind: 'repo',
                repositoryUrl: 'https://github.com/ever-works/ever-works',
            });

            expect(result.success).toBe(false);
            expect(result.requiresGitProvider).toBe(true);
            expect(checkGitProviderConnectionMock).toHaveBeenCalledWith('github');
            expect(workAPICreateMock).not.toHaveBeenCalled();
        });

        it('createWork with kind=repo reaches the API with kind + repositoryUrl once the provider is connected', async () => {
            checkGitProviderConnectionMock.mockResolvedValue({
                success: true,
                connected: true,
                username: 'qa-user',
                organizations: [],
            });
            const { createWork } = await import('./works');

            const result = await createWork({
                slug: 'platform',
                name: 'Platform',
                description: 'The platform monorepo.',
                organization: false,
                gitProvider: 'github',
                kind: 'repo',
                repositoryUrl: 'https://github.com/ever-works/ever-works',
            });

            expect(result.success).toBe(true);
            expect(workAPICreateMock.mock.calls[0]![0]).toMatchObject({
                kind: 'repo',
                repositoryUrl: 'https://github.com/ever-works/ever-works',
                gitProvider: 'github',
            });
        });
    });

    describe('personal storage still requires a connected provider', () => {
        beforeEach(() => {
            getStateMock.mockResolvedValue(onboardingStateWith('user-github'));
            getCatalogMock.mockResolvedValue(catalogWithEverWorksGit(true));
        });

        it('blocks with requiresGitProvider when the selected provider is not connected', async () => {
            checkGitProviderConnectionMock.mockResolvedValue({ success: true, connected: false });
            const { createWorkWithAI } = await import('./works');

            const result = await createWorkWithAI({ ...AI_REQUEST, gitProvider: 'github' });

            expect(result.success).toBe(false);
            expect(result.requiresGitProvider).toBe(true);
            expect(workAPICreateMock).not.toHaveBeenCalled();
        });

        it('blocks with requiresGitProvider when no provider was selected', async () => {
            const { createWorkWithAI } = await import('./works');

            const result = await createWorkWithAI({ ...AI_REQUEST, gitProvider: undefined });

            expect(result.success).toBe(false);
            expect(result.requiresGitProvider).toBe(true);
            expect(workAPICreateMock).not.toHaveBeenCalled();
        });

        it('proceeds — without a storageProvider override — once the provider IS connected', async () => {
            checkGitProviderConnectionMock.mockResolvedValue({
                success: true,
                connected: true,
                username: 'qa-user',
            });
            const { createWorkWithAI } = await import('./works');

            const result = await createWorkWithAI({ ...AI_REQUEST, gitProvider: 'github' });

            expect(result.success).toBe(true);
            expect(workAPICreateMock.mock.calls[0]![0].storageProvider).toBeUndefined();
        });

        it('createWork (manual form) still blocks an unconnected provider', async () => {
            checkGitProviderConnectionMock.mockResolvedValue({ success: true, connected: false });
            const { createWork } = await import('./works');

            const result = await createWork({
                slug: 'k8s-operators',
                name: 'K8s Operators',
                description: 'A directory of open-source Kubernetes database operators.',
                organization: false,
                gitProvider: 'github',
            });

            expect(result.success).toBe(false);
            expect(result.requiresGitProvider).toBe(true);
            expect(workAPICreateMock).not.toHaveBeenCalled();
        });
    });

    describe('an explicit DTO storageProvider decides the gate too', () => {
        // `resolveProviderDefaults` puts the DTO first, so the gate must be
        // resolved from the SAME value the request will carry. Deciding it
        // from onboarding state while sending a different provider is exactly
        // how the two tiers silently disagreed in the first place — and a
        // server action is reachable as a POST endpoint, so the override is
        // attacker-controllable.
        beforeEach(() => {
            getCatalogMock.mockResolvedValue(catalogWithEverWorksGit(true));
        });

        it('keeps the gate when the DTO overrides a managed onboarding choice with user-github', async () => {
            getStateMock.mockResolvedValue(onboardingStateWith('ever-works-git'));
            checkGitProviderConnectionMock.mockResolvedValue({ success: true, connected: false });
            const { createWork } = await import('./works');

            const result = await createWork({
                slug: 'k8s-operators',
                name: 'K8s Operators',
                description: 'A directory of open-source Kubernetes database operators.',
                organization: false,
                gitProvider: 'github',
                storageProvider: 'user-github',
            });

            expect(result.success).toBe(false);
            expect(result.requiresGitProvider).toBe(true);
            expect(workAPICreateMock).not.toHaveBeenCalled();
        });

        it('lifts the gate when the DTO explicitly asks for ever-works-git', async () => {
            getStateMock.mockResolvedValue(onboardingStateWith('user-github'));
            const { createWork } = await import('./works');

            const result = await createWork({
                slug: 'k8s-operators',
                name: 'K8s Operators',
                description: 'A directory of open-source Kubernetes database operators.',
                organization: false,
                storageProvider: 'ever-works-git',
            });

            expect(result.success).toBe(true);
            expect(checkGitProviderConnectionMock).not.toHaveBeenCalled();
            expect(workAPICreateMock.mock.calls[0]![0]).toMatchObject({
                storageProvider: 'ever-works-git',
            });
        });
    });

    describe('platform capability is read from the catalog, never assumed', () => {
        it('keeps the gate when the user chose ever-works-git but the platform has it OFF (e.g. dev)', async () => {
            getStateMock.mockResolvedValue(onboardingStateWith('ever-works-git'));
            getCatalogMock.mockResolvedValue(catalogWithEverWorksGit(false));
            checkGitProviderConnectionMock.mockResolvedValue({ success: true, connected: false });

            const { createWorkWithAI } = await import('./works');

            const result = await createWorkWithAI({ ...AI_REQUEST, gitProvider: 'github' });

            expect(result.success).toBe(false);
            expect(result.requiresGitProvider).toBe(true);
            expect(workAPICreateMock).not.toHaveBeenCalled();
        });

        it('fails CLOSED when the onboarding state cannot be read', async () => {
            getStateMock.mockRejectedValue(new Error('upstream 503'));
            getCatalogMock.mockResolvedValue(catalogWithEverWorksGit(true));
            checkGitProviderConnectionMock.mockResolvedValue({ success: true, connected: false });

            const { createWorkWithAI } = await import('./works');

            const result = await createWorkWithAI({ ...AI_REQUEST, gitProvider: 'github' });

            expect(result.success).toBe(false);
            expect(result.requiresGitProvider).toBe(true);
        });

        it('fails CLOSED when the catalog cannot be read', async () => {
            getStateMock.mockResolvedValue(onboardingStateWith('ever-works-git'));
            getCatalogMock.mockRejectedValue(new Error('upstream 503'));
            checkGitProviderConnectionMock.mockResolvedValue({ success: true, connected: false });

            const { createWorkWithAI } = await import('./works');

            const result = await createWorkWithAI({ ...AI_REQUEST, gitProvider: 'github' });

            expect(result.success).toBe(false);
            expect(result.requiresGitProvider).toBe(true);
        });
    });
});
