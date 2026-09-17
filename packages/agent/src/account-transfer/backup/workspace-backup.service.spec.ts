import { ActivityActionType } from '../../entities/activity-log.types';
import {
    WorkspaceBackupAlreadyActiveError,
    type WorkspaceBackupRepository,
    type WorkspaceBackupScope,
} from '../../database/repositories/workspace-backup.repository';
import type { BackupStorage } from './backup-storage';
import {
    WorkspaceBackupService,
    type BackupActivityRecorder,
    type BackupNotifier,
} from './workspace-backup.service';

/**
 * These are the four promises the backup card makes that have to hold
 * however they are reached — from a button, a second tab, a worker or the
 * sweeper. Everything else about a backup is recoverable; these are not.
 */

const SCOPE: WorkspaceBackupScope = { userId: 'u1', organizationId: 'org-1', tenantId: 't1' };

function row(overrides: Record<string, unknown> = {}) {
    return {
        id: 'b1',
        userId: 'u1',
        organizationId: 'org-1',
        status: 'ready',
        includeFullHistory: false,
        requestedAt: new Date('2026-09-06T10:00:00.000Z'),
        sizeBytes: 1024,
        storageKey: 'u1/archive.zip',
        ...overrides,
    } as never;
}

function build(
    options: {
        active?: unknown;
        readyInWindow?: number;
        createThrows?: Error;
        dispatchReturns?: string | null;
        withStorage?: boolean;
        listRows?: unknown[];
        oldestReady?: Date | null;
    } = {},
) {
    const repository = {
        findActive: jest.fn().mockResolvedValue(options.active ?? null),
        findInScope: jest.fn().mockImplementation(async (_scope, id: string) => row({ id })),
        findLatest: jest.fn().mockResolvedValue(null),
        listForScope: jest
            .fn()
            .mockResolvedValue({ rows: options.listRows ?? [], nextCursor: null }),
        countReadyInWindow: jest.fn().mockResolvedValue(options.readyInWindow ?? 0),
        // The allowance count and the retry time are now answered over the
        // same filtered set, so the double carries both.
        oldestReadyInWindow: jest.fn().mockResolvedValue(options.oldestReady ?? null),
        createQueued: jest.fn().mockImplementation(async () => {
            if (options.createThrows) throw options.createThrows;
            return row({ id: 'new-1', status: 'queued' });
        }),
        attachRuntimeRun: jest.fn().mockResolvedValue(undefined),
        markTerminal: jest.fn().mockResolvedValue(true),
        requestCancel: jest.fn().mockResolvedValue(true),
        recordDownload: jest.fn().mockResolvedValue(undefined),
        findExpirable: jest.fn().mockResolvedValue([]),
        findStalled: jest.fn().mockResolvedValue([]),
        findOverdue: jest.fn().mockResolvedValue([]),
        findPrunable: jest.fn().mockResolvedValue([]),
        deleteByIds: jest.fn().mockResolvedValue(0),
    };

    const storage = {
        warmUp: jest.fn().mockResolvedValue(undefined),
        supportsStreaming: jest.fn().mockReturnValue(true),
        backendName: jest.fn().mockReturnValue('fixture-backend'),
        putArchive: jest.fn(),
        getArchiveStream: jest.fn(),
        readObject: jest.fn(),
        deleteArchive: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<BackupStorage>;

    const dispatcher = {
        dispatchWorkspaceBackup: jest
            .fn()
            .mockResolvedValue(
                options.dispatchReturns === undefined ? 'run-1' : options.dispatchReturns,
            ),
    };
    const activity: jest.Mocked<BackupActivityRecorder> = {
        log: jest.fn().mockResolvedValue(undefined),
    };
    const notifier: jest.Mocked<BackupNotifier> = {
        create: jest.fn().mockResolvedValue(undefined),
    };

    const service = new WorkspaceBackupService(
        repository as unknown as WorkspaceBackupRepository,
        options.withStorage === false ? undefined : storage,
        dispatcher,
        activity,
        notifier,
    );

    return { service, repository, storage, dispatcher, activity, notifier };
}

describe('WorkspaceBackupService — one at a time (spec FR-3, S-9)', () => {
    it('adopts the running backup instead of starting a second', async () => {
        const running = row({ id: 'running-1', status: 'running' });
        const { service, repository } = build({ active: running });

        const outcome = await service.create(SCOPE);
        expect(outcome).toEqual({ kind: 'adopted', backup: running });
        expect(repository.createQueued).not.toHaveBeenCalled();
    });

    it('adopts the row the database refused to duplicate, rather than throwing at the owner', async () => {
        // Two tabs racing: the partial unique index rejects the second
        // insert, and the second tab shows the first tab's backup.
        const { service, repository } = build({
            createThrows: new WorkspaceBackupAlreadyActiveError(),
        });
        repository.findActive
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(row({ id: 'running-1', status: 'running' }));

        const outcome = await service.create(SCOPE);
        expect(outcome.kind).toBe('adopted');
    });

    it('lets a real insert failure through rather than swallowing it as a race', async () => {
        const { service } = build({ createThrows: new Error('database is on fire') });
        await expect(service.create(SCOPE)).rejects.toThrow('database is on fire');
    });
});

describe('WorkspaceBackupService — the daily allowance (spec FR-4, S-10)', () => {
    it('refuses the fourth ready backup in a day and says when the window reopens', async () => {
        const oldest = new Date(Date.now() - 13 * 60 * 60 * 1000);
        const { service, repository } = build({
            readyInWindow: 3,
            oldestReady: oldest,
            listRows: [
                row({ id: 'b1', requestedAt: new Date(Date.now() - 60 * 60 * 1000) }),
                row({ id: 'b2', requestedAt: new Date(Date.now() - 30 * 60 * 1000) }),
            ],
        });

        const outcome = await service.create(SCOPE);
        expect(outcome.kind).toBe('rate_limited');
        if (outcome.kind !== 'rate_limited') throw new Error('unreachable');
        expect(outcome.limit).toBe(3);
        // One day after the OLDEST ready outcome still inside the window.
        expect(outcome.retryAt.getTime()).toBeGreaterThan(Date.now());
        // And EXACTLY that, not merely later than now: the number is shown
        // to the owner as "try again at", so a value that is only
        // directionally right is a wrong answer with a plausible shape.
        expect(outcome.retryAt.getTime()).toBe(oldest.getTime() + 24 * 60 * 60 * 1000);
        expect(repository.createQueued).not.toHaveBeenCalled();
    });

    it('measures the retry time over the same rows the refusal counted', async () => {
        // The defect: the count came from a filtered SQL query and the retry
        // time came from a page of the newest six rows of ANY status.
        // Cancelled and failed attempts do not charge the allowance and
        // nothing stops an owner accumulating them, so four of them between
        // the oldest ready backup and the newer ones pushed it off that page
        // and the answer was computed from a later row — a wait reported as
        // hours longer than it is.
        const oldest = new Date(Date.now() - 23 * 60 * 60 * 1000);
        const { service, repository } = build({
            readyInWindow: 3,
            oldestReady: oldest,
            // A history page that does NOT contain the oldest ready row.
            // Deriving the answer from this is what produced the wrong one.
            listRows: [
                row({ id: 'c1', status: 'cancelled', requestedAt: new Date(Date.now() - 6e4) }),
                row({ id: 'c2', status: 'cancelled', requestedAt: new Date(Date.now() - 12e4) }),
                row({ id: 'c3', status: 'failed', requestedAt: new Date(Date.now() - 18e4) }),
                row({ id: 'c4', status: 'failed', requestedAt: new Date(Date.now() - 24e4) }),
                row({ id: 'b3', requestedAt: new Date(Date.now() - 60 * 60 * 1000) }),
                row({ id: 'b2', requestedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }),
            ],
        });

        const outcome = await service.create(SCOPE);
        if (outcome.kind !== 'rate_limited') throw new Error('expected a rate-limited outcome');

        expect(outcome.retryAt.getTime()).toBe(oldest.getTime() + 24 * 60 * 60 * 1000);
        // Asked over the window, not over a page of history.
        expect(repository.oldestReadyInWindow).toHaveBeenCalledWith(SCOPE, expect.any(Date));
    });

    it('falls back to a full day only when nothing is in the window at all', async () => {
        const { service } = build({ readyInWindow: 3, oldestReady: null });
        const before = Date.now();

        const outcome = await service.create(SCOPE);
        if (outcome.kind !== 'rate_limited') throw new Error('expected a rate-limited outcome');

        expect(outcome.retryAt.getTime()).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
    });

    it('counts only outcomes that produced something — failures cost nothing', async () => {
        const { service, repository } = build({ readyInWindow: 2 });
        const outcome = await service.create(SCOPE);

        expect(outcome.kind).toBe('started');
        // The repository is asked for READY outcomes specifically; failed
        // and cancelled attempts never reach this count (spec S-14, S-23).
        expect(repository.countReadyInWindow).toHaveBeenCalledWith(SCOPE, expect.any(Date));
    });
});

describe('WorkspaceBackupService — create', () => {
    it('dispatches through the job runtime and records the handle', async () => {
        const { service, dispatcher, repository } = build();
        await service.create(SCOPE, { includeFullHistory: true });

        expect(dispatcher.dispatchWorkspaceBackup).toHaveBeenCalledWith(
            expect.objectContaining({ backupId: 'new-1', userId: 'u1', organizationId: 'org-1' }),
        );
        expect(repository.attachRuntimeRun).toHaveBeenCalledWith('new-1', 'run-1');
    });

    it('fails the row at once when nothing can enqueue it, rather than queuing it forever', async () => {
        const { service, repository } = build({ dispatchReturns: null });
        await service.create(SCOPE);

        expect(repository.markTerminal).toHaveBeenCalledWith(
            'new-1',
            expect.objectContaining({ status: 'failed', failureReason: 'internal' }),
        );
    });

    it('refuses to offer a backup at all with no storage configured (spec S-26)', async () => {
        const { service, repository } = build({ withStorage: false });
        expect(await service.create(SCOPE)).toEqual({ kind: 'unavailable' });
        expect(repository.createQueued).not.toHaveBeenCalled();
    });

    it('writes exactly one activity entry when a backup starts (spec FR-32)', async () => {
        const { service, activity } = build();
        await service.create(SCOPE);

        expect(activity.log).toHaveBeenCalledTimes(1);
        expect(activity.log).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'u1',
                actionType: ActivityActionType.WORKSPACE_BACKUP_CREATED,
            }),
        );
    });

    it('does not fail a backup because its audit trail failed', async () => {
        const { service, activity } = build();
        activity.log.mockRejectedValue(new Error('activity log down'));
        await expect(service.create(SCOPE)).resolves.toMatchObject({ kind: 'started' });
    });
});

