import { WorkAppSpecStateRepository } from '../../database/repositories/work-app-spec-state.repository';
import {
    APP_BLUEPRINT_NOTICES_PER_RUN,
    APP_BLUEPRINT_RUN_EVENTS,
    AppBlueprintUpgradeService,
} from '../app-blueprint-upgrade.service';
import { AppsCatalogCredentialUnavailableError } from '../app-blueprint-resolver.service';

/**
 * APW-03 T30 (lane aw-blueprints) — the "a new Blueprint version is out" fan-out
 * (ACC-03-22, upgrade half): `blueprintLatestVersion` set and ONE
 * `app.blueprint.upgrade_available` row per (Work, version), the 500-per-run cap, the
 * Breaking flag of a MAJOR bump, and one unreadable Blueprint never stopping the rest.
 */

interface Row {
    workId: string;
    blueprintId: string;
    blueprintVersion: string;
    blueprintLatestVersion: string | null;
}

function statesFake(rows: Row[]) {
    return {
        rows,
        listFollowedBlueprintIds: jest.fn(async () =>
            [...new Set(rows.map((row) => row.blueprintId))].sort(),
        ),
        findUpgradeCandidates: jest.fn(async (id: string, version: string, limit: number) =>
            rows
                .filter((row) => row.blueprintId === id && row.blueprintVersion !== version)
                .slice(0, limit),
        ),
        markUpgradeAvailable: jest.fn(async (workId: string, version: string) => {
            const row = rows.find((candidate) => candidate.workId === workId)!;
            if (row.blueprintLatestVersion === version) return false;
            row.blueprintLatestVersion = version;
            return true;
        }),
    };
}

function build(rows: Row[], latest: Record<string, string | Error | null>) {
    const states = statesFake(rows);
    const resolver = {
        readBlueprintRelease: jest.fn(async (id: string) => {
            const answer = latest[id];
            if (answer instanceof Error) throw answer;
            return answer
                ? {
                      hit: { id, version: answer, repo: `ever-works/${id}-template` },
                      text: '',
                      ref: 'x',
                      sha: null,
                  }
                : null;
        }),
    };
    const works = { findById: jest.fn(async (id: string) => ({ id, userId: `owner-of-${id}` })) };
    const activity = { log: jest.fn(async (_entry: Record<string, unknown>) => ({ id: 'a' })) };
    const moduleRef = {
        get: (token: unknown) => {
            if (token === WorkAppSpecStateRepository) return states;
            throw new Error('unknown');
        },
    };
    const service = new AppBlueprintUpgradeService(
        resolver as never,
        works as never,
        undefined,
        activity as never,
        undefined,
        undefined,
        moduleRef as never,
    );
    return { service, states, resolver, activity };
}

