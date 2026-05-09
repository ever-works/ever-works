// Stub the transitive dependencies BEFORE importing the SUT so we don't
// pull in `p-map` (ESM-only) via the data-generator → work-schedule chain.
// We only consume these as DI tokens; the runtime behaviour is fully
// substituted by hand-built mocks in beforeEach().
jest.mock('../work-schedule.service', () => ({
    WorkScheduleService: class WorkScheduleService {},
}));
jest.mock('../item-health.service', () => ({
    ItemHealthService: class ItemHealthService {},
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ItemSourceValidationSchedulerService } from '../item-source-validation-scheduler.service';
import type { Work } from '@src/entities/work.entity';
import type { User } from '@src/entities/user.entity';
import type { UpdateSourceValidationDto } from '@src/dto/update-source-validation.dto';
import type { WorkScheduleAllowedCadence } from '@ever-works/contracts/api';

describe('ItemSourceValidationSchedulerService', () => {
    let workRepository: {
        findDueSourceValidation: jest.Mock;
        findById: jest.Mock;
        update: jest.Mock;
        updateSourceValidationRun: jest.Mock;
    };
    let scheduleService: {
        calculateNextRun: jest.Mock;
    };
    let itemHealthService: {
        runScheduledCheck: jest.Mock;
    };
    let service: ItemSourceValidationSchedulerService;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
        workRepository = {
            findDueSourceValidation: jest.fn(),
            findById: jest.fn(),
            update: jest.fn().mockResolvedValue(undefined),
            updateSourceValidationRun: jest.fn().mockResolvedValue(undefined),
        };
        scheduleService = {
            calculateNextRun: jest.fn(),
        };
        itemHealthService = {
            runScheduledCheck: jest.fn(),
        };
        service = new ItemSourceValidationSchedulerService(
            workRepository as any,
            scheduleService as any,
            itemHealthService as any,
        );
        // Silence the error channel; reassert via the spy in error-path tests.
        errorSpy = jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        errorSpy.mockRestore();
        jest.clearAllMocks();
    });

    const buildWork = (overrides: Partial<Work> = {}): Work =>
        ({
            id: 'work-1',
            user: { id: 'user-1' } as User,
            sourceValidationEnabled: true,
            sourceValidationCadence: 'daily' as any,
            sourceValidationNextRunAt: null,
            sourceValidationLastRunAt: null,
            ...overrides,
        }) as unknown as Work;

    describe('processDueSchedules', () => {
        it('forwards the documented LIMIT=50 cap to findDueSourceValidation (pinned regression guard)', async () => {
            // The LIMIT is a private constant on the service; pinning the
            // call ensures a future widening to per-tier paging is a
            // deliberate change rather than an accidental one.
            workRepository.findDueSourceValidation.mockResolvedValue([]);

            await service.processDueSchedules();

            expect(workRepository.findDueSourceValidation).toHaveBeenCalledWith(50);
            expect(workRepository.findDueSourceValidation).toHaveBeenCalledTimes(1);
        });

        it('returns the all-zero envelope when no work is due', async () => {
            workRepository.findDueSourceValidation.mockResolvedValue([]);

            const result = await service.processDueSchedules();

            expect(result).toEqual({
                processed: 0,
                skipped: 0,
                itemsChecked: 0,
                itemsChanged: 0,
                errors: [],
            });
            expect(itemHealthService.runScheduledCheck).not.toHaveBeenCalled();
            expect(workRepository.updateSourceValidationRun).not.toHaveBeenCalled();
        });

        it('skips a work when user relation is missing (without invoking the health check)', async () => {
            const work = buildWork({ user: undefined as any });
            workRepository.findDueSourceValidation.mockResolvedValue([work]);

            const result = await service.processDueSchedules();

            expect(result.skipped).toBe(1);
            expect(result.processed).toBe(0);
            expect(itemHealthService.runScheduledCheck).not.toHaveBeenCalled();
            expect(workRepository.updateSourceValidationRun).not.toHaveBeenCalled();
        });

        it('skips a work when sourceValidationCadence is missing', async () => {
            // Pinned: an enabled work with no cadence is a configuration
            // bug, but the scheduler must NOT crash — it should skip and
            // continue. The next-run timestamp is computed from the cadence,
            // so without one we cannot reschedule.
            const work = buildWork({ sourceValidationCadence: null as any });
            workRepository.findDueSourceValidation.mockResolvedValue([work]);

            const result = await service.processDueSchedules();

            expect(result.skipped).toBe(1);
            expect(itemHealthService.runScheduledCheck).not.toHaveBeenCalled();
        });

        it('skips a work when both user and cadence are missing (no double-counting)', async () => {
            const work = buildWork({
                user: undefined as any,
                sourceValidationCadence: null as any,
            });
            workRepository.findDueSourceValidation.mockResolvedValue([work]);

            const result = await service.processDueSchedules();

            expect(result.skipped).toBe(1);
        });

        it('processes a happy-path work: runs check, computes next run, updates schedule, aggregates counts', async () => {
            const work = buildWork({
                id: 'work-happy',
                sourceValidationCadence: 'weekly' as any,
            });
            const nextRun = new Date('2026-06-01T00:00:00Z');
            workRepository.findDueSourceValidation.mockResolvedValue([work]);
            itemHealthService.runScheduledCheck.mockResolvedValue({
                checkedCount: 7,
                changedCount: 2,
            });
            scheduleService.calculateNextRun.mockReturnValue(nextRun);

            const result = await service.processDueSchedules();

            expect(itemHealthService.runScheduledCheck).toHaveBeenCalledWith(work, work.user);
            expect(scheduleService.calculateNextRun).toHaveBeenCalledWith(
                'weekly',
                0,
                expect.any(Date),
            );
            expect(workRepository.updateSourceValidationRun).toHaveBeenCalledWith(
                'work-happy',
                nextRun,
            );
            expect(result).toEqual({
                processed: 1,
                skipped: 0,
                itemsChecked: 7,
                itemsChanged: 2,
                errors: [],
            });
        });

        it('passes 0 as the failure-count argument and a fresh Date as the from-time argument', async () => {
            // Pinned: the scheduler treats every successful run as a "fresh
            // start" with zero accumulated failures, which is what the
            // backoff math expects. A future "carry over failures" change
            // would flip this and would be a deliberate decision.
            const work = buildWork();
            workRepository.findDueSourceValidation.mockResolvedValue([work]);
            itemHealthService.runScheduledCheck.mockResolvedValue({
                checkedCount: 0,
                changedCount: 0,
            });
            scheduleService.calculateNextRun.mockReturnValue(new Date());
            const before = Date.now();

            await service.processDueSchedules();

            const after = Date.now();
            const callArgs = scheduleService.calculateNextRun.mock.calls[0];
            expect(callArgs[1]).toBe(0);
            const fromTime = callArgs[2] as Date;
            expect(fromTime).toBeInstanceOf(Date);
            expect(fromTime.getTime()).toBeGreaterThanOrEqual(before);
            expect(fromTime.getTime()).toBeLessThanOrEqual(after);
        });

        it('captures Error.message into the errors array AND logs error.stack', async () => {
            const work = buildWork({ id: 'work-err' });
            const err = new Error('boom');
            workRepository.findDueSourceValidation.mockResolvedValue([work]);
            itemHealthService.runScheduledCheck.mockRejectedValue(err);

            const result = await service.processDueSchedules();

            expect(result.errors).toEqual([{ workId: 'work-err', message: 'boom' }]);
            expect(result.processed).toBe(0);
            expect(workRepository.updateSourceValidationRun).not.toHaveBeenCalled();
            expect(errorSpy).toHaveBeenCalledWith(
                'Source validation failed for work work-err',
                err.stack,
            );
        });

        it('coerces non-Error rejections via String() and passes undefined for stack', async () => {
            // Pinned because `error instanceof Error` is the only branch
            // that yields a stack — non-Error rejections (string / object /
            // primitive) MUST not crash and must surface a string message.
            const work = buildWork({ id: 'work-str-err' });
            workRepository.findDueSourceValidation.mockResolvedValue([work]);
            itemHealthService.runScheduledCheck.mockRejectedValue('plain-string');

            const result = await service.processDueSchedules();

            expect(result.errors).toEqual([{ workId: 'work-str-err', message: 'plain-string' }]);
            expect(errorSpy).toHaveBeenCalledWith(
                'Source validation failed for work work-str-err',
                undefined,
            );
        });

        it('continues processing remaining works after an error in one (errors do not short-circuit)', async () => {
            const w1 = buildWork({ id: 'w-1' });
            const w2 = buildWork({ id: 'w-2' });
            const w3 = buildWork({ id: 'w-3' });
            workRepository.findDueSourceValidation.mockResolvedValue([w1, w2, w3]);
            itemHealthService.runScheduledCheck
                .mockResolvedValueOnce({ checkedCount: 1, changedCount: 0 })
                .mockRejectedValueOnce(new Error('mid-failure'))
                .mockResolvedValueOnce({ checkedCount: 3, changedCount: 1 });
            scheduleService.calculateNextRun.mockReturnValue(new Date());

            const result = await service.processDueSchedules();

            expect(result.processed).toBe(2);
            expect(result.itemsChecked).toBe(4);
            expect(result.itemsChanged).toBe(1);
            expect(result.errors).toEqual([{ workId: 'w-2', message: 'mid-failure' }]);
            // Only the two successes should reschedule.
            expect(workRepository.updateSourceValidationRun).toHaveBeenCalledTimes(2);
        });

        it('aggregates checkedCount and changedCount across multiple works', async () => {
            const w1 = buildWork({ id: 'w-1' });
            const w2 = buildWork({ id: 'w-2' });
            workRepository.findDueSourceValidation.mockResolvedValue([w1, w2]);
            itemHealthService.runScheduledCheck
                .mockResolvedValueOnce({ checkedCount: 5, changedCount: 1 })
                .mockResolvedValueOnce({ checkedCount: 4, changedCount: 3 });
            scheduleService.calculateNextRun.mockReturnValue(new Date());

            const result = await service.processDueSchedules();

            expect(result).toEqual({
                processed: 2,
                skipped: 0,
                itemsChecked: 9,
                itemsChanged: 4,
                errors: [],
            });
        });

        it('skipping does NOT touch updateSourceValidationRun OR calculateNextRun', async () => {
            const skipped = buildWork({ id: 'skip', user: undefined as any });
            workRepository.findDueSourceValidation.mockResolvedValue([skipped]);

            await service.processDueSchedules();

            expect(scheduleService.calculateNextRun).not.toHaveBeenCalled();
            expect(workRepository.updateSourceValidationRun).not.toHaveBeenCalled();
        });
    });

    describe('getSettings', () => {
        const allowedCadences: WorkScheduleAllowedCadence[] = [
            { cadence: 'daily', allowed: true, payPerUse: false },
            { cadence: 'weekly', allowed: true, payPerUse: false },
        ] as any;

        it('throws NotFoundException with the workId interpolated when work missing', async () => {
            workRepository.findById.mockResolvedValue(null);

            await expect(service.getSettings('missing-id', allowedCadences)).rejects.toThrow(
                NotFoundException,
            );
            await expect(service.getSettings('missing-id', allowedCadences)).rejects.toThrow(
                'Work missing-id not found',
            );
        });

        it('maps the populated row verbatim with ISO 8601 timestamps via Date.toISOString()', async () => {
            const work = buildWork({
                sourceValidationEnabled: true,
                sourceValidationCadence: 'daily' as any,
                sourceValidationNextRunAt: new Date('2026-06-01T00:00:00Z'),
                sourceValidationLastRunAt: new Date('2026-05-30T12:00:00Z'),
            });
            workRepository.findById.mockResolvedValue(work);

            const result = await service.getSettings('work-1', allowedCadences);

            expect(result).toEqual({
                enabled: true,
                cadence: 'daily',
                nextRunAt: '2026-06-01T00:00:00.000Z',
                lastRunAt: '2026-05-30T12:00:00.000Z',
                allowedCadences,
            });
        });

        it('coerces missing cadence/nextRunAt/lastRunAt to null (?? null short-circuit)', async () => {
            // Pinned: the optional-chain `?.toISOString()` short-circuits
            // to undefined when the Date is null, then `?? null` coerces
            // undefined to null. A future swap to `||` would also coerce
            // the empty-string ISO output but that is not currently a risk.
            const work = buildWork({
                sourceValidationEnabled: false,
                sourceValidationCadence: null as any,
                sourceValidationNextRunAt: null,
                sourceValidationLastRunAt: null,
            });
            workRepository.findById.mockResolvedValue(work);

            const result = await service.getSettings('work-1', allowedCadences);

            expect(result).toEqual({
                enabled: false,
                cadence: null,
                nextRunAt: null,
                lastRunAt: null,
                allowedCadences,
            });
        });

        it('forwards the allowedCadences array verbatim (no defensive copy)', async () => {
            const work = buildWork();
            workRepository.findById.mockResolvedValue(work);

            const result = await service.getSettings('work-1', allowedCadences);

            expect(result.allowedCadences).toBe(allowedCadences);
        });

        it('passes empty allowedCadences through verbatim', async () => {
            const work = buildWork();
            workRepository.findById.mockResolvedValue(work);

            const result = await service.getSettings('work-1', [] as any);

            expect(result.allowedCadences).toEqual([]);
        });
    });

    describe('updateSettings', () => {
        const dailyAllowed: WorkScheduleAllowedCadence[] = [
            { cadence: 'daily', allowed: true, payPerUse: false },
        ] as any;

        it('throws NotFoundException when work missing (no allowedCadences check, no update)', async () => {
            workRepository.findById.mockResolvedValue(null);

            await expect(
                service.updateSettings(
                    'missing',
                    { enabled: true, cadence: 'daily' } as UpdateSourceValidationDto,
                    dailyAllowed,
                ),
            ).rejects.toThrow(NotFoundException);
            expect(workRepository.update).not.toHaveBeenCalled();
            expect(scheduleService.calculateNextRun).not.toHaveBeenCalled();
        });

        it('falls back to the work-stored cadence when dto cadence is undefined', async () => {
            // Pinned: `dto.cadence ?? work.sourceValidationCadence ?? null`
            // — caller-not-changing-cadence preserves the stored value.
            const work = buildWork({ sourceValidationCadence: 'weekly' as any });
            workRepository.findById.mockResolvedValue(work);
            scheduleService.calculateNextRun.mockReturnValue(new Date('2026-07-01T00:00:00Z'));

            const dto: UpdateSourceValidationDto = { enabled: true } as any;
            const allowed: WorkScheduleAllowedCadence[] = [
                { cadence: 'weekly', allowed: true, payPerUse: false },
            ] as any;

            const result = await service.updateSettings('work-1', dto, allowed);

            expect(result.cadence).toBe('weekly');
            expect(workRepository.update).toHaveBeenCalledWith(work.id, {
                sourceValidationEnabled: true,
                sourceValidationCadence: 'weekly',
                sourceValidationNextRunAt: new Date('2026-07-01T00:00:00Z'),
            });
        });

        it('coerces missing cadence on both dto AND work to null', async () => {
            const work = buildWork({ sourceValidationCadence: null as any });
            workRepository.findById.mockResolvedValue(work);

            const result = await service.updateSettings(
                'work-1',
                { enabled: false } as any,
                [] as any,
            );

            expect(result.cadence).toBeNull();
            expect(scheduleService.calculateNextRun).not.toHaveBeenCalled();
            expect(workRepository.update).toHaveBeenCalledWith(work.id, {
                sourceValidationEnabled: false,
                sourceValidationCadence: null,
                sourceValidationNextRunAt: null,
            });
        });

        it('throws BadRequestException when cadence is set AND not in non-empty allowedCadences', async () => {
            const work = buildWork();
            workRepository.findById.mockResolvedValue(work);

            await expect(
                service.updateSettings(
                    'work-1',
                    { enabled: true, cadence: 'hourly' } as any,
                    dailyAllowed,
                ),
            ).rejects.toThrow(BadRequestException);
            await expect(
                service.updateSettings(
                    'work-1',
                    { enabled: true, cadence: 'hourly' } as any,
                    dailyAllowed,
                ),
            ).rejects.toThrow("Cadence 'hourly' is not allowed by your subscription plan");
            expect(workRepository.update).not.toHaveBeenCalled();
        });

        it('SKIPS the allowedCadences gate when allowedCadences is empty (kill-switch off)', async () => {
            // Pinned: an empty allowedCadences[] is the "subscriptions
            // disabled / unbounded" signal — every cadence passes through.
            // A future refactor that treated empty-array as "nothing
            // allowed" would break the off-by-default flow.
            const work = buildWork();
            workRepository.findById.mockResolvedValue(work);
            scheduleService.calculateNextRun.mockReturnValue(new Date());

            await expect(
                service.updateSettings(
                    'work-1',
                    { enabled: true, cadence: 'hourly' } as any,
                    [] as any,
                ),
            ).resolves.toBeDefined();
            expect(workRepository.update).toHaveBeenCalled();
        });

        it('SKIPS the allowedCadences gate when cadence resolves to null', async () => {
            // Pinned: the gate is `cadence && allowedCadences.length > 0 &&
            // !some(...)` — short-circuits on falsy cadence so a "disable"
            // call does not require any cadence to be allowed.
            const work = buildWork({ sourceValidationCadence: null as any });
            workRepository.findById.mockResolvedValue(work);

            const result = await service.updateSettings(
                'work-1',
                { enabled: false } as any,
                dailyAllowed,
            );

            expect(result.cadence).toBeNull();
            expect(workRepository.update).toHaveBeenCalled();
        });

        it('passes the allow-check when cadence matches one of the allowed entries', async () => {
            const work = buildWork();
            workRepository.findById.mockResolvedValue(work);
            scheduleService.calculateNextRun.mockReturnValue(new Date('2026-06-01T00:00:00Z'));

            const result = await service.updateSettings(
                'work-1',
                { enabled: true, cadence: 'daily' } as any,
                dailyAllowed,
            );

            expect(result.cadence).toBe('daily');
            expect(workRepository.update).toHaveBeenCalled();
        });

        it('persists nextRunAt = null when enabled is false (does NOT call calculateNextRun)', async () => {
            // Pinned: the `dto.enabled && cadence` guard is short-circuit-on-
            // disabled — disabling the schedule must NOT compute a new
            // next-run because the row should be dormant until re-enabled.
            const work = buildWork();
            workRepository.findById.mockResolvedValue(work);

            const result = await service.updateSettings(
                'work-1',
                { enabled: false, cadence: 'daily' } as any,
                dailyAllowed,
            );

            expect(scheduleService.calculateNextRun).not.toHaveBeenCalled();
            expect(result.nextRunAt).toBeNull();
            expect(workRepository.update).toHaveBeenCalledWith(work.id, {
                sourceValidationEnabled: false,
                sourceValidationCadence: 'daily',
                sourceValidationNextRunAt: null,
            });
        });

        it('persists nextRunAt = null when cadence resolves to null (regardless of enabled flag)', async () => {
            const work = buildWork({ sourceValidationCadence: null as any });
            workRepository.findById.mockResolvedValue(work);

            const result = await service.updateSettings(
                'work-1',
                { enabled: true } as any,
                [] as any,
            );

            expect(scheduleService.calculateNextRun).not.toHaveBeenCalled();
            expect(result.nextRunAt).toBeNull();
        });

        it('computes nextRunAt via scheduleService when enabled+cadence both set, with NO failure-count or from-date arg', async () => {
            // Pinned: in the update path the scheduler is called with ONE
            // arg only — there is no carry-over of failures, no override
            // of the from-time. A future widening to `(cadence, 0, now)`
            // (matching the processDueSchedules signature) would be a
            // deliberate change.
            const work = buildWork();
            workRepository.findById.mockResolvedValue(work);
            const nextRun = new Date('2026-06-15T08:00:00Z');
            scheduleService.calculateNextRun.mockReturnValue(nextRun);

            const result = await service.updateSettings(
                'work-1',
                { enabled: true, cadence: 'daily' } as any,
                dailyAllowed,
            );

            expect(scheduleService.calculateNextRun).toHaveBeenCalledWith('daily');
            expect(scheduleService.calculateNextRun.mock.calls[0]).toHaveLength(1);
            expect(result.nextRunAt).toBe('2026-06-15T08:00:00.000Z');
        });

        it('preserves the work-stored lastRunAt in the response (does NOT touch lastRunAt on the row)', async () => {
            // Pinned: lastRunAt is owned by the run path, not the settings
            // path — updating settings must NOT erase the historical run
            // marker. Asserted via two checks: response carries the ISO
            // string AND `update()` is called WITHOUT a sourceValidationLastRunAt
            // key in the payload.
            const work = buildWork({
                sourceValidationLastRunAt: new Date('2026-04-01T00:00:00Z'),
            });
            workRepository.findById.mockResolvedValue(work);
            scheduleService.calculateNextRun.mockReturnValue(new Date());

            const result = await service.updateSettings(
                'work-1',
                { enabled: true, cadence: 'daily' } as any,
                dailyAllowed,
            );

            expect(result.lastRunAt).toBe('2026-04-01T00:00:00.000Z');
            const updatePayload = workRepository.update.mock.calls[0][1];
            expect(updatePayload).not.toHaveProperty('sourceValidationLastRunAt');
        });

        it('returns the dto.enabled value verbatim in the response (NOT the stored value)', async () => {
            const work = buildWork({ sourceValidationEnabled: false });
            workRepository.findById.mockResolvedValue(work);
            scheduleService.calculateNextRun.mockReturnValue(new Date());

            const result = await service.updateSettings(
                'work-1',
                { enabled: true, cadence: 'daily' } as any,
                dailyAllowed,
            );

            expect(result.enabled).toBe(true);
        });

        it('forwards the same allowedCadences array reference to the response (no defensive copy)', async () => {
            const work = buildWork();
            workRepository.findById.mockResolvedValue(work);
            scheduleService.calculateNextRun.mockReturnValue(new Date());

            const result = await service.updateSettings(
                'work-1',
                { enabled: true, cadence: 'daily' } as any,
                dailyAllowed,
            );

            expect(result.allowedCadences).toBe(dailyAllowed);
        });
    });
});
