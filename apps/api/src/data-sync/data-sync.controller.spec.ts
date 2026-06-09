// `DataSyncService` (imported transitively via the controller) reaches
// into `@ever-works/agent/{activity-log,generators,database,config}`
// whose barrels use the agent-side `@src/...` alias. The API jest
// config rewrites that alias to a non-existent directory, so we stub
// the barrels here just like the unit specs do.
jest.mock('@ever-works/agent/activity-log', () => ({
    ActivityLogService: class ActivityLogService {},
}));
jest.mock('@ever-works/agent/generators', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
}));
// `WorkRepository` is no longer a controller dependency — the per-Work
// access gate now delegates to `WorkOwnershipService`. The class shell
// stays only because `DataSyncService` (imported transitively as the DI
// token) reaches into `@ever-works/agent/database` at module scope.
jest.mock('@ever-works/agent/database', () => ({
    WorkRepository: class WorkRepository {},
}));
// `WorkOwnershipService` shell for the controller's access-check
// dependency. The spec replaces this with a jest mock instance in
// beforeEach so the controller can call `ensureCanEdit` without touching
// a real database or membership table.
jest.mock('@ever-works/agent/services', () => ({
    WorkOwnershipService: class WorkOwnershipService {
        ensureCanEdit = jest.fn();
    },
}));
jest.mock('@ever-works/agent/config', () => ({
    config: {
        subscriptions: {
            dataSync: {
                getLockTtlSeconds: () => 300,
                getRetryBackoffSeconds: () => 300,
                getGenInProgressNoiseWindowMs: () => 900_000,
            },
        },
    },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { DataSyncController } from './data-sync.controller';
import { DataSyncService } from './data-sync.service';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';
import type { DataSyncOutcome, DataSyncSuccessStats } from './data-sync.types';

/**
 * EW-628 Phase 6 — pin the public response envelope and the
 * service-delegation shape of {@link DataSyncController}.
 *
 * The controller is intentionally thin; almost all the contract lives
 * inside {@link DataSyncService.runDataSync} (Phase 3 follow-up). These
 * tests guard the parts the controller owns:
 *
 *   - Always delegates with source='manual' (operator-driven, distinct
 *     from 'webhook' / 'poll' for activity-feed attribution).
 *   - Auth presence is asserted by the global guard upstream — the
 *     controller doesn't double-check, so a missing user shouldn't
 *     short-circuit before delegation. Verified by passing a stub user.
 *   - shapeOutcome() returns a stable discriminated union the frontend
 *     can switch on without re-narrowing.
 *
 * Full Supertest integration tests live as a Phase 6 follow-up once
 * runDataSync returns real outcomes from the gate body.
 */
const stubUser: AuthenticatedUser = { userId: 'user-42' } as unknown as AuthenticatedUser;

describe('DataSyncController (EW-628 Phase 6)', () => {
    let controller: DataSyncController;
    let dataSyncService: jest.Mocked<DataSyncService>;
    let ownershipService: jest.Mocked<WorkOwnershipService>;

    beforeEach(async () => {
        dataSyncService = {
            runDataSync: jest.fn(),
            isLocked: jest.fn(),
        } as unknown as jest.Mocked<DataSyncService>;

        // Default: the stub caller passes the edit-access gate so tests
        // that don't care about authz don't trip it. Tests that DO care
        // override the mock to reject (stranger probe). `ensureCanEdit`
        // resolves with a WorkAccessResult in the real service; the
        // controller ignores the return value, so a bare resolve is
        // enough here.
        ownershipService = {
            ensureCanEdit: jest.fn().mockResolvedValue({ isCreator: true }),
        } as unknown as jest.Mocked<WorkOwnershipService>;

        const module: TestingModule = await Test.createTestingModule({
            controllers: [DataSyncController],
            providers: [
                { provide: DataSyncService, useValue: dataSyncService },
                { provide: WorkOwnershipService, useValue: ownershipService },
            ],
        }).compile();

        controller = module.get(DataSyncController);
    });

    describe('forceSync — delegation contract', () => {
        it('always invokes runDataSync(workId, "manual") regardless of caller', async () => {
            const stats: DataSyncSuccessStats = { filesChanged: 3, durationMs: 412 };
            dataSyncService.runDataSync.mockResolvedValue({ status: 'success', stats });

            await controller.forceSync(stubUser, 'work-abc');

            expect(dataSyncService.runDataSync).toHaveBeenCalledTimes(1);
            expect(dataSyncService.runDataSync).toHaveBeenCalledWith('work-abc', 'manual');
        });

        it('passes through the work id verbatim (no normalisation in the controller)', async () => {
            dataSyncService.runDataSync.mockResolvedValue({
                status: 'success',
                stats: { filesChanged: 0, durationMs: 1 },
            });

            await controller.forceSync(stubUser, '  Whitespace-And-Caps  ');

            expect(dataSyncService.runDataSync).toHaveBeenCalledWith(
                '  Whitespace-And-Caps  ',
                'manual',
            );
        });
    });

    describe('forceSync — access gate (WorkOwnershipService)', () => {
        it('gates on ensureCanEdit(workId, callerId) before delegating', async () => {
            dataSyncService.runDataSync.mockResolvedValue({
                status: 'success',
                stats: { filesChanged: 0, durationMs: 1 },
            });

            await controller.forceSync(stubUser, 'work-gate');

            expect(ownershipService.ensureCanEdit).toHaveBeenCalledTimes(1);
            expect(ownershipService.ensureCanEdit).toHaveBeenCalledWith(
                'work-gate',
                stubUser.userId,
            );
        });

        it('rejects a caller without edit access and never reaches runDataSync', async () => {
            // ensureCanEdit throws ForbiddenException (403) for a member
            // below EDITOR / a non-member, and NotFoundException (404)
            // for a missing Work. Either way the controller must not
            // delegate, so a stranger never learns the Work exists.
            const forbidden = new (require('@nestjs/common').ForbiddenException)(
                'You do not have permission to access this work',
            );
            ownershipService.ensureCanEdit.mockRejectedValueOnce(forbidden);

            await expect(controller.forceSync(stubUser, 'work-stranger')).rejects.toBe(forbidden);
            expect(dataSyncService.runDataSync).not.toHaveBeenCalled();
        });

        it('propagates the 404 contract when the Work does not exist', async () => {
            const notFound = new (require('@nestjs/common').NotFoundException)(
                "Work with id 'missing' not found",
            );
            ownershipService.ensureCanEdit.mockRejectedValueOnce(notFound);

            await expect(controller.forceSync(stubUser, 'missing')).rejects.toMatchObject({
                status: 404,
            });
            expect(dataSyncService.runDataSync).not.toHaveBeenCalled();
        });
    });

    describe('forceSync — response envelope', () => {
        it('maps success outcome to { status: "enqueued", outcome: "success", stats }', async () => {
            const stats: DataSyncSuccessStats = {
                beforeSha: 'aaaa111',
                afterSha: 'bbbb222',
                filesChanged: 5,
                durationMs: 1234,
            };
            dataSyncService.runDataSync.mockResolvedValue({ status: 'success', stats });

            const result = await controller.forceSync(stubUser, 'work-success');

            expect(result).toEqual({
                status: 'enqueued',
                outcome: 'success',
                stats,
            });
        });

        const skipReasons = [
            'retry-backoff',
            'sync-in-progress',
            'generation-in-progress',
            'no-changes',
            'app-not-installed-and-no-credentials',
        ] as const;
        it.each(skipReasons)(
            'maps skipped outcome (reason=%s) to { status: "skipped", reason }',
            async (reason) => {
                dataSyncService.runDataSync.mockResolvedValue({
                    status: 'skipped',
                    reason,
                } as DataSyncOutcome);

                const result = await controller.forceSync(stubUser, 'work-skipped');

                expect(result).toEqual({ status: 'skipped', reason });
            },
        );

        it('maps failed outcome to { status: "failed", errorClass, errorTail }', async () => {
            dataSyncService.runDataSync.mockResolvedValue({
                status: 'failed',
                errorClass: 'main-repo-push-rejected',
                errorTail: 'fatal: non-fast-forward',
            });

            const result = await controller.forceSync(stubUser, 'work-failed');

            expect(result).toEqual({
                status: 'failed',
                errorClass: 'main-repo-push-rejected',
                errorTail: 'fatal: non-fast-forward',
            });
        });
    });

    describe('forceSync — surfaces service errors', () => {
        it('converts plain Error rejections to NotFoundException (keeps response 4xx)', async () => {
            // Until DataSyncService has its own ownership / not-implemented
            // guard, the controller maps plain-Error throws to 404 so the
            // manual escape valve never leaks a 5xx for a stranger probe
            // or a half-wired service stub.
            const boom = new Error('internal boom');
            dataSyncService.runDataSync.mockRejectedValueOnce(boom);

            await expect(controller.forceSync(stubUser, 'work-boom')).rejects.toMatchObject({
                status: 404,
            });
        });

        it('rethrows HttpException subclasses verbatim (NestJS exception filter handles HTTP mapping)', async () => {
            const httpErr = new (require('@nestjs/common').ForbiddenException)('stranger');
            dataSyncService.runDataSync.mockRejectedValueOnce(httpErr);

            await expect(controller.forceSync(stubUser, 'work-forbidden')).rejects.toBe(httpErr);
        });
    });
});
