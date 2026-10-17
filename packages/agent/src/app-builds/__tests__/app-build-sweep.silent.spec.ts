import { APP_BUILD_POLL_AFTER_SILENCE_MS, APP_BUILD_SWEEP_BATCH } from '@ever-works/contracts';

import { AppBuildSweepService } from '../app-build-sweep.service';

/**
 * APW-05 T21 remainder + T21a — the sweep's discovery pass and silent pass
 * (plan §7.4, §7.4a, ACC-05-11).
 *
 * Without the silent pass a Build observed once after its dispatch was never
 * observed again unless a delivery arrived, so it could not reach `succeeded`
 * and `app.build.succeeded` (what APW-06's auto-deploy listens for) never fired.
 */

const NOW = Date.parse('2026-10-17T12:00:00.000Z');

function harness(options: { silent?: Array<{ id: string }>; discoveryFails?: boolean } = {}) {
    const builds = {
        findUndispatchedRequested: jest.fn(async () => []),
        findNeverAdoptedOpen: jest.fn(async () => []),
        findSilentNonTerminal: jest.fn(async () => options.silent ?? [{ id: 'b1' }, { id: 'b2' }]),
        findWithOrphanedVerifySecrets: jest.fn(async () => [{ id: 'v1' }]),
    };
    const service = {
        requestPrepare: jest.fn(),
        finalize: jest.fn(),
        dispatchWatch: jest.fn(async () => true),
        removeOrphanedVerifySecret: jest.fn(async () => true),
    };
    const discovery = {
        discover: jest.fn(async () => {
            if (options.discoveryFails) throw new Error('GitHub down');
            return { runsRecorded: 3, buildsCreated: 1 };
        }),
    };
    const sweeps = new AppBuildSweepService(
        builds as never,
        service as never,
        undefined,
        undefined,
        discovery as never,
    );
    return { sweeps, builds, service, discovery };
}

describe('AppBuildSweepService — discovery and the silent pass', () => {
    it('runs discovery, then offers every silent open Build a watch (oldest first, batch-capped)', async () => {
        const h = harness();
        const summary = await h.sweeps.sweep(NOW);

        expect(h.discovery.discover).toHaveBeenCalledWith(NOW);
        expect(h.builds.findSilentNonTerminal).toHaveBeenCalledWith(
            NOW,
            APP_BUILD_POLL_AFTER_SILENCE_MS,
            APP_BUILD_SWEEP_BATCH,
        );
        expect(h.service.dispatchWatch.mock.calls).toEqual([
            [{ buildId: 'b1', reason: 'sweep' }],
            [{ buildId: 'b2', reason: 'sweep' }],
        ]);
        expect(summary).toMatchObject({
            discoveryRunsRecorded: 3,
            discoveryBuildsCreated: 1,
            silentDispatched: 2,
            silentFailed: 0,
        });
        // Discovery ran before the silent read (§7.4a: "before the silent-Build pass").
        expect(h.discovery.discover.mock.invocationCallOrder[0]).toBeLessThan(
            h.builds.findSilentNonTerminal.mock.invocationCallOrder[0],
        );
    });

    it('removes orphaned verification secrets (§7.4, 2026-10-17)', async () => {
        const h = harness();
        const summary = await h.sweeps.sweep(NOW);
        expect(h.builds.findWithOrphanedVerifySecrets).toHaveBeenCalledWith(
            NOW,
            APP_BUILD_SWEEP_BATCH,
        );
        expect(h.service.removeOrphanedVerifySecret).toHaveBeenCalledWith('v1');
        expect(summary).toMatchObject({ orphanSecretsRemoved: 1, orphanSecretsFailed: 0 });
    });

    it('a discovery failure never stops the silent pass', async () => {
        const h = harness({ discoveryFails: true });
        const summary = await h.sweeps.sweep(NOW);
        expect(summary.passesFailed).toBeGreaterThanOrEqual(1);
        expect(summary.silentDispatched).toBe(2);
    });

    it('one failing watch offer is counted and the rest still go out', async () => {
        const h = harness();
        h.service.dispatchWatch.mockRejectedValueOnce(new Error('runtime down'));
        const summary = await h.sweeps.sweep(NOW);
        expect(summary).toMatchObject({ silentDispatched: 1, silentFailed: 1 });
    });
});
