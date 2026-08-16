import { describe, expect, it, vi } from 'vitest';

// Keep the import graph hermetic: the component pulls in server actions
// (which reach for the API client + auth cookie) and toast/i18n runtimes
// that a pure-payload assertion has no business booting.
vi.mock('@/app/actions/repo-connections', () => ({
    createRepoConnection: vi.fn(),
    deleteRepoConnection: vi.fn(),
    importRepoConnectionFromGithubApp: vi.fn(),
    revealRepoConnectionEnvFiles: vi.fn(),
    saveRepoConnectionEnvFiles: vi.fn(),
    updateRepoConnection: vi.fn(),
}));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/i18n/navigation', () => ({
    Link: () => null,
    usePathname: () => '/settings/repositories',
    useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
    redirect: vi.fn(),
    getPathname: () => '/settings/repositories',
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { buildRepoConnectionPayload, type FormState } from './RepositoriesSettings';

/**
 * `undefined` = leave alone, `null` = clear — the API's semantics, which
 * the Settings → Repositories form has to speak for an edit to be able to
 * EMPTY a field. The builder used to omit empty values, so clearing Mount
 * Path / Default Branch / Description, or switching Credential Key back to
 * "Inherited", saved successfully and silently kept the old value.
 */
const form = (overrides: Partial<FormState> = {}): FormState => ({
    name: 'my-service',
    url: 'https://github.com/acme/my-service',
    defaultBranch: 'main',
    mountPath: 'svc',
    description: 'the service',
    credentialMode: 'secret-ref',
    credentialRef: 'env:MY_TOKEN',
    availableInAllProjects: true,
    ...overrides,
});

describe('buildRepoConnectionPayload', () => {
    it('sends filled fields as trimmed values', () => {
        expect(buildRepoConnectionPayload(form({ name: '  my-service  ' }))).toEqual({
            name: 'my-service',
            url: 'https://github.com/acme/my-service',
            defaultBranch: 'main',
            mountPath: 'svc',
            description: 'the service',
            credentialMode: 'secret-ref',
            credentialRef: 'env:MY_TOKEN',
            availableInAllProjects: true,
        });
    });

    it('sends explicit null for every emptied field (so an edit can CLEAR)', () => {
        const payload = buildRepoConnectionPayload(
            form({ defaultBranch: '', mountPath: '   ', description: '' }),
        );
        expect(payload.defaultBranch).toBeNull();
        expect(payload.mountPath).toBeNull();
        expect(payload.description).toBeNull();
        // Not merely absent — absent means "leave alone" to the API.
        expect(Object.keys(payload)).toEqual(
            expect.arrayContaining(['defaultBranch', 'mountPath', 'description']),
        );
    });

    it('drops the stale credential pointer when the mode goes back to inherit', () => {
        const payload = buildRepoConnectionPayload(
            form({ credentialMode: 'inherit', credentialRef: 'env:MY_TOKEN' }),
        );
        expect(payload.credentialMode).toBe('inherit');
        expect(payload.credentialRef).toBeNull();
    });

    it('clears the pointer when a non-inherit mode is left blank', () => {
        const payload = buildRepoConnectionPayload(
            form({ credentialMode: 'github-app', credentialRef: '  ' }),
        );
        expect(payload.credentialRef).toBeNull();
    });
});
