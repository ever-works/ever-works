import type { IBuildPlugin } from '@ever-works/plugin';

import { BuildFacadeService, type BuildTokenSource } from '../build-facade.service';
import {
    createGitHubRepositoryVisibilityProbe,
    VISIBILITY_CACHE_TTL_MS,
    type RepositoryVisibilityProbe,
} from '../repository-visibility.probe';

/**
 * 2026-10-18 — a public Cal fork (`build.resources.memory: 12Gi`) was blocked
 * `runnerTooSmall` because the facts source always answers `private` (7 GiB
 * runner). The probe asks GitHub, and only an explicit public answer upgrades.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function respond(status: number, body: unknown): typeof fetch {
    return jest.fn(async () => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    })) as never;
}

describe('createGitHubRepositoryVisibilityProbe', () => {
    const input = { owner: 'ever-works', repo: 'cal.diy', token: 'ghs-not-a-real-token' };

    it('answers public only for an explicit public repository', async () => {
        const probe = createGitHubRepositoryVisibilityProbe(
            respond(200, { private: false, visibility: 'public' }),
        );
        await expect(probe(input)).resolves.toBe('public');
    });

    it('answers private for a private or internal repository', async () => {
        await expect(
            createGitHubRepositoryVisibilityProbe(
                respond(200, { private: true, visibility: 'private' }),
            )(input),
        ).resolves.toBe('private');
        await expect(
            createGitHubRepositoryVisibilityProbe(
                respond(200, { private: false, visibility: 'internal' }),
            )(input),
        ).resolves.toBe('private');
    });

    it('answers null on a non-200, a throw, or a missing token', async () => {
        await expect(
            createGitHubRepositoryVisibilityProbe(respond(404, {}))(input),
        ).resolves.toBeNull();
        const throwing = jest.fn(async () => {
            throw new Error('network down');
        }) as never;
        await expect(createGitHubRepositoryVisibilityProbe(throwing)(input)).resolves.toBeNull();
        const fetchImpl = respond(200, { private: false, visibility: 'public' });
        await expect(
            createGitHubRepositoryVisibilityProbe(fetchImpl)({ ...input, token: '' }),
        ).resolves.toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('sends the build credential and caches the answer for the TTL', async () => {
        let clock = 1_000;
        const fetchImpl = respond(200, { private: false, visibility: 'public' });
        const probe = createGitHubRepositoryVisibilityProbe(fetchImpl, () => clock);

        await probe(input);
        await probe(input);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0];
        expect(url).toBe('https://api.github.com/repos/ever-works/cal.diy');
        expect(init.headers.Authorization).toBe('Bearer ghs-not-a-real-token');

        clock += VISIBILITY_CACHE_TTL_MS + 1;
        await probe(input);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});

describe('BuildFacadeService + visibility probe', () => {
    const tokens: BuildTokenSource = { getBuildToken: async () => 'ghs-not-a-real-token' };
    const registry = {
        getAll: () => [
            {
                state: 'loaded',
                manifest: { capabilities: ['build'] },
                plugin: {
                    id: 'github-actions-build',
                    buildKind: 'github-actions',
                    startBuild: async () => ({
                        providerRunId: '1',
                        dispatchedAt: '2026-10-18T00:00:00.000Z',
                    }),
                    cancelBuild: async () => undefined,
                } as Partial<IBuildPlugin>,
            },
        ],
    } as never;
    const repository = {
        findById: async () => ({
            id: WORK_ID,
            getWebsiteRepo: () => 'cal.diy',
            getRepoOwner: () => 'ever-works',
        }),
    } as never;
    const privateFacts = {
        getBuildRepositoryFacts: async () => ({
            visibility: 'private' as const,
            createdByAppWork: true,
        }),
    };

    function facade(probe?: RepositoryVisibilityProbe) {
        return new BuildFacadeService(registry, repository, tokens, privateFacts, undefined, probe);
    }

    it('upgrades the fail-safe private answer when GitHub says public', async () => {
        const probe = jest.fn(async () => 'public' as const);
        const binding = await facade(probe).resolve(WORK_ID, USER_ID);
        expect(binding?.repository?.visibility).toBe('public');
        expect(probe).toHaveBeenCalledWith({
            owner: 'ever-works',
            repo: 'cal.diy',
            token: 'ghs-not-a-real-token',
        });
    });

    it('keeps private when the probe cannot answer, throws, or is absent', async () => {
        expect(
            (await facade(async () => null).resolve(WORK_ID, USER_ID))?.repository?.visibility,
        ).toBe('private');
        const throwing: RepositoryVisibilityProbe = async () => {
            throw new Error('boom');
        };
        expect((await facade(throwing).resolve(WORK_ID, USER_ID))?.repository?.visibility).toBe(
            'private',
        );
        expect((await facade().resolve(WORK_ID, USER_ID))?.repository?.visibility).toBe('private');
    });
});