describe('WorkspaceBackupService — cancel and delete', () => {
    it('cancels through a compare-and-set, never a blind write', async () => {
        const { service, repository } = build();
        expect(await service.cancel(SCOPE, 'b1')).toBe(true);
        expect(repository.requestCancel).toHaveBeenCalledWith('b1', expect.any(Date));
    });

    it('refuses to cancel a backup in another workspace', async () => {
        const { service, repository } = build();
        repository.findInScope.mockResolvedValue(null);
        expect(await service.cancel(SCOPE, 'someone-elses')).toBe(false);
        expect(repository.requestCancel).not.toHaveBeenCalled();
    });

    it('deletes the bytes, keeps the row, and records it (spec FR-31, S-24)', async () => {
        const { service, repository, storage, activity } = build();
        expect(await service.deleteArtifact(SCOPE, 'b1')).toBe(true);

        expect(storage.deleteArchive).toHaveBeenCalledWith('u1/archive.zip');
        expect(repository.markTerminal).toHaveBeenCalledWith(
            'b1',
            expect.objectContaining({ status: 'deleted', storageKey: null }),
            ['ready', 'ready_with_gaps', 'expired'],
        );
        expect(activity.log).toHaveBeenCalledWith(
            expect.objectContaining({ actionType: ActivityActionType.WORKSPACE_BACKUP_DELETED }),
        );
    });

    it('still moves the row when the bytes could not be removed, so no Download is offered for them', async () => {
        const { service, repository, storage } = build();
        storage.deleteArchive.mockRejectedValue(new Error('bucket unreachable'));

        expect(await service.deleteArtifact(SCOPE, 'b1')).toBe(true);
        expect(repository.markTerminal).toHaveBeenCalled();
    });
});

