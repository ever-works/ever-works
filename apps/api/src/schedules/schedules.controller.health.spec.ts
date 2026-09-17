import 'reflect-metadata';

jest.mock('@ever-works/agent/schedules', () => ({
    SchedulesService: class {},
    ScheduleControlService: class {},
}));
jest.mock('../scope', () => ({
    ScopeContextService: class {},
}));

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { SchedulesController } from './schedules.controller';

/**
 * `GET /api/schedules/health` — the NEVER RUNS dry run.
 *
 * The handler only reads: it calls `getHealthSummary` and nothing else, so a
 * GET can never repair, pause or dispatch anything. Route declaration order
 * is pinned too — `health` and `page` are literal segments and must stay
 * reachable next to the `:id` control routes.
 */
describe('SchedulesController.health', () => {
    it('returns the summary for the caller scope and touches nothing else', async () => {
        const summary = {
            checkedAt: '2026-09-14T10:00:00.000Z',
            counts: { ok: 3, neverRuns: 0, byReason: {} },
            flagged: [],
            degradedSources: [],
        };
        const service = {
            getHealthSummary: jest.fn().mockResolvedValue(summary),
            getPage: jest.fn(),
            getSchedules: jest.fn(),
        };
        const controls = { runNow: jest.fn(), pause: jest.fn(), resume: jest.fn() };
        const controller = new SchedulesController(
            service as never,
            { getOrganizationId: () => 'org-1' } as never,
            controls as never,
        );

        await expect(controller.health({ userId: 'user-1' } as never)).resolves.toBe(summary);
        expect(service.getHealthSummary).toHaveBeenCalledWith({
            userId: 'user-1',
            organizationId: 'org-1',
        });
        expect(summary.counts.neverRuns).toBe(0);
        expect(summary.flagged).toEqual([]);
        expect(service.getPage).not.toHaveBeenCalled();
        expect(controls.runNow).not.toHaveBeenCalled();
        expect(controls.pause).not.toHaveBeenCalled();
        expect(controls.resume).not.toHaveBeenCalled();
    });

    it('declares the literal read routes as GETs and the controls as POSTs under :id', () => {
        const proto = SchedulesController.prototype as unknown as Record<string, unknown>;
        const route = (name: string) => ({
            path: Reflect.getMetadata(PATH_METADATA, proto[name] as object),
            method: Reflect.getMetadata(METHOD_METADATA, proto[name] as object),
        });
        expect(route('page')).toEqual({ path: 'page', method: RequestMethod.GET });
        expect(route('health')).toEqual({ path: 'health', method: RequestMethod.GET });
        expect(route('runNow')).toEqual({ path: ':id/run-now', method: RequestMethod.POST });
        expect(route('pause')).toEqual({ path: ':id/pause', method: RequestMethod.POST });
        expect(route('resume')).toEqual({ path: ':id/resume', method: RequestMethod.POST });
    });
});
