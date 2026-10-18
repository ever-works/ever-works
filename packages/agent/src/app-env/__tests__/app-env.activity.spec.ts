import { UnknownElementException } from '@nestjs/core/errors/exceptions/unknown-element.exception';
import { ActivityLogService } from '../../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../../entities/activity-log.types';
import { AppEnvActivityService } from '../app-env.activity';
import type { AppEnvActivityEvent } from '../app-env.service';

/**
 * APW-07 T26 (lane aw-env-smtp) — `AppEnvActivityService`, the writer behind `APP_ENV_ACTIVITY`:
 * one row per event, `actionType: app_env`, the dotted event in `action`, names and verbs only.
 */
describe('AppEnvActivityService', () => {
    const WORK = '5a07fa3f-367a-444e-9d1e-311d03cc1327';

    function writer(log?: jest.Mock) {
        const ref = {
            get: jest.fn((token: unknown) => {
                if (token === ActivityLogService && log) return { log };
                // What `ModuleRef.get` really throws for a provider the container does not have.
                throw new UnknownElementException('ActivityLogService');
            }),
        };
        return new AppEnvActivityService(ref as never);
    }

    const event: AppEnvActivityEvent = {
        actionType: 'app_env',
        action: 'app.env.changed',
        status: 'completed',
        summary: 'Environment values set (2)',
        details: { names: ['FIXTURE_MARKER', 'FIXTURE_MAIL_TO'], actions: ['set'] },
        workId: WORK,
        userId: 'u-1',
    };

    it('writes one app_env row with the names and verbs, under the Work and the actor', async () => {
        const log = jest.fn().mockResolvedValue({});
        await writer(log).emit(event);

        expect(log).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith({
            userId: 'u-1',
            workId: WORK,
            actionType: ActivityActionType.APP_ENV,
            action: 'app.env.changed',
            status: ActivityStatus.COMPLETED,
            summary: 'Environment values set (2)',
            metadata: { names: ['FIXTURE_MARKER', 'FIXTURE_MAIL_TO'], actions: ['set'] },
        });
        // The enum member and the event's own string are the same, on purpose.
        expect(ActivityActionType.APP_ENV).toBe(event.actionType);
    });

    it('copies only the known detail keys — nothing an event might grow leaks into a row', async () => {
        const log = jest.fn().mockResolvedValue({});
        await writer(log).emit({
            ...event,
            details: { name: 'NEXTAUTH_SECRET', value: 'leak' } as never,
        });
        expect(log.mock.calls[0][0].metadata).toEqual({ name: 'NEXTAUTH_SECRET' });
    });

    it('refuses (so apply reports activityRecorded: false) with no log service or no actor', async () => {
        await expect(writer().emit(event)).rejects.toThrow(/not available/);
        await expect(writer(jest.fn()).emit({ ...event, userId: null })).rejects.toThrow(/actor/);
    });
});