describe('WorkspaceBackupService — download links (spec FR-12, S-15)', () => {
    const otherScope: WorkspaceBackupScope = {
        userId: 'u2',
        organizationId: 'org-1',
        tenantId: 't1',
    };
    const otherOrg: WorkspaceBackupScope = {
        userId: 'u1',
        organizationId: 'org-2',
        tenantId: 't1',
    };

    beforeEach(() => {
        process.env.BACKUP_DOWNLOAD_SECRET = 'a-test-signing-key';
    });
    afterEach(() => {
        delete process.env.BACKUP_DOWNLOAD_SECRET;
    });

    it('accepts a freshly minted token for the backup it was minted for', () => {
        const { service } = build();
        const { token, expiresAt } = service.mintDownloadToken(SCOPE, 'b1');

        expect(service.verifyDownloadToken(SCOPE, 'b1', token)).toBe(true);
        expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('refuses a token minted for a different backup', () => {
        const { service } = build();
        const { token } = service.mintDownloadToken(SCOPE, 'b1');
        expect(service.verifyDownloadToken(SCOPE, 'b2', token)).toBe(false);
    });

    it('refuses a token minted for a different account', () => {
        const { service } = build();
        const { token } = service.mintDownloadToken(SCOPE, 'b1');
        expect(service.verifyDownloadToken(otherScope, 'b1', token)).toBe(false);
    });

    it('refuses a token minted in a different workspace of the same account', () => {
        const { service } = build();
        const { token } = service.mintDownloadToken(SCOPE, 'b1');
        expect(service.verifyDownloadToken(otherOrg, 'b1', token)).toBe(false);
    });

    it('refuses an expired token, so a link left in a browser history stops working', () => {
        const { service } = build();
        const past = Date.now() - 1000;
        const { token } = service.mintDownloadToken(SCOPE, 'b1');
        const forged = `${past}.${token.slice(token.indexOf('.') + 1)}`;
        expect(service.verifyDownloadToken(SCOPE, 'b1', forged)).toBe(false);
    });

    it('refuses garbage without throwing', () => {
        const { service } = build();
        for (const token of ['', '.', 'abc', 'notanumber.signature']) {
            expect(service.verifyDownloadToken(SCOPE, 'b1', token)).toBe(false);
        }
    });

    it('records one activity entry per download (spec FR-32)', async () => {
        const { service, repository, activity } = build();
        await service.recordDownload(SCOPE, row() as never);

        expect(repository.recordDownload).toHaveBeenCalledWith('b1', expect.any(Date));
        expect(activity.log).toHaveBeenCalledWith(
            expect.objectContaining({ actionType: ActivityActionType.WORKSPACE_BACKUP_DOWNLOADED }),
        );
    });
});

describe('WorkspaceBackupService — one notification per finished backup (spec FR-33)', () => {
    it('raises exactly one on a clean finish', async () => {
        const { service, notifier } = build();
        await service.notifyFinished(row({ status: 'ready', manifestSummary: null }) as never);

        expect(notifier.create).toHaveBeenCalledTimes(1);
        expect(notifier.create).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'Your workspace backup is ready' }),
        );
    });

    it('says so when things were left out', async () => {
        const { service, notifier } = build();
        await service.notifyFinished(
            row({
                status: 'ready_with_gaps',
                manifestSummary: { domains: [], files: { included: 1, bytes: 1, omitted: 37 } },
            }) as never,
        );

        expect(notifier.create).toHaveBeenCalledWith(
            expect.objectContaining({ title: expect.stringContaining('left out') }),
        );
    });

    it('says so when a backup did not finish', async () => {
        const { service, notifier } = build();
        await service.notifyFinished(row({ status: 'failed', failureReason: 'stalled' }) as never);

        expect(notifier.create).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'Your workspace backup did not finish' }),
        );
    });

    it('stays silent for a backup that is still running', async () => {
        const { service, notifier } = build();
        await service.notifyFinished(row({ status: 'running' }) as never);
        expect(notifier.create).not.toHaveBeenCalled();
    });
});

