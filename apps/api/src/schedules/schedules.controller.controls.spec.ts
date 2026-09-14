import 'reflect-metadata';

jest.mock('@ever-works/agent/schedules', () => ({
    SchedulesService: class {},
    ScheduleControlService: class {},
}));
jest.mock('../scope', () => ({
    ScopeContextService: class {},
}));

import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { SchedulesController } from './schedules.controller';
import { ParseScheduleIdPipe } from './pipes/parse-schedule-id.pipe';

/**
 * The three per-schedule controls. The control service owns the behaviour
 * (covered in the agent package); the controller must:
 *
 *  - pass the caller's user + active tenant/Organization, never anything
 *    from the request body;
 *  - validate the id with `ParseScheduleIdPipe`, not `ParseUUIDPipe`;
 *  - surface the service's 404 / 409 unchanged (404, never 403);
 *  - throttle run-now at 10 per minute;
 *  - answer 503 when the control graph is not wired, rather than crash.
 */
const SCHEDULE_ID = 'recurring_task:3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b';
const SCOPE = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
};
const auth = { userId: 'user-1' } as never;

function build(controls?: Record<string, jest.Mock>) {
    const controller = new SchedulesController(
        {} as never,
        { getScope: () => SCOPE, getOrganizationId: () => SCOPE.organizationId } as never,
        controls as never,
    );
    return controller;
}

describe('SchedulesController — run-now / pause / resume', () => {
    const context = { userId: 'user-1', ...SCOPE };

    it('run-now delegates with the caller context and returns the result', async () => {
        const result = { kind: 'run', runIds: ['run-1'], nextRunAt: '2026-09-15T07:00:00.000Z' };
        const controls = { runNow: jest.fn().mockResolvedValue(result) };
        await expect(build(controls).runNow(auth, SCHEDULE_ID)).resolves.toBe(result);
        expect(controls.runNow).toHaveBeenCalledWith(context, SCHEDULE_ID);
    });

    it('run-now on a Mission tick returns the Mission link and no run id', async () => {
        const result = {
            kind: 'mission-tick',
            scheduleId: 'mission_tick:x',
            missionId: 'x',
            ownerLink: '/missions/x',
            outcome: 'spawned',
            ideasCreated: 2,
            ideasQueued: null,
        };
        const controls = { runNow: jest.fn().mockResolvedValue(result) };
        const response = await build(controls).runNow(auth, 'mission_tick:x');
        expect(response).toMatchObject({ kind: 'mission-tick', ownerLink: '/missions/x' });
        expect(response).not.toHaveProperty('runIds');
    });

    it('pause forwards only the boolean acknowledgement', async () => {
        const controls = {
            pause: jest.fn().mockResolvedValue({ id: SCHEDULE_ID, status: 'paused' }),
        };
        const controller = build(controls);
        await controller.pause(auth, SCHEDULE_ID, { acknowledgeMissionPause: true });
        expect(controls.pause).toHaveBeenCalledWith(context, SCHEDULE_ID, {
            acknowledgeMissionPause: true,
        });
        await controller.pause(auth, SCHEDULE_ID, {} as never);
        expect(controls.pause).toHaveBeenLastCalledWith(context, SCHEDULE_ID, {
            acknowledgeMissionPause: false,
        });
    });

    it('resume delegates with the caller context', async () => {
        const controls = {
            resume: jest.fn().mockResolvedValue({ id: SCHEDULE_ID, status: 'active' }),
        };
        await build(controls).resume(auth, SCHEDULE_ID);
        expect(controls.resume).toHaveBeenCalledWith(context, SCHEDULE_ID);
    });

    it('surfaces a 404 for a schedule that is not the caller and every 409 unchanged', async () => {
        const controls = {
            runNow: jest.fn().mockRejectedValue(new NotFoundException('Schedule not found.')),
            pause: jest
                .fn()
                .mockRejectedValue(
                    new ConflictException({ code: 'MISSION_PAUSE_NOT_ACKNOWLEDGED' }),
                ),
            resume: jest.fn().mockRejectedValue(
                new ConflictException({
                    code: 'SCHEDULE_CONTROL_UNAVAILABLE',
                    reasonKey: 'managedOnWork',
                }),
            ),
        };
        const controller = build(controls);
        await expect(controller.runNow(auth, SCHEDULE_ID)).rejects.toBeInstanceOf(
            NotFoundException,
        );
        for (const code of [
            'SCHEDULE_ALREADY_RUNNING',
            'SCHEDULE_NO_AGENT',
            'SCHEDULE_OWNER_ARCHIVED',
        ]) {
            controls.runNow.mockRejectedValueOnce(new ConflictException({ code }));
            const error = await controller.runNow(auth, SCHEDULE_ID).catch((err) => err);
            expect(error.getResponse()).toMatchObject({ code });
        }
        const pauseError = await controller.pause(auth, SCHEDULE_ID, {}).catch((err) => err);
        expect(pauseError.getResponse()).toMatchObject({ code: 'MISSION_PAUSE_NOT_ACKNOWLEDGED' });
        const resumeError = await controller.resume(auth, SCHEDULE_ID).catch((err) => err);
        expect(resumeError.getResponse()).toMatchObject({ reasonKey: 'managedOnWork' });
    });

    it('answers 503 when the controls are not wired', async () => {
        const controller = build(undefined);
        await expect(controller.runNow(auth, SCHEDULE_ID)).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );
        await expect(controller.pause(auth, SCHEDULE_ID, {})).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );
        await expect(controller.resume(auth, SCHEDULE_ID)).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );
    });

    it('validates the :id param with ParseScheduleIdPipe on every control', () => {
        for (const handler of ['runNow', 'pause', 'resume']) {
            const args = Reflect.getMetadata(
                ROUTE_ARGS_METADATA,
                SchedulesController,
                handler,
            ) as Record<string, { data?: string; pipes?: unknown[] }>;
            const idArg = Object.values(args).find((arg) => arg.data === 'id');
            expect(idArg?.pipes).toContain(ParseScheduleIdPipe);
        }
    });

    it('throttles run-now at 10 per minute', () => {
        const handler = SchedulesController.prototype.runNow as unknown as object;
        const keys = Reflect.getMetadataKeys(handler);
        const limitKey = keys.find(
            (key) => String(key).includes('LIMIT') && String(key).includes('long'),
        );
        const ttlKey = keys.find(
            (key) => String(key).includes('TTL') && String(key).includes('long'),
        );
        expect(Reflect.getMetadata(limitKey, handler)).toBe(10);
        expect(Reflect.getMetadata(ttlKey, handler)).toBe(60_000);
    });
});
