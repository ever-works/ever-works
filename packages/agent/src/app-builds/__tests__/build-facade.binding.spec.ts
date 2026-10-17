import { APP_BUILD_WORKFLOW_PATH } from '@ever-works/contracts';
import type { IBuildPlugin, RepositoryWriter } from '@ever-works/plugin';

import { BuildFacadeService, type BuildFacadeBinding } from '../build-facade.service';

/**
 * Outstanding-work A0.4 / ledger D19 — the facade's FULL binding.
 *
 * Until 2026-10-17 `resolve` answered only `startBuild`, `cancelBuild` and
 * `checkImageAccess`, so the prepare runner (`binding.prepareRepository`) and the
 * watch runner (`binding.getBuild`, `binding.auth`) both answered
 * `pluginUnavailable` in production: no Build could be prepared, and none could
 * be observed to `succeeded`. These cases pin each member the runners read.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'ghs-not-a-real-token';

const writer: RepositoryWriter = {
    getFileContent: jest.fn(async () => null),
    commitFiles: jest.fn(async () => ({ commitSha: 'c' })),
    createBranch: jest.fn(async () => ({ name: 'b', commit: 'c', isDefault: false })),
    createPullRequest: jest.fn(),
} as never;

function plugin(overrides: Partial<IBuildPlugin> = {}) {
    return {
        id: 'github-actions-build',
        name: 'GitHub Actions builds',
        buildKind: 'github-actions',
        startBuild: jest.fn(async () => ({
            providerRunId: null,
            dispatchedAt: '2026-10-17T10:00:00Z',
        })),
        cancelBuild: jest.fn(async () => undefined),
        prepareRepository: jest.fn(async () => ({
            workflow: { state: 'unchanged', contentSha256: '' },
        })),
        getBuild: jest.fn(async () => null),
        listRecentRuns: jest.fn(async () => ({ notModified: true, runs: [] })),
        repositoryWriter: jest.fn(() => writer),
        ...overrides,
    } as unknown as Record<string, jest.Mock> & { id: string };
}

function facade(
    p: ReturnType<typeof plugin>,
    settings: Record<string, unknown> = { reclaimDisk: true },
) {
    const registry = {
        getAll: () => [{ state: 'loaded', manifest: { capabilities: ['build'] }, plugin: p }],
    } as never;
    const works = {
        findById: async () => ({
            id: WORK_ID,
            getWebsiteRepo: () => 'app',
            getRepoOwner: () => 'acme',
        }),
    } as never;
    return new BuildFacadeService(
        registry,
        works,
        { getBuildToken: async () => TOKEN },
        {
            getBuildRepositoryFacts: async () => ({
                visibility: 'public',
                createdByAppWork: true,
                trackedBranch: 'develop',
            }),
        },
        { getBuildSettings: async () => settings },
    );
}

describe('BuildFacadeService — the full binding (A0.4)', () => {
    it('carries the repository on the TRACKED branch, the settings, the auth and the writer', async () => {
        const p = plugin();
        const binding = (await facade(p).resolve(WORK_ID, USER_ID)) as BuildFacadeBinding;

        expect(binding.name).toBe('GitHub Actions builds');
        expect(binding.repository).toEqual({
            owner: 'acme',
            repo: 'app',
            visibility: 'public',
            trackedBranch: 'develop',
            createdByAppWork: true,
        });
        expect(binding.settings).toEqual({ reclaimDisk: true });
        expect(binding.auth).toEqual({ token: TOKEN });
        expect(binding.writer).toBe(writer);
        expect(p.repositoryWriter).toHaveBeenCalledWith(
            { owner: 'acme', repo: 'app', trackedBranch: 'develop' },
            { token: TOKEN },
        );
    });

    it('prepares with its own credential and writer, whatever the caller passes', async () => {
        const p = plugin();
        const binding = (await facade(p).resolve(WORK_ID, USER_ID)) as BuildFacadeBinding;
        await binding.prepareRepository!({ appSpecHash: 'h' } as never, undefined, undefined);

        const [input, auth, usedWriter] = p.prepareRepository.mock.calls[0];
        expect(auth).toEqual({ token: TOKEN });
        expect(usedWriter).toBe(writer);
        expect(input.repository.trackedBranch).toBe('develop');
        expect(input.settings).toEqual({ reclaimDisk: true });
    });

    it('observes only its own repository', async () => {
        const p = plugin();
        const binding = (await facade(p).resolve(WORK_ID, USER_ID)) as BuildFacadeBinding;
        const redact = (text: string) => text;
        await binding.getBuild!(
            {
                repository: { owner: 'someone', repo: 'else' },
                buildId: 'b1',
                providerRunId: '1',
            } as never,
            { token: 'other' },
            redact,
        );
        const [ref, auth] = p.getBuild.mock.calls[0];
        expect(ref.repository.owner).toBe('acme');
        expect(auth).toEqual({ token: TOKEN });
    });

    it('lists the build workflow runs of its own repository (run discovery)', async () => {
        const p = plugin();
        const binding = (await facade(p).resolve(WORK_ID, USER_ID)) as BuildFacadeBinding;
        await binding.listRecentRuns!({ perPage: 20, etag: 'e1' });
        expect(p.listRecentRuns).toHaveBeenCalledWith(
            {
                repository: { owner: 'acme', name: 'app' },
                workflowPath: APP_BUILD_WORKFLOW_PATH,
                perPage: 20,
                etag: 'e1',
            },
            { token: TOKEN },
        );
    });

    it('dispatches with the resolved settings, not an empty map', async () => {
        const p = plugin();
        const binding = (await facade(p).resolve(WORK_ID, USER_ID)) as BuildFacadeBinding;
        await binding.startBuild!({
            buildId: 'b1',
            ref: 'develop',
            sha: 'a'.repeat(40),
            mode: 'build',
        });
        expect(p.startBuild.mock.calls[0][0].settings).toEqual({ reclaimDisk: true });
    });

    it('offers no prepareRepository when the plugin has no writer', async () => {
        const p = plugin({ repositoryWriter: undefined } as never);
        const binding = (await facade(p).resolve(WORK_ID, USER_ID)) as BuildFacadeBinding;
        expect(binding.prepareRepository).toBeUndefined();
        expect(binding.writer).toBeUndefined();
        // Observation does not need a writer.
        expect(binding.getBuild).toBeDefined();
    });
});