describe('WorkspaceBackupService — observeRun, what the archive task watches', () => {
    // The task no longer holds an RPC open for the whole archive; it starts
    // the run and asks this, every few seconds, until the row settles. Each
    // look also ends a run that can no longer end itself.
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000);

    function watching(current: Record<string, unknown>, after?: Record<string, unknown>) {
        const built = build();
        let settled = false;
        built.repository.findInScope.mockImplementation(async (_scope, id: string) =>
            row({ id, ...(settled && after ? after : current) }),
        );
        built.repository.markTerminal.mockImplementation(async () => {
            settled = true;
            return true;
        });
        return built;
    }

    it('hands back a settled row untouched', async () => {
        const { service, repository } = watching({ status: 'ready' });
        const observed = (await service.observeRun(SCOPE, 'b1')) as unknown as { status: string };

        expect(observed.status).toBe('ready');
        expect(repository.markTerminal).not.toHaveBeenCalled();
    });

    it('leaves a running backup that is still reporting alone', async () => {
        const { service, repository } = watching({
            status: 'running',
            startedAt: minutesAgo(20),
            lastHeartbeatAt: minutesAgo(1),
        });
        const observed = (await service.observeRun(SCOPE, 'b1')) as unknown as { status: string };

        expect(observed.status).toBe('running');
        expect(repository.markTerminal).not.toHaveBeenCalled();
    });

    it('fails a running backup that stopped reporting, with the sweeper’s own rule (spec FR-5)', async () => {
        const { service, repository } = watching(
            { status: 'running', startedAt: minutesAgo(30), lastHeartbeatAt: minutesAgo(11) },
            { status: 'failed', failureReason: 'stalled' },
        );
        const observed = (await service.observeRun(SCOPE, 'b1')) as unknown as {
            status: string;
            failureReason: string;
        };

        expect(repository.markTerminal).toHaveBeenCalledWith(
            'b1',
            expect.objectContaining({ status: 'failed', failureReason: 'stalled' }),
        );
        expect(observed).toEqual(
            expect.objectContaining({ status: 'failed', failureReason: 'stalled' }),
        );
    });

    it('stops a backup that ran past the hour and says timeout (spec FR-6)', async () => {
        const { service, repository } = watching(
            { status: 'running', startedAt: minutesAgo(61), lastHeartbeatAt: minutesAgo(0) },
            { status: 'failed', failureReason: 'timeout' },
        );
        await service.observeRun(SCOPE, 'b1');

        expect(repository.markTerminal).toHaveBeenCalledWith(
            'b1',
            expect.objectContaining({ status: 'failed', failureReason: 'timeout' }),
            ['running'],
        );
    });

    it('stops a backup when its watcher cannot wait any longer', async () => {
        const { service, repository } = watching({
            status: 'running',
            startedAt: minutesAgo(58),
            lastHeartbeatAt: minutesAgo(0),
        });
        await service.observeRun(SCOPE, 'b1', { stop: 'timeout' });

        expect(repository.markTerminal).toHaveBeenCalledWith(
            'b1',
            expect.objectContaining({ status: 'failed', failureReason: 'timeout' }),
            ['running'],
        );
    });

    it('never overwrites an outcome that landed first — the stop is a compare-and-set', async () => {
        const { service, repository } = watching({
            status: 'running',
            startedAt: minutesAgo(61),
            lastHeartbeatAt: minutesAgo(0),
        });
        repository.markTerminal.mockResolvedValue(false);

        const observed = (await service.observeRun(SCOPE, 'b1')) as unknown as { status: string };
        // Nothing moved, so the next look reads whatever did settle it.
        expect(observed.status).toBe('running');
        expect(repository.markTerminal.mock.calls[0][2]).toEqual(['running']);
    });

    it('fails a backup that was never picked up, like the sweeper does', async () => {
        const { service, repository } = watching({
            status: 'queued',
            requestedAt: minutesAgo(16),
        });
        await service.observeRun(SCOPE, 'b1');

        expect(repository.markTerminal).toHaveBeenCalledWith(
            'b1',
            expect.objectContaining({ status: 'failed', failureReason: 'stalled' }),
        );
    });

    it('answers null for a backup outside this workspace', async () => {
        const { service, repository } = build();
        repository.findInScope.mockResolvedValue(null);

        await expect(service.observeRun(SCOPE, 'elsewhere')).resolves.toBeNull();
        expect(repository.markTerminal).not.toHaveBeenCalled();
    });
});

