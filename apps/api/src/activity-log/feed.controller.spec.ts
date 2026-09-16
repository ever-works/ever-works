import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

// Mock the agent-package barrel so importing the controller does not pull the
// real TypeORM / entity runtime (the `activity-log.controller.spec.ts`
// convention). The two error classes are recreated with the same `code`
// contract the controller maps to HTTP 400 bodies.
jest.mock('@ever-works/agent/activity-log', () => {
    class FeedInvalidCursorError extends Error {
        readonly code = 'invalid-cursor';
    }
    class FeedTooManyAgentsError extends Error {
        readonly code = 'too-many-agents';
        readonly max = 20;
    }
    return { FeedService: class {}, FeedInvalidCursorError, FeedTooManyAgentsError };
});

import {
    FeedInvalidCursorError,
    FeedTooManyAgentsError,
    type FeedService,
} from '@ever-works/agent/activity-log';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';
import type { ScopeContextService } from '../scope/scope-context.service';
import { FeedActorsQueryDto } from './dto/feed-actors-query.dto';
import { FeedQueryDto } from './dto/feed-query.dto';
import { FeedController } from './feed.controller';

const IVY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WREN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SCOPE = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    organizationId: '22222222-2222-4222-8222-222222222222',
};
const auth = { userId: 'user-1' } as AuthenticatedUser;

function createController() {
    const feed = {
        getPage: jest.fn().mockResolvedValue({
            items: [],
            nextCursor: null,
            hasMore: false,
            historyFloor: '2026-06-15T00:00:00.000Z',
        }),
        getActors: jest.fn().mockResolvedValue({ actors: [], windowHours: 168 }),
    };
    const scopeContext = { getScope: jest.fn().mockReturnValue(SCOPE) };
    const controller = new FeedController(
        feed as unknown as FeedService,
        scopeContext as unknown as ScopeContextService,
    );
    return { controller, feed, scopeContext };
}

async function dto<T extends object>(cls: new () => T, plain: Record<string, unknown>) {
    const instance = plainToInstance(cls, plain);
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    return { instance, errors };
}