describe('APW-03 T30 — refreshUpgradeNotices', () => {
    it('marks every Work behind the latest release once, and writes one notice each', async () => {
        const rows: Row[] = [
            {
                workId: 'w1',
                blueprintId: 'umami',
                blueprintVersion: '0.1.0',
                blueprintLatestVersion: null,
            },
            {
                workId: 'w2',
                blueprintId: 'umami',
                blueprintVersion: '0.2.0',
                blueprintLatestVersion: null,
            },
            {
                workId: 'w3',
                blueprintId: 'cal',
                blueprintVersion: '1.4.0',
                blueprintLatestVersion: null,
            },
        ];
        const { service, activity } = build(rows, { umami: '0.2.0', cal: '2.0.0' });

        await expect(service.refreshUpgradeNotices()).resolves.toEqual({
            blueprints: 2,
            scanned: 2,
            notices: 2,
        });
        expect(rows.map((row) => row.blueprintLatestVersion)).toEqual(['0.2.0', null, '2.0.0']);

        const entries = activity.log.mock.calls.map(([entry]) => entry);
        expect(entries).toEqual([
            expect.objectContaining({
                workId: 'w3',
                userId: 'owner-of-w3',
                action: APP_BLUEPRINT_RUN_EVENTS.upgradeAvailable,
                actionType: 'app_blueprint',
                details: {
                    blueprintId: 'cal',
                    version: '2.0.0',
                    fromVersion: '1.4.0',
                    breaking: true,
                },
            }),
            expect.objectContaining({
                workId: 'w1',
                details: {
                    blueprintId: 'umami',
                    version: '0.2.0',
                    fromVersion: '0.1.0',
                    breaking: false,
                },
            }),
        ]);

        // A second run for the same versions records nothing new.
        activity.log.mockClear();
        await expect(service.refreshUpgradeNotices()).resolves.toMatchObject({ notices: 0 });
        expect(activity.log).not.toHaveBeenCalled();
    });

    it('never offers a version older than the applied one', async () => {
        const rows: Row[] = [
            {
                workId: 'w1',
                blueprintId: 'umami',
                blueprintVersion: '0.3.0',
                blueprintLatestVersion: null,
            },
        ];
        const { service, activity } = build(rows, { umami: '0.2.0' });
        await expect(service.refreshUpgradeNotices()).resolves.toMatchObject({
            notices: 0,
            scanned: 1,
        });
        expect(rows[0].blueprintLatestVersion).toBeNull();
        expect(activity.log).not.toHaveBeenCalled();
    });

    it('keeps going past a Blueprint that cannot be read', async () => {
        const rows: Row[] = [
            {
                workId: 'w1',
                blueprintId: 'aaa',
                blueprintVersion: '0.1.0',
                blueprintLatestVersion: null,
            },
            {
                workId: 'w2',
                blueprintId: 'bbb',
                blueprintVersion: '0.1.0',
                blueprintLatestVersion: null,
            },
        ];
        const { service } = build(rows, { aaa: new Error('boom'), bbb: '0.2.0' });
        await expect(service.refreshUpgradeNotices()).resolves.toMatchObject({
            blueprints: 1,
            notices: 1,
        });
        expect(rows[1].blueprintLatestVersion).toBe('0.2.0');
    });

    it('stops the run when no platform credential can read any Blueprint', async () => {
        const rows: Row[] = [
            {
                workId: 'w1',
                blueprintId: 'umami',
                blueprintVersion: '0.1.0',
                blueprintLatestVersion: null,
            },
        ];
        const { service, states } = build(rows, {
            umami: new AppsCatalogCredentialUnavailableError(),
        });
        await expect(service.refreshUpgradeNotices()).resolves.toEqual({
            blueprints: 0,
            scanned: 0,
            notices: 0,
        });
        expect(states.markUpgradeAvailable).not.toHaveBeenCalled();
    });

    it('caps the notices of one run (plan: at most 500), the rest wait for the next', async () => {
        const rows: Row[] = Array.from({ length: 5 }, (_, index) => ({
            workId: `w${index}`,
            blueprintId: 'umami',
            blueprintVersion: '0.1.0',
            blueprintLatestVersion: null,
        }));
        const { service } = build(rows, { umami: '0.2.0' });
        await expect(service.refreshUpgradeNotices({ limit: 2 })).resolves.toMatchObject({
            notices: 2,
        });
        expect(rows.filter((row) => row.blueprintLatestVersion === '0.2.0')).toHaveLength(2);
        await expect(service.refreshUpgradeNotices({ limit: 2 })).resolves.toMatchObject({
            notices: 2,
        });
        expect(APP_BLUEPRINT_NOTICES_PER_RUN).toBe(500);
    });

    it('reads public Blueprints only — no Work owner is in scope for the fan-out', async () => {
        const rows: Row[] = [
            {
                workId: 'w1',
                blueprintId: 'umami',
                blueprintVersion: '0.1.0',
                blueprintLatestVersion: null,
            },
        ];
        const { service, resolver } = build(rows, { umami: '0.2.0' });
        await service.refreshUpgradeNotices();
        expect(resolver.readBlueprintRelease).toHaveBeenCalledWith('umami', { sourceOwner: null });
    });
});
