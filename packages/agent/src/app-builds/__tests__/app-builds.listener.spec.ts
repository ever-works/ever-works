jest.mock('../../config', () => ({
    config: { everWorks: { apps: { worksEnabled: jest.fn(() => true) } } },
}));

import { config } from '../../config';
import { AppSpecAppliedEvent } from '../../events/app-spec-applied.event';
import { APP_BUILD_ENV_DEBOUNCE_MS, AppBuildsListener } from '../app-builds.listener';

/**
 * APW-05 T22 — `AppBuildsListener` (plan §7.6, `APW05-G15`, ACC-05-13).
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const worksEnabled = (config as unknown as { everWorks: { apps: { worksEnabled: jest.Mock } } })
    .everWorks.apps.worksEnabled;

function harness(buildPluginId: string | null = 'github-actions-build') {
    const builds = { requestPrepare: jest.fn(async () => ({ prepareSeq: 1, dispatched: true })) };
    const preparations = {
        findByWork: jest.fn(async () => (buildPluginId ? { buildPluginId } : null)),
    };
    const listener = new AppBuildsListener(builds as never, preparations as never);
    return { listener, builds, preparations };
}

function applied(overrides: Partial<ConstructorParameters<typeof AppSpecAppliedEvent>[0]> = {}) {
    return new AppSpecAppliedEvent({
        workId: WORK_ID,
        commitSha: 'a'.repeat(40),
        previousCommitSha: null,
        specHash: 'h',
        addedDependencies: [],
        changedEnvNames: [],
        changedBlocks: [],
        ...overrides,
    });
}

describe('AppBuildsListener (APW-05 T22)', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        worksEnabled.mockReturnValue(true);
    });
    afterEach(() => jest.useRealTimers());

    it('prepares on a spec change of the build or checks block (R-9)', async () => {
        const h = harness();
        await h.listener.onSpecApplied(applied({ changedBlocks: ['build'] }));
        await h.listener.onSpecApplied(applied({ changedBlocks: ['checks'] }));
        expect(h.builds.requestPrepare.mock.calls).toEqual([
            [WORK_ID, 'specApplied'],
            [WORK_ID, 'specApplied'],
        ]);
    });

    it('ignores a spec change that touches neither the build nor the env', async () => {
        const h = harness();
        await h.listener.onSpecApplied(applied({ changedBlocks: ['components'] }));
        jest.advanceTimersByTime(APP_BUILD_ENV_DEBOUNCE_MS + 1);
        expect(h.builds.requestPrepare).not.toHaveBeenCalled();
    });

    it('debounces env changes: five inside 10 s dispatch once, 10 s after the first (ACC-05-13)', async () => {
        const h = harness();
        for (let i = 0; i < 5; i += 1) {
            h.listener.onEnvChanged({ workId: WORK_ID, names: [`V${i}`] });
            jest.advanceTimersByTime(1_000);
        }
        expect(h.builds.requestPrepare).not.toHaveBeenCalled();
        jest.advanceTimersByTime(APP_BUILD_ENV_DEBOUNCE_MS);
        expect(h.builds.requestPrepare.mock.calls).toEqual([[WORK_ID, 'envChanged']]);
    });

    it('re-prepares only for build-phase names of APW-07 events (2026-10-17)', async () => {
        const h = harness();
        h.listener.onEnvChanged({
            payload: { workId: WORK_ID, names: ['TZ'], buildPhaseNames: [] },
        });
        jest.advanceTimersByTime(APP_BUILD_ENV_DEBOUNCE_MS + 1);
        expect(h.builds.requestPrepare).not.toHaveBeenCalled();

        h.listener.onEnvChanged({
            payload: { workId: WORK_ID, names: ['SENTRY_DSN'], buildPhaseNames: ['SENTRY_DSN'] },
        });
        jest.advanceTimersByTime(APP_BUILD_ENV_DEBOUNCE_MS + 1);
        expect(h.builds.requestPrepare.mock.calls).toEqual([[WORK_ID, 'envChanged']]);

        // A rotated generated value is a changed value.
        h.listener.onEnvRotated({
            payload: { workId: WORK_ID, names: ['SECRET'], buildPhaseNames: ['SECRET'] },
        });
        jest.advanceTimersByTime(APP_BUILD_ENV_DEBOUNCE_MS + 1);
        expect(h.builds.requestPrepare).toHaveBeenCalledTimes(2);
    });

    it('treats a spec change that only renames env entries as an env change', async () => {
        const h = harness();
        await h.listener.onSpecApplied(
            applied({ changedBlocks: ['env'], changedEnvNames: ['API_KEY'] }),
        );
        jest.advanceTimersByTime(APP_BUILD_ENV_DEBOUNCE_MS + 1);
        expect(h.builds.requestPrepare.mock.calls).toEqual([[WORK_ID, 'envChanged']]);
    });

    it('prepares pullTokenSaved / settingsChanged for the Work build plugin only (APW05-G15)', async () => {
        const h = harness();
        await h.listener.onSettingsChanged({
            pluginId: 'github-actions-build',
            scope: 'work',
            workId: WORK_ID,
            changedKeys: ['pullToken', 'pullTokenExpiresAt'],
            platformManaged: true,
        });
        await h.listener.onSettingsChanged({
            pluginId: 'github-actions-build',
            scope: 'work',
            workId: WORK_ID,
            changedKeys: ['largerRunnerLabel'],
        });
        await h.listener.onSettingsChanged({
            pluginId: 'some-other-plugin',
            scope: 'work',
            workId: WORK_ID,
            changedKeys: ['x'],
        });
        await h.listener.onSettingsChanged({ pluginId: 'github-actions-build', scope: 'user' });
        expect(h.builds.requestPrepare.mock.calls).toEqual([
            [WORK_ID, 'pullTokenSaved'],
            [WORK_ID, 'settingsChanged'],
        ]);
    });

    it('does nothing for a Work never prepared, or with the switch off', async () => {
        const unprepared = harness(null);
        await unprepared.listener.onSettingsChanged({
            pluginId: 'github-actions-build',
            scope: 'work',
            workId: WORK_ID,
            changedKeys: ['reclaimDisk'],
        });
        expect(unprepared.builds.requestPrepare).not.toHaveBeenCalled();

        worksEnabled.mockReturnValue(false);
        const off = harness();
        await off.listener.onSpecApplied(applied({ changedBlocks: ['build'] }));
        expect(off.builds.requestPrepare).not.toHaveBeenCalled();
    });

    it('never throws into the emitter when a prepare request fails', async () => {
        const h = harness();
        h.builds.requestPrepare.mockRejectedValueOnce(new Error('db down'));
        await expect(
            h.listener.onSpecApplied(applied({ changedBlocks: ['build'] })),
        ).resolves.toBeUndefined();
    });
});