describe('FeedController', () => {
    it('is NOT @Public() — an unauthenticated call is 401ed by the global auth guard', () => {
        expect(Reflect.getMetadata(IS_PUBLIC_KEY, FeedController)).toBeUndefined();
        for (const handler of ['getPage', 'getActors'] as const) {
            expect(
                Reflect.getMetadata(IS_PUBLIC_KEY, FeedController.prototype[handler]),
            ).toBeUndefined();
        }
    });

    describe('GET /api/feed', () => {
        it('reads as the session user in the request scope and forwards the filters', async () => {
            const { controller, feed, scopeContext } = createController();
            const { instance } = await dto(FeedQueryDto, {
                agentIds: `${IVY},${WREN}`,
                kinds: 'work,problem',
                failedOnly: 'true',
                cursor: 'abc',
                limit: '10',
            });

            await controller.getPage(auth, instance);

            expect(scopeContext.getScope).toHaveBeenCalled();
            expect(feed.getPage).toHaveBeenCalledWith('user-1', SCOPE, {
                agentIds: [IVY, WREN],
                kinds: ['work', 'problem'],
                failedOnly: true,
                cursor: 'abc',
                limit: 10,
            });
        });

        it('treats an absent or false failedOnly as off', async () => {
            const { controller, feed } = createController();
            await controller.getPage(
                auth,
                (await dto(FeedQueryDto, { failedOnly: 'false' })).instance,
            );
            await controller.getPage(auth, (await dto(FeedQueryDto, {})).instance);
            expect(feed.getPage.mock.calls[0][2].failedOnly).toBe(false);
            expect(feed.getPage.mock.calls[1][2].failedOnly).toBe(false);
        });

        it('answers an undecodable cursor with 400 invalid-cursor', async () => {
            const { controller, feed } = createController();
            feed.getPage.mockRejectedValue(new FeedInvalidCursorError());

            const error = await controller
                .getPage(auth, new FeedQueryDto())
                .catch((caught) => caught);

            expect(error).toBeInstanceOf(BadRequestException);
            expect((error as BadRequestException).getResponse()).toMatchObject({
                error: 'invalid-cursor',
            });
        });

        it('answers more than 20 agents with 400 too-many-agents and the maximum', async () => {
            const { controller, feed } = createController();
            feed.getPage.mockRejectedValue(new FeedTooManyAgentsError());

            const error = await controller
                .getPage(auth, new FeedQueryDto())
                .catch((caught) => caught);

            expect(error).toBeInstanceOf(BadRequestException);
            expect((error as BadRequestException).getResponse()).toMatchObject({
                error: 'too-many-agents',
                max: 20,
            });
        });

        it('lets any other failure propagate unchanged', async () => {
            const { controller, feed } = createController();
            const boom = new Error('database down');
            feed.getPage.mockRejectedValue(boom);
            await expect(controller.getPage(auth, new FeedQueryDto())).rejects.toBe(boom);
        });
    });

    describe('GET /api/feed/actors', () => {
        it('reads the roster as the session user in the request scope', async () => {
            const { controller, feed } = createController();
            const { instance } = await dto(FeedActorsQueryDto, { windowHours: '24' });
            await expect(controller.getActors(auth, instance)).resolves.toEqual({
                actors: [],
                windowHours: 168,
            });
            expect(feed.getActors).toHaveBeenCalledWith('user-1', SCOPE, 24);
        });
    });

    describe('FeedQueryDto', () => {
        it('accepts an empty query', async () => {
            expect((await dto(FeedQueryDto, {})).errors).toHaveLength(0);
        });

        it('has no parameter through which a caller can name a user or an organization', async () => {
            for (const plain of [
                { userId: 'user-2' },
                { organizationId: SCOPE.organizationId },
                { tenantId: 'x' },
            ]) {
                const { errors } = await dto(FeedQueryDto, plain);
                expect(errors.length).toBeGreaterThan(0);
            }
        });

        it('reads agentIds as a comma list or a repeated parameter and drops empty segments', async () => {
            expect(
                (await dto(FeedQueryDto, { agentIds: `${IVY},,${WREN},` })).instance.agentIds,
            ).toEqual([IVY, WREN]);
            expect((await dto(FeedQueryDto, { agentIds: [IVY, WREN] })).instance.agentIds).toEqual([
                IVY,
                WREN,
            ]);
        });

        it('lets 21 well-formed agent ids through so the service can refuse them with its own code', async () => {
            const ids = Array.from(
                { length: 21 },
                (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
            );
            expect((await dto(FeedQueryDto, { agentIds: ids.join(',') })).errors).toHaveLength(0);
        });

        it('rejects a malformed agent id, an unknown kind, a non-boolean failedOnly and a non-positive limit', async () => {
            expect(
                (await dto(FeedQueryDto, { agentIds: 'robert;drop table' })).errors[0].property,
            ).toBe('agentIds');
            expect((await dto(FeedQueryDto, { kinds: 'work,everything' })).errors[0].property).toBe(
                'kinds',
            );
            expect((await dto(FeedQueryDto, { failedOnly: 'maybe' })).errors[0].property).toBe(
                'failedOnly',
            );
            expect((await dto(FeedQueryDto, { limit: '0' })).errors[0].property).toBe('limit');
            expect((await dto(FeedQueryDto, { limit: 'lots' })).errors[0].property).toBe('limit');
        });

        it('accepts a large limit, which the service clamps to 50', async () => {
            const { instance, errors } = await dto(FeedQueryDto, { limit: '500' });
            expect(errors).toHaveLength(0);
            expect(instance.limit).toBe(500);
        });

        it('bounds the cursor length before it reaches the decoder', async () => {
            expect((await dto(FeedQueryDto, { cursor: 'x'.repeat(2000) })).errors[0].property).toBe(
                'cursor',
            );
        });
    });

    describe('FeedActorsQueryDto', () => {
        it('accepts 1..720 hours and rejects anything outside', async () => {
            expect((await dto(FeedActorsQueryDto, {})).errors).toHaveLength(0);
            expect((await dto(FeedActorsQueryDto, { windowHours: '720' })).errors).toHaveLength(0);
            expect((await dto(FeedActorsQueryDto, { windowHours: '721' })).errors[0].property).toBe(
                'windowHours',
            );
            expect((await dto(FeedActorsQueryDto, { windowHours: '0' })).errors[0].property).toBe(
                'windowHours',
            );
        });
    });
});
