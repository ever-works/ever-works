import type { WorkBuild } from '../../entities/work-build.entity';
import {
    APP_BUILD_VERIFY_SECRET_LOCK_PREFIX,
    AppBuildsService,
    appBuildVerifySecretLockKey,
} from '../app-builds.service';

/**
 * 2026-10-17 (lane aw-builds-3):
 *
 *  1. one per-Work lock serialises everything that writes or deletes the ONE
 *     repository secret `EW_VERIFY__PROMPTED` — `startVerification`, the watch
 *     runner's terminal deletion and the sweep's orphan pass;
 *  2. a Build whose digest is confirmed AFTER it succeeded publishes
 *     `app.build.succeeded` (`deployable: true`) exactly once, so APW-06's
 *     auto-deploy fires.
 */

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const IMAGE = 'ghcr.io/acme/app/ever-works-app';

/** A lock that is free unless `held`, recording every key it was asked for. */
function fakeLock(options: { heldFor?: number } = {}) {
    let held = options.heldFor ?? 0;
    const keys: string[] = [];
    return {
        keys,
        runExclusive: jest.fn(async (key: string, fn: () => Promise<unknown>) => {
            keys.push(key);
            if (held > 0) {
                held -= 1;
                return { acquired: false };
            }
            return { acquired: true, result: await fn() };
        }),
    };
}

function service(options: {
    row?: Partial<WorkBuild> | null;
    openVerifications?: Partial<WorkBuild>[];
    binding?: Record<string, unknown>;
    lock?: ReturnType<typeof fakeLock>;
    claimAffected?: number;
}) {
    const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
    const builds = {
        findPage: jest.fn(async () => ({
            rows: options.openVerifications ?? [],
            total: 0,
            page: 1,
            pageSize: 20,
            hasMore: false,
        })),
    };
    const execute = jest.fn(async () => ({ affected: options.claimAffected ?? 1 }));
    const queryBuilder = {
        update: jest.fn(() => queryBuilder),
        set: jest.fn(() => queryBuilder),
        where: jest.fn(() => queryBuilder),
        andWhere: jest.fn(() => queryBuilder),
        execute,
    };
    const rows = {
        findOne: jest.fn(async () => (options.row ? { ...options.row } : null)),
        merge: jest.fn((row: Record<string, unknown>, patch: Record<string, unknown>) =>
            Object.assign(row, patch),
        ),
        save: jest.fn(async (row: unknown) => row),
        createQueryBuilder: jest.fn(() => queryBuilder),
    };
    const emitter = {
        emit: jest.fn((name: string, event: { payload: Record<string, unknown> }) => {
            emitted.push({ name, payload: event.payload });
        }),
    };
    const activityLog = { log: jest.fn(async () => undefined) };
    const works = {
        read: jest.fn(async () => ({
            workId: WORK_ID,
            userId: 'owner',
            trackedBranch: 'main',
            buildPluginId: 'github-actions-build',
            repositoryFullName: 'acme/app',
            repositoryVisibility: 'private' as const,
        })),
    };
    const specs = {
        read: jest.fn(async () => ({
            spec: { build: { strategy: 'dockerfile' } },
            commitSha: SHA,
            valid: true,
        })),
    };
    const plugins = {
        resolve: jest.fn(
            async () =>
                options.binding ?? {
                    pluginId: 'p',
                    buildKind: 'github-actions',
                    imageRepository: IMAGE,
                },
        ),
    };
    const svc = new AppBuildsService(
        builds as never,
        { findByWork: jest.fn(async () => null) } as never,
        rows as never,
        activityLog as never,
        emitter as never,
        undefined,
        undefined,
        undefined,
        plugins as never,
        works as never,
        specs as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        options.lock as never,
    );
    return { svc, rows, emitted, activityLog, queryBuilder, execute };
}

const VERIFY_ROW: Partial<WorkBuild> = {
    id: 'v1',
    workId: WORK_ID,
    trigger: 'verification',
    status: 'succeeded',
    verifySecretNames: ['EW_VERIFY__PROMPTED'],
};

