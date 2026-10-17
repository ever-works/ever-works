import type { BuildRunRef } from '@ever-works/contracts';

import {
    APP_BUILD_DISCOVERY_RECHECK_MARGIN_MS,
    AppBuildRunDiscoveryService,
} from '../app-build-run-discovery.service';

/**
 * APW-05 T21a — run discovery (plan §7.4a, `APW05-G01`, ACC-05-11).
 *
 * The accept rules (strategy gate, fork-PR rule, one Build per run) are
 * `AppBuildsService.recordProviderRun`'s and are proved in its own spec; this
 * one proves the scope, the cursor and the filters discovery adds on top.
 */

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const WRITTEN = new Date(NOW - 60 * 60_000);

function run(overrides: Partial<BuildRunRef> = {}): BuildRunRef {
    return {
        providerRunId: '1',
        runAttempt: 1,
        event: 'push',
        status: 'running',
        headSha: 'a'.repeat(40),
        headBranch: 'main',
        headRepositoryFullName: 'acme/app',
        displayTitle: 't',
        createdAt: new Date(NOW - 60_000).toISOString(),
        ...overrides,
    };
}

function harness(
    options: {
        rows?: Array<Record<string, unknown>>;
        page?: { notModified: boolean; etag?: string; runs: BuildRunRef[] };
        binding?: unknown;
    } = {},
) {
    const rows = options.rows ?? [
        { workId: 'w1', runsEtag: 'old', runsCheckedAt: null, workflowWrittenAt: WRITTEN },
    ];
    const preparations = {
        findDiscoveryCandidates: jest.fn(async () => rows),
        upsertAfterPrepare: jest.fn(async () => ({})),
    };
    const builds = {
        recordProviderRun: jest.fn(async (_workId: string, _run: BuildRunRef, _source: string) => ({
            accepted: true,
            build: { id: 'b' },
            created: true,
        })),
    };
    const listRecentRuns = jest.fn(
        async () => options.page ?? { notModified: false, etag: 'new', runs: [run()] },
    );
    const binding = 'binding' in options ? options.binding : { pluginId: 'p', listRecentRuns };
    const works = { read: jest.fn(async (workId: string) => ({ workId, userId: 'u1' })) };
    const plugins = { resolve: jest.fn(async () => binding) };
    const service = new AppBuildRunDiscoveryService(
        preparations as never,
        builds as never,
        works as never,
        plugins as never,
    );
    return { service, preparations, builds, listRecentRuns, plugins };
}

describe('AppBuildRunDiscoveryService (APW-05 T21a)', () => {
    it('records a run with no delivery through recordProviderRun(…, "poll") and stores the cursor', async () => {
        const h = harness();
        const summary = await h.service.discover(NOW);

        expect(h.listRecentRuns).toHaveBeenCalledWith({ perPage: 20, etag: 'old' });
        expect(h.builds.recordProviderRun).toHaveBeenCalledWith(
            'w1',
            expect.objectContaining({ providerRunId: '1' }),
            'poll',
        );
        expect(h.preparations.upsertAfterPrepare).toHaveBeenCalledWith('w1', {
            runsCheckedAt: new Date(NOW),
            runsEtag: 'new',
        });
        expect(summary).toMatchObject({ worksChecked: 1, runsRecorded: 1, buildsCreated: 1 });
    });

    it('a 304 only stamps runsCheckedAt — no Build writes', async () => {
        const h = harness({ page: { notModified: true, runs: [] } });
        const summary = await h.service.discover(NOW);
        expect(h.builds.recordProviderRun).not.toHaveBeenCalled();
        expect(h.preparations.upsertAfterPrepare).toHaveBeenCalledWith('w1', {
            runsCheckedAt: new Date(NOW),
        });
        expect(summary.worksNotModified).toBe(1);
    });

    it('skips a run created before the workflow was written', async () => {
        const h = harness({
            page: {
                notModified: false,
                runs: [run({ createdAt: new Date(WRITTEN.getTime() - 1).toISOString() })],
            },
        });
        await h.service.discover(NOW);
        expect(h.builds.recordProviderRun).not.toHaveBeenCalled();
    });

    it('does not re-offer a completed run already seen on an earlier tick', async () => {
        const checked = new Date(NOW - 2 * 60_000);
        const h = harness({
            rows: [{ workId: 'w1', runsCheckedAt: checked, workflowWrittenAt: WRITTEN }],
            page: {
                notModified: false,
                runs: [
                    run({
                        providerRunId: 'old',
                        status: 'completed',
                        createdAt: new Date(
                            checked.getTime() - APP_BUILD_DISCOVERY_RECHECK_MARGIN_MS - 1,
                        ).toISOString(),
                    }),
                    run({
                        providerRunId: 'fresh',
                        status: 'completed',
                        createdAt: new Date(NOW - 30_000).toISOString(),
                    }),
                    run({
                        providerRunId: 'open',
                        status: 'running',
                        // Older than the recheck margin, but still open: offered again.
                        createdAt: new Date(
                            checked.getTime() - APP_BUILD_DISCOVERY_RECHECK_MARGIN_MS - 60_000,
                        ).toISOString(),
                    }),
                ],
            },
        });
        await h.service.discover(NOW);
        expect(
            h.builds.recordProviderRun.mock.calls.map(
                (call) => (call[1] as BuildRunRef).providerRunId,
            ),
        ).toEqual(['fresh', 'open']);
    });

    it('skips a plugin without listRecentRuns, and one Work failing does not stop the rest', async () => {
        const none = harness({ binding: { pluginId: 'p' } });
        expect((await none.service.discover(NOW)).worksSkipped).toBe(1);

        const h = harness({
            rows: [
                { workId: 'w1', workflowWrittenAt: WRITTEN },
                { workId: 'w2', workflowWrittenAt: WRITTEN },
            ],
        });
        h.listRecentRuns.mockRejectedValueOnce(new Error('GitHub 502'));
        const summary = await h.service.discover(NOW);
        expect(summary).toMatchObject({ worksChecked: 2, worksFailed: 1, runsRecorded: 1 });
    });
});
