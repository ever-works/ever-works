import { Test, TestingModule } from '@nestjs/testing';
import { DataSyncController } from './data-sync.controller';
import { DataSyncService } from './data-sync.service';
import type { AuthenticatedUser } from '@src/auth/types/authenticated-user.type';
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

    beforeEach(async () => {
        dataSyncService = {
            runDataSync: jest.fn(),
            isLocked: jest.fn(),
        } as unknown as jest.Mocked<DataSyncService>;

        const module: TestingModule = await Test.createTestingModule({
            controllers: [DataSyncController],
            providers: [{ provide: DataSyncService, useValue: dataSyncService }],
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
                errorClass: 'GitPushRejected',
                errorTail: 'fatal: non-fast-forward',
            });

            const result = await controller.forceSync(stubUser, 'work-failed');

            expect(result).toEqual({
                status: 'failed',
                errorClass: 'GitPushRejected',
                errorTail: 'fatal: non-fast-forward',
            });
        });
    });

    describe('forceSync — surfaces service errors', () => {
        it('rethrows when runDataSync rejects (NestJS exception filter handles the HTTP response)', async () => {
            const boom = new Error('internal boom');
            dataSyncService.runDataSync.mockRejectedValueOnce(boom);

            await expect(controller.forceSync(stubUser, 'work-boom')).rejects.toBe(boom);
        });
    });
});