describe('the per-Work verification-secret lock', () => {
    it('keys on the Work', () => {
        expect(appBuildVerifySecretLockKey(WORK_ID)).toBe(
            `${APP_BUILD_VERIFY_SECRET_LOCK_PREFIX}${WORK_ID}`,
        );
    });

    it('the orphan pass deletes under the lock', async () => {
        const lock = fakeLock();
        const deleteVerifyPromptedSecret = jest.fn(async () => ({ deleted: true }));
        const h = service({
            row: VERIFY_ROW,
            lock,
            binding: {
                pluginId: 'p',
                buildKind: 'github-actions',
                imageRepository: IMAGE,
                deleteVerifyPromptedSecret,
            },
        });
        await expect(h.svc.removeOrphanedVerifySecret('v1')).resolves.toBe(true);
        expect(lock.keys).toEqual([appBuildVerifySecretLockKey(WORK_ID)]);
        expect(deleteVerifyPromptedSecret).toHaveBeenCalledTimes(1);
    });

    it('the orphan pass does nothing while the lock is held (a verification is starting), and retries next tick', async () => {
        const lock = fakeLock({ heldFor: 1 });
        const deleteVerifyPromptedSecret = jest.fn(async () => ({ deleted: true }));
        const h = service({
            row: VERIFY_ROW,
            lock,
            binding: {
                pluginId: 'p',
                buildKind: 'github-actions',
                imageRepository: IMAGE,
                deleteVerifyPromptedSecret,
            },
        });
        await expect(h.svc.removeOrphanedVerifySecret('v1')).resolves.toBe(false);
        expect(deleteVerifyPromptedSecret).not.toHaveBeenCalled();
        expect(h.rows.save).not.toHaveBeenCalled();

        await expect(h.svc.removeOrphanedVerifySecret('v1')).resolves.toBe(true);
        expect(deleteVerifyPromptedSecret).toHaveBeenCalledTimes(1);
    });

    it('a newer open verification owns the secret: only the old record is cleared', async () => {
        const deleteVerifyPromptedSecret = jest.fn(async () => ({ deleted: true }));
        const h = service({
            row: VERIFY_ROW,
            lock: fakeLock(),
            openVerifications: [{ id: 'v2', trigger: 'verification', status: 'running' }],
            binding: {
                pluginId: 'p',
                buildKind: 'github-actions',
                imageRepository: IMAGE,
                deleteVerifyPromptedSecret,
            },
        });
        await expect(h.svc.removeOrphanedVerifySecret('v1')).resolves.toBe(false);
        expect(deleteVerifyPromptedSecret).not.toHaveBeenCalled();
        expect(h.rows.save).toHaveBeenCalledWith(
            expect.objectContaining({ verifySecretNames: [] }),
        );
    });

    it('withVerifySecretLock waits for a short holder when asked to, and runs unlocked with no lock service', async () => {
        const lock = fakeLock({ heldFor: 2 });
        const h = service({ lock });
        const fn = jest.fn(async () => 'ran');
        await expect(h.svc.withVerifySecretLock(WORK_ID, fn, { waitMs: 5_000 })).resolves.toEqual({
            acquired: true,
            result: 'ran',
        });
        expect(lock.runExclusive).toHaveBeenCalledTimes(3);

        const unlocked = service({});
        await expect(unlocked.svc.withVerifySecretLock(WORK_ID, async () => 1)).resolves.toEqual({
            acquired: true,
            result: 1,
        });
    });
});

describe('a late digest confirmation publishes app.build.succeeded exactly once', () => {
    const UNCONFIRMED: Partial<WorkBuild> = {
        id: 'b1',
        number: 7,
        workId: WORK_ID,
        status: 'succeeded',
        trigger: 'push',
        branch: 'main',
        commitSha: SHA,
        imageDigest: DIGEST,
        imageRepository: IMAGE,
        digestConfirmed: false,
        deployable: false,
        notDeployableReason: 'digestUnconfirmed',
        buildInputsHash: null,
        secretCheck: 'passed',
        specValidAtCommit: true,
    };

    function confirmingBinding() {
        return {
            pluginId: 'p',
            buildKind: 'github-actions',
            imageRepository: IMAGE,
            checkImageAccess: jest.fn(async () => ({
                visibility: 'private',
                readable: true,
                digest: DIGEST,
            })),
        };
    }

    it('the call that moves the row out of digestUnconfirmed publishes, with deployable true, and writes no second Activity row', async () => {
        const h = service({ row: UNCONFIRMED, binding: confirmingBinding(), claimAffected: 1 });
        const spy = jest
            .spyOn(h.svc as unknown as { verdictFor: () => unknown }, 'verdictFor')
            .mockResolvedValue({
                verdict: { deployable: true, notDeployableReason: null },
                context: null,
            } as never);

        const result = await h.svc.reconfirmDigest('b1');

        expect(spy).toHaveBeenCalled();
        expect(result).toMatchObject({ reconfirmed: true, deployable: true });
        expect(h.queryBuilder.andWhere).toHaveBeenCalledWith('notDeployableReason = :was', {
            was: 'digestUnconfirmed',
        });
        const succeeded = h.emitted.filter((entry) => entry.name === 'app.build.succeeded');
        expect(succeeded).toHaveLength(1);
        expect(succeeded[0].payload).toMatchObject({
            buildId: 'b1',
            deployable: true,
            notDeployableReason: null,
        });
        expect(h.activityLog.log).not.toHaveBeenCalled();
    });

    it('a racing second re-check (claim lost) publishes nothing', async () => {
        const h = service({ row: UNCONFIRMED, binding: confirmingBinding(), claimAffected: 0 });
        jest.spyOn(
            h.svc as unknown as { verdictFor: () => unknown },
            'verdictFor',
        ).mockResolvedValue({
            verdict: { deployable: true, notDeployableReason: null },
            context: null,
        } as never);

        const result = await h.svc.reconfirmDigest('b1');

        expect(result.reconfirmed).toBe(false);
        expect(h.emitted.filter((entry) => entry.name === 'app.build.succeeded')).toHaveLength(0);
    });

    it('a confirmation that is still not deployable for another reason publishes nothing', async () => {
        const h = service({ row: UNCONFIRMED, binding: confirmingBinding(), claimAffected: 1 });
        jest.spyOn(
            h.svc as unknown as { verdictFor: () => unknown },
            'verdictFor',
        ).mockResolvedValue({
            verdict: { deployable: false, notDeployableReason: 'staleInputs' },
            context: null,
        } as never);

        const result = await h.svc.reconfirmDigest('b1');

        expect(result).toMatchObject({
            reconfirmed: true,
            deployable: false,
            notDeployableReason: 'staleInputs',
        });
        expect(h.emitted).toHaveLength(0);
    });
});
