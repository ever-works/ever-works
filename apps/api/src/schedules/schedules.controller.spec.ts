import 'reflect-metadata';

// The controller imports `SchedulesService` as a value (DI token). Pulling the
// real `@ever-works/agent/schedules` barrel drags the whole entity/TypeORM
// graph into this spec for no benefit — the handler under test only calls
// `getSchedules`. Stub the barrel, same approach as missions/dto/mission.dto.spec.ts.
jest.mock('@ever-works/agent/schedules', () => ({
    SchedulesService: class {},
}));
jest.mock('../scope', () => ({
    ScopeContextService: class {},
}));

import { SchedulesController } from './schedules.controller';
import type { ScheduleView } from '@ever-works/agent/schedules';

/**
 * Response-shape pin for `GET /api/schedules`.
 *
 * The dashboard's Soon block destructured `{ items, total }` out of this
 * handler's response. The handler returns a bare array, so `items` was always
 * `undefined` and the block rendered nothing — the second half of the defect,
 * and one that would have survived fixing the query parameters alone.
 *
 * These tests deliberately assert the *absence* of a pagination envelope.
 * `apps/web/src/lib/api/schedules.ts` (`schedulesAPI.getAll`) and the Schedules
 * view built on it both consume a bare array, so wrapping this response would
 * be a breaking change to a shipped consumer — which is exactly why the fix
 * went into the caller rather than here.
 */

const view = (over: Partial<ScheduleView> = {}): ScheduleView => ({
    id: 'work_schedule:w1',
    sourceType: 'work_schedule',
    ownerType: 'work',
    ownerId: 'w1',
    ownerName: 'Directory refresh',
    ownerLink: '/works/w1',
    cadenceRaw: '0 9 * * *',
    cadenceHuman: 'Every day at 09:00',
    nextRunAt: '2026-08-12T09:00:00.000Z',
    lastRunAt: null,
    lastRunStatus: null,
    status: 'active',
    enabled: true,
    ...over,
});

function build(rows: ScheduleView[]) {
    const getSchedules = jest.fn().mockResolvedValue(rows);
    const controller = new SchedulesController(
        { getSchedules } as never,
        { getOrganizationId: () => null } as never,
    );
    return { controller, getSchedules };
}

const auth = { userId: 'user-1' } as never;

describe('SchedulesController.list — response shape', () => {
    it('returns a bare array, not an { items, total } envelope', async () => {
        const rows = [view(), view({ id: 'mission_tick:m1', sourceType: 'mission_tick' })];
        const { controller } = build(rows);

        const result = await controller.list(auth, {});

        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(2);
        // The two properties the Soon block used to read off this response.
        expect((result as unknown as { items?: unknown }).items).toBeUndefined();
        expect((result as unknown as { total?: unknown }).total).toBeUndefined();
    });

    it('returns an empty array — never an envelope — when there is nothing to list', async () => {
        const { controller } = build([]);

        const result = await controller.list(auth, {});

        expect(result).toEqual([]);
        expect((result as unknown as { items?: unknown }).items).toBeUndefined();
    });

    it('passes each supported filter through to the service', async () => {
        const { controller, getSchedules } = build([]);

        await controller.list(auth, {
            sourceType: 'work_schedule',
            entityKind: 'work',
            enabledOnly: true,
        });

        expect(getSchedules).toHaveBeenCalledWith(
            { userId: 'user-1', organizationId: null },
            // note the rename across the boundary: `entityKind` on the wire is
            // `ownerType` on the service.
            { sourceType: 'work_schedule', ownerType: 'work', enabledOnly: true },
        );
    });

    it('sends no filters at all for an empty query', async () => {
        const { controller, getSchedules } = build([]);

        await controller.list(auth, {});

        expect(getSchedules).toHaveBeenCalledWith({ userId: 'user-1', organizationId: null }, {});
    });

    it('does not limit or re-slice the service result — the aggregation is un-paginated', async () => {
        const rows = Array.from({ length: 25 }, (_, i) =>
            view({ id: `work_schedule:w${i}`, ownerId: `w${i}` }),
        );
        const { controller } = build(rows);

        await expect(controller.list(auth, {})).resolves.toHaveLength(25);
    });
});
