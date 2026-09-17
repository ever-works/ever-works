import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';

// Mock the agent-package barrel so importing the controller does not pull the
// real TypeORM / entity runtime (the `feed.controller.spec.ts` convention). The
// error class keeps the `code` contract the controller maps to a 400 body.
jest.mock('@ever-works/agent/home', () => {
    class InvalidHomeTimezoneError extends Error {
        readonly code = 'invalid-timezone';
    }
    return { HomeSummaryService: class {}, InvalidHomeTimezoneError };
});

import { InvalidHomeTimezoneError, type HomeSummaryService } from '@ever-works/agent/home';
import type { HomeSummaryDto } from '@ever-works/contracts';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { ScopeContextService } from '../scope/scope-context.service';
import { HomeController } from './home.controller';

const SCOPE = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
};
const auth = { userId: 'user-1' } as AuthenticatedUser;

const SUMMARY: HomeSummaryDto = {
    computedAt: '2026-09-14T07:04:00.000Z',
    timezone: 'UTC',
    timezoneFallback: true,
    day: { date: '2026-09-14', from: '2026-09-14T00:00:00.000Z', to: '2026-09-15T00:00:00.000Z' },
    needsYou: { status: 'ok', data: { rows: [], total: 0, overdueCount: 0, blockingCount: 0 } },
    glance: { status: 'ok', data: { needsYou: 0, workingNow: 0, doneToday: 0, failedToday: 0 } },
    today: { status: 'failed', errorKey: 'timeout', data: null },
    thisWeek: { status: 'failed', errorKey: 'unavailable', data: null },
    workingNow: { status: 'ok', data: { rows: [], total: 0 } },
    recentActivity: { status: 'ok', data: { entries: [] } },
};

function createController() {
    const home = { build: jest.fn().mockResolvedValue(SUMMARY) };
    const scopeContext = { getScope: jest.fn().mockReturnValue(SCOPE) };
    const controller = new HomeController(
        home as unknown as HomeSummaryService,
        scopeContext as unknown as ScopeContextService,
    );
    return { controller, home, scopeContext };
}

describe('HomeController', () => {
    it('is NOT @Public() — an unauthenticated call is 401ed by the global auth guard', () => {
        expect(Reflect.getMetadata(IS_PUBLIC_KEY, HomeController)).toBeUndefined();
        expect(
            Reflect.getMetadata(IS_PUBLIC_KEY, HomeController.prototype.getSummary),
        ).toBeUndefined();
    });

    it('marks the response private and never storable', () => {
        const headers = Reflect.getMetadata(
            '__headers__',
            HomeController.prototype.getSummary,
        ) as Array<{
            name: string;
            value: string;
        }>;
        expect(headers).toEqual(
            expect.arrayContaining([{ name: 'Cache-Control', value: 'private, no-store' }]),
        );
    });

    it('builds for the session user in the request scope, and returns every block', async () => {
        const { controller, home, scopeContext } = createController();

        const summary = await controller.getSummary(auth, {});

        expect(scopeContext.getScope).toHaveBeenCalled();
        expect(home.build).toHaveBeenCalledWith('user-1', {
            scope: SCOPE,
            timezone: undefined,
            blocks: undefined,
        });
        for (const id of [
            'needsYou',
            'glance',
            'today',
            'thisWeek',
            'workingNow',
            'recentActivity',
        ]) {
            expect(summary).toHaveProperty(id);
        }
    });

    it('answers block-level failures inside a normal response', async () => {
        const { controller } = createController();

        const summary = await controller.getSummary(auth, {});

        expect(summary.today).toEqual({ status: 'failed', errorKey: 'timeout', data: null });
    });

    it('forwards the timezone and a block narrowing', async () => {
        const { controller, home } = createController();

        await controller.getSummary(auth, { tz: 'Europe/Kyiv', blocks: ['today'] });

        expect(home.build).toHaveBeenCalledWith('user-1', {
            scope: SCOPE,
            timezone: 'Europe/Kyiv',
            blocks: ['today'],
        });
    });

    it('reads a different scope when the request scope changes, never a query parameter', async () => {
        const { controller, home, scopeContext } = createController();
        const personal = { tenantId: SCOPE.tenantId, organizationId: null };
        scopeContext.getScope.mockReturnValue(personal);

        await controller.getSummary(auth, {});

        expect(home.build.mock.calls[0][1].scope).toBe(personal);
    });

    it('maps an unknown timezone to a 400 with a stable code', async () => {
        const { controller, home } = createController();
        home.build.mockRejectedValue(new InvalidHomeTimezoneError('Unknown timezone: Nowhere'));

        const failure = controller.getSummary(auth, { tz: 'Nowhere' });

        await expect(failure).rejects.toBeInstanceOf(BadRequestException);
        await expect(failure).rejects.toMatchObject({
            response: { error: 'invalid-timezone' },
        });
    });

    it('lets any other failure through to the global filter', async () => {
        const { controller, home } = createController();
        home.build.mockRejectedValue(new Error('boom'));

        await expect(controller.getSummary(auth, {})).rejects.toThrow('boom');
    });
});