describe('WorkspaceBackupService — the sweeper passes', () => {
    it('deletes the bytes of an expired archive and keeps the row (spec FR-28, S-16)', async () => {
        const { service, repository, storage } = build();
        repository.findExpirable.mockResolvedValue([row({ id: 'old-1' })]);

        expect(await service.expireDueArchives(new Date())).toBe(1);
        expect(storage.deleteArchive).toHaveBeenCalledWith('u1/archive.zip');
        expect(repository.markTerminal).toHaveBeenCalledWith(
            'old-1',
            expect.objectContaining({ status: 'expired', storageKey: null }),
            ['ready', 'ready_with_gaps'],
        );
    });

    it('fails a stalled backup and removes whatever it left behind (spec FR-5, S-14)', async () => {
        const { service, repository, storage } = build();
        repository.findStalled.mockResolvedValue([row({ id: 'stuck-1', status: 'running' })]);

        expect(await service.failStalledBackups(new Date())).toBe(1);
        expect(storage.deleteArchive).toHaveBeenCalled();
        expect(repository.markTerminal).toHaveBeenCalledWith(
            'stuck-1',
            expect.objectContaining({ status: 'failed', failureReason: 'stalled' }),
        );
    });

    it('fails a backup still running past the hour, however recently it heartbeat (spec FR-6)', async () => {
        // The stall rule only sees silence. A run that keeps heartbeating
        // past its ceiling — its own deadline missed, the job runtime's
        // `maxDuration` not applied — used to stay `running` for as long as
        // it went on, with `create()` adopting it every time the owner asked
        // for a new one. Driven through `runSweep`, the cron's one call.
        const { service, repository } = build();
        const now = new Date('2026-09-17T12:00:00.000Z');
        repository.findOverdue.mockResolvedValue([
            row({
                id: 'long-1',
                status: 'running',
                startedAt: new Date('2026-09-17T10:30:00.000Z'),
                lastHeartbeatAt: new Date('2026-09-17T11:59:50.000Z'),
            }),
        ]);

        const summary = await service.runSweep(now);

        expect(repository.findOverdue).toHaveBeenCalledWith(
            new Date('2026-09-17T11:00:00.000Z'),
            200,
        );
        expect(repository.markTerminal).toHaveBeenCalledWith(
            'long-1',
            expect.objectContaining({ status: 'failed', failureReason: 'timeout', finishedAt: now }),
            // A compare-and-set out of `running`: an archive that settled a
            // moment earlier keeps its own outcome.
            ['running'],
        );
        expect(summary).toMatchObject({ timedOut: 1 });
    });

    it('counts only the overdue runs it actually moved', async () => {
        const { service, repository } = build();
        repository.findOverdue.mockResolvedValue([row({ id: 'long-1', status: 'running' })]);
        repository.markTerminal.mockResolvedValue(false);

        await expect(service.runSweep(new Date())).resolves.toMatchObject({ timedOut: 0 });
        expect(repository.markTerminal).toHaveBeenCalledTimes(1);
    });

    it('prunes records whose bytes went long ago (spec FR-29)', async () => {
        const { service, repository } = build();
        repository.findPrunable.mockResolvedValue([row({ id: 'ancient-1' })]);
        repository.deleteByIds.mockResolvedValue(1);

        expect(await service.pruneOldRecords(new Date())).toBe(1);
        expect(repository.deleteByIds).toHaveBeenCalledWith(['ancient-1']);
    });

    describe('runSweep — the hourly cron’s single call', () => {
        // The cron used to take the three locks itself, from the Trigger
        // worker, which cannot construct `DistributedTaskLockService` at all:
        // it injects `@InjectRepository(CacheEntry)` and the worker process
        // has no DataSource. So the cron died before any pass ran — retention
        // was never enforced, and because `create()` adopts an active row an
        // owner whose worker died could never start another backup.
        function locked() {
            return {
                runExclusive: jest
                    .fn()
                    .mockImplementation(async (_key: string, pass: () => Promise<number>) => ({
                        acquired: true,
                        result: await pass(),
                    })),
            };
        }

        function withLocks(locks: { runExclusive: jest.Mock } | undefined) {
            const { service, repository, storage } = build();
            const composed = new WorkspaceBackupService(
                repository as unknown as WorkspaceBackupRepository,
                storage,
                undefined,
                undefined,
                undefined,
                undefined,
                locks as never,
            );
            void service;
            return { service: composed, repository, storage };
        }

        it('runs every pass and reports what each one did', async () => {
            const locks = locked();
            const { service, repository } = withLocks(locks);
            repository.findExpirable.mockResolvedValue([row({ id: 'old-1' })]);
            repository.findOverdue.mockResolvedValue([row({ id: 'long-1', status: 'running' })]);
            repository.findStalled.mockResolvedValue([row({ id: 'stuck-1', status: 'running' })]);
            repository.findPrunable.mockResolvedValue([row({ id: 'ancient-1' })]);
            repository.deleteByIds.mockResolvedValue(1);

            await expect(service.runSweep(new Date())).resolves.toEqual({
                expired: 1,
                timedOut: 1,
                stalled: 1,
                pruned: 1,
            });
        });

        it('takes one lock per pass, so two replicas cannot both delete', async () => {
            const locks = locked();
            const { service } = withLocks(locks);

            await service.runSweep(new Date());

            expect(locks.runExclusive.mock.calls.map((call) => call[0])).toEqual([
                'workspace-backup:expire',
                'workspace-backup:timeouts',
                'workspace-backup:stalls',
                'workspace-backup:prune',
            ]);
        });

        it('reports zero for a pass whose lock another replica holds', async () => {
            const locks = {
                runExclusive: jest.fn().mockResolvedValue({ acquired: false }),
            };
            const { service, repository } = withLocks(locks);
            repository.findExpirable.mockResolvedValue([row({ id: 'old-1' })]);

            await expect(service.runSweep(new Date())).resolves.toEqual({
                expired: 0,
                timedOut: 0,
                stalled: 0,
                pruned: 0,
            });
            expect(repository.findExpirable).not.toHaveBeenCalled();
        });

        it('still sweeps with no lock service bound, because every pass is idempotent', async () => {
            const { service, repository } = withLocks(undefined);
            repository.findExpirable.mockResolvedValue([row({ id: 'old-1' })]);

            await expect(service.runSweep(new Date())).resolves.toMatchObject({ expired: 1 });
        });
    });
});

describe('WorkspaceBackupService — the values in force (spec FR-47)', () => {
    afterEach(() => {
        delete process.env.BACKUP_RETENTION_DAYS;
        delete process.env.BACKUP_DAILY_ALLOWANCE;
    });

    it('reports the shipped defaults when the operator has changed nothing', () => {
        const { service } = build();
        expect(service.limits()).toMatchObject({
            retentionDays: 14,
            recordRetentionDays: 90,
            dailyAllowance: 3,
            domainCount: 15,
        });
    });

    it('reads what the operator actually configured, so the card cannot promise the default', () => {
        process.env.BACKUP_RETENTION_DAYS = '30';
        process.env.BACKUP_DAILY_ALLOWANCE = '10';
        const { service } = build();

        expect(service.limits()).toMatchObject({ retentionDays: 30, dailyAllowance: 10 });
    });

    it('ignores a nonsense value rather than shipping a zero-day retention', () => {
        process.env.BACKUP_RETENTION_DAYS = 'soon';
        const { service } = build();
        expect(service.limits().retentionDays).toBe(14);
    });
});
