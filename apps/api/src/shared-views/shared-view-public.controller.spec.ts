jest.mock('@ever-works/agent/shared-views', () => ({
    SharedViewService: class SharedViewService {},
    SharedViewProjectionService: class SharedViewProjectionService {},
    SharedViewRepository: class SharedViewRepository {},
}));

import 'reflect-metadata';
import {
    HttpException,
    HttpStatus,
    NotFoundException,
    RequestMethod,
    ServiceUnavailableException,
    type ArgumentsHost,
    type CallHandler,
    type ExecutionContext,
} from '@nestjs/common';
import {
    EXCEPTION_FILTERS_METADATA,
    INTERCEPTORS_METADATA,
    METHOD_METADATA,
    PATH_METADATA,
    ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { ThrottlerException } from '@nestjs/throttler';
import {
    THROTTLER_KEY_GENERATOR,
    THROTTLER_LIMIT,
    THROTTLER_TRACKER,
    THROTTLER_TTL,
} from '@nestjs/throttler/dist/throttler.constants';
import { lastValueFrom, of } from 'rxjs';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { SharedViewPublicController } from './shared-view-public.controller';
import {
    SHARED_VIEW_INDEXABLE_KEY,
    SHARED_VIEW_NOT_ACTIVE_BODY,
    SharedViewPublicExceptionFilter,
    SharedViewPublicHeadersInterceptor,
    sharedViewClientTracker,
    sharedViewThrottleKey,
    sharedViewTokenTracker,
} from './shared-view-public.http';
import { SHARED_VIEW_KEY, SharedViewSessionGuard } from './shared-view-session.guard';
import { SharedViewSessionService } from './shared-view-session.service';
import { SharedViewViewDedupe } from './shared-view-view-dedupe';

const TOKEN = 'Zb3kQ9x_T1-vYwP0aLmN8cR4sD6fG2hJ5kL7qW9eR1t';

function liveView(overrides: Record<string, unknown> = {}) {
    return {
        id: 'view-1',
        organizationId: 'org-1',
        tenantId: 'tenant-1',
        ownerUserId: 'owner-1',
        status: 'active',
        rotationCount: 2,
        sections: { board: true, knowledge: false },
        knowledgeClasses: [],
        searchIndexable: false,
        firstViewNotifiedAt: null,
        ...overrides,
    };
}

/** A minimal Express-like response that records what a filter or interceptor writes. */
function makeResponse() {
    const headers = new Map<string, string | number>();
    const response = {
        headers,
        statusCode: 200,
        body: undefined as unknown,
        headersSent: false,
        setHeader: jest.fn((name: string, value: string | number) => headers.set(name, value)),
        removeHeader: jest.fn((name: string) => headers.delete(name)),
        status: jest.fn((code: number) => {
            response.statusCode = code;
            return response;
        }),
        json: jest.fn((body: unknown) => {
            response.body = body;
            return response;
        }),
    };
    return response;
}

function hostFor(response: ReturnType<typeof makeResponse>): ArgumentsHost {
    return {
        switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({}) }),
    } as unknown as ArgumentsHost;
}

describe('SharedViewPublicController', () => {
    const envBackup = { ...process.env };

    beforeEach(() => {
        process.env.SHARED_VIEW_SESSION_SECRET = 'a-long-enough-shared-view-secret';
    });

    afterEach(() => {
        process.env = { ...envBackup };
    });

    function makeController(view: ReturnType<typeof liveView> | null = liveView()) {
        const views = {
            resolveByToken: jest.fn().mockResolvedValue(view),
            recordView: jest.fn().mockResolvedValue(undefined),
        };
        const projection = {
            projectBoard: jest.fn().mockResolvedValue({ workspaceName: 'Northwind Studio' }),
        };
        const sessions = new SharedViewSessionService();
        const dedupe = new SharedViewViewDedupe();
        const controller = new SharedViewPublicController(
            views as never,
            projection as never,
            sessions,
            dedupe,
        );
        return { controller, views, projection, sessions, dedupe };
    }

    describe('route surface', () => {
        const handlers = ['createSession', 'board'] as const;
        const handler = (name: (typeof handlers)[number]) =>
            SharedViewPublicController.prototype[name] as unknown as object;

        it('is public, mounted at api/public/shared-view, with the posture filter and headers', () => {
            expect(Reflect.getMetadata(PATH_METADATA, SharedViewPublicController)).toBe(
                'api/public/shared-view',
            );
            expect(Reflect.getMetadata(IS_PUBLIC_KEY, SharedViewPublicController)).toBe(true);
            expect(
                Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, SharedViewPublicController),
            ).toContain(SharedViewPublicExceptionFilter);
            expect(
                Reflect.getMetadata(INTERCEPTORS_METADATA, SharedViewPublicController),
            ).toContain(SharedViewPublicHeadersInterceptor);
        });

        it('never takes a token (or anything else) in a path or query string', () => {
            const routeArgs =
                Reflect.getMetadata(
                    ROUTE_ARGS_METADATA,
                    SharedViewPublicController,
                    'createSession',
                ) ?? {};
            const boardArgs =
                Reflect.getMetadata(ROUTE_ARGS_METADATA, SharedViewPublicController, 'board') ?? {};
            for (const [key, arg] of Object.entries({ ...routeArgs, ...boardArgs })) {
                // RouteParamtypes: 4 = QUERY, 5 = PARAM. Only BODY and REQUEST are used here.
                const type = Number(key.split(':')[0]);
                expect({ key, type, data: (arg as { data?: unknown }).data }).not.toMatchObject({
                    data: expect.stringMatching(/token/i),
                });
                expect([4, 5]).not.toContain(type);
            }
            for (const name of handlers) {
                const path = String(Reflect.getMetadata(PATH_METADATA, handler(name)));
                expect(path).not.toMatch(/:|token|\*/i);
            }
        });

        it('exposes one POST (the exchange) and otherwise only GET reads', () => {
            expect(Reflect.getMetadata(METHOD_METADATA, handler('createSession'))).toBe(
                RequestMethod.POST,
            );
            expect(Reflect.getMetadata(PATH_METADATA, handler('createSession'))).toBe('sessions');
            expect(Reflect.getMetadata(METHOD_METADATA, handler('board'))).toBe(RequestMethod.GET);
            const routes = Object.getOwnPropertyNames(SharedViewPublicController.prototype).filter(
                (name) =>
                    Reflect.getMetadata(
                        METHOD_METADATA,
                        (SharedViewPublicController.prototype as never)[name],
                    ) !== undefined,
            );
            expect(routes.sort()).toEqual(['board', 'createSession']);
        });

        it('throttles 60 per minute per token or view and 600 per hour per client', () => {
            for (const name of handlers) {
                expect(Reflect.getMetadata(`${THROTTLER_LIMIT}long`, handler(name))).toBe(60);
                expect(Reflect.getMetadata(`${THROTTLER_TTL}long`, handler(name))).toBe(60_000);
                expect(Reflect.getMetadata(`${THROTTLER_LIMIT}medium`, handler(name))).toBe(600);
                expect(Reflect.getMetadata(`${THROTTLER_TTL}medium`, handler(name))).toBe(
                    3_600_000,
                );
                expect(Reflect.getMetadata(`${THROTTLER_TRACKER}medium`, handler(name))).toBe(
                    sharedViewClientTracker,
                );
                expect(Reflect.getMetadata(`${THROTTLER_KEY_GENERATOR}medium`, handler(name))).toBe(
                    sharedViewThrottleKey,
                );
            }
            expect(Reflect.getMetadata(`${THROTTLER_TRACKER}long`, handler('createSession'))).toBe(
                sharedViewTokenTracker,
            );
        });

        it('guards the board read with a view session', () => {
            expect(Reflect.getMetadata('__guards__', handler('board'))).toContain(
                SharedViewSessionGuard,
            );
        });
    });

    describe('POST sessions', () => {
        it('exchanges a live token for a fifteen-minute view session and counts the view once', async () => {
            const { controller, views, sessions } = makeController();
            const request: Record<string, unknown> = { ip: '203.0.113.7' };

            const first = await controller.createSession({ token: TOKEN }, request);
            await controller.createSession({ token: TOKEN }, request);

            expect(views.resolveByToken).toHaveBeenCalledWith(TOKEN);
            expect(sessions.verify(first.viewSession)).toMatchObject({ sid: 'view-1', rot: 2 });
            expect(first.searchIndexable).toBe(false);
            expect(first.sections).toEqual({ board: true, knowledge: false });
            expect(JSON.stringify(first)).not.toContain(TOKEN);
            expect(views.recordView).toHaveBeenCalledTimes(1);
            expect(request[SHARED_VIEW_INDEXABLE_KEY]).toBe(false);
        });

        it('flags an indexable view so the crawler block is lifted', async () => {
            const { controller } = makeController(liveView({ searchIndexable: true }));
            const request: Record<string, unknown> = { ip: '203.0.113.7' };
            const session = await controller.createSession({ token: TOKEN }, request);
            expect(session.searchIndexable).toBe(true);
            expect(request[SHARED_VIEW_INDEXABLE_KEY]).toBe(true);
        });

        it.each([
            ['an unknown, malformed, regenerated-away or paused token', null],
            [
                'a view that publishes nothing',
                liveView({ sections: { board: false, knowledge: false } }),
            ],
        ])('answers the not-active 404 for %s and counts nothing', async (_label, view) => {
            const { controller, views } = makeController(view as never);
            await expect(controller.createSession({ token: TOKEN }, {})).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(views.recordView).not.toHaveBeenCalled();
        });

        it('fails closed with 503 when no session secret is configured', async () => {
            delete process.env.SHARED_VIEW_SESSION_SECRET;
            delete process.env.BETTER_AUTH_SECRET;
            delete process.env.AUTH_SECRET;
            const { controller, views } = makeController();
            await expect(controller.createSession({ token: TOKEN }, {})).rejects.toBeInstanceOf(
                ServiceUnavailableException,
            );
            expect(views.recordView).not.toHaveBeenCalled();
        });
    });

    describe('GET board', () => {
        it('projects the view the guard resolved', async () => {
            const { controller, projection } = makeController();
            const view = liveView();
            await expect(controller.board({ [SHARED_VIEW_KEY]: view } as never)).resolves.toEqual({
                workspaceName: 'Northwind Studio',
            });
            expect(projection.projectBoard).toHaveBeenCalledWith(view);
        });

        it('answers 503 with a fixed message when the board cannot be read', async () => {
            const { controller, projection } = makeController();
            projection.projectBoard.mockRejectedValue(new Error('column read failed at /share/x'));
            await expect(
                controller.board({ [SHARED_VIEW_KEY]: liveView() } as never),
            ).rejects.toMatchObject({
                response: expect.objectContaining({ message: 'shared_view_unavailable' }),
            });
        });

        it('refuses a view whose board section is off', async () => {
            const { controller } = makeController();
            await expect(
                controller.board({
                    [SHARED_VIEW_KEY]: liveView({ sections: { board: false, knowledge: false } }),
                } as never),
            ).rejects.toBeInstanceOf(NotFoundException);
        });
    });
});

describe('SharedViewSessionGuard', () => {
    const envBackup = { ...process.env };

    beforeEach(() => {
        process.env.SHARED_VIEW_SESSION_SECRET = 'a-long-enough-shared-view-secret';
    });

    afterEach(() => {
        process.env = { ...envBackup };
    });

    const ctx = (req: Record<string, unknown>): ExecutionContext =>
        ({ switchToHttp: () => ({ getRequest: () => req }) }) as unknown as ExecutionContext;

    async function refusal(
        guard: SharedViewSessionGuard,
        authorization: unknown,
    ): Promise<unknown> {
        try {
            await guard.canActivate(ctx({ headers: { authorization } }));
        } catch (error) {
            return (error as HttpException).getResponse();
        }
        throw new Error('expected a refusal');
    }

    it('admits a live session and hands the view to the handler', async () => {
        const sessions = new SharedViewSessionService();
        const views = { findById: jest.fn().mockResolvedValue(liveView()) };
        const guard = new SharedViewSessionGuard(sessions, views as never);
        const { viewSession } = sessions.mint({ id: 'view-1', rotationCount: 2 });
        const req: Record<string, unknown> = {
            headers: { authorization: `Bearer ${viewSession}` },
        };

        await expect(guard.canActivate(ctx(req))).resolves.toBe(true);
        expect(req[SHARED_VIEW_KEY]).toMatchObject({ id: 'view-1' });
    });

    it('refuses a regenerated, paused, deleted, tampered or missing session with the same response', async () => {
        const sessions = new SharedViewSessionService();
        const { viewSession } = sessions.mint({ id: 'view-1', rotationCount: 2 });
        const bearer = `Bearer ${viewSession}`;

        const regenerated = new SharedViewSessionGuard(sessions, {
            findById: jest.fn().mockResolvedValue(liveView({ rotationCount: 3 })),
        } as never);
        const paused = new SharedViewSessionGuard(sessions, {
            findById: jest.fn().mockResolvedValue(liveView({ status: 'paused' })),
        } as never);
        const deleted = new SharedViewSessionGuard(sessions, {
            findById: jest.fn().mockResolvedValue(null),
        } as never);
        const untouched = { findById: jest.fn() };
        const tampered = new SharedViewSessionGuard(sessions, untouched as never);

        const responses = [
            await refusal(regenerated, bearer),
            await refusal(paused, bearer),
            await refusal(deleted, bearer),
            await refusal(tampered, `${bearer}x`),
            await refusal(tampered, undefined),
            await refusal(tampered, 'Basic abc'),
        ];
        for (const response of responses) {
            expect(response).toEqual(responses[0]);
        }
        expect(untouched.findById).not.toHaveBeenCalled();
    });
});

describe('SharedViewPublicExceptionFilter', () => {
    const filter = new SharedViewPublicExceptionFilter();

    function render(exception: unknown) {
        const response = makeResponse();
        filter.catch(exception, hostFor(response));
        return response;
    }

    it('renders every not-active cause as byte-identical bodies with the security headers', () => {
        const causes = [
            new NotFoundException('shared_view_not_active'),
            new NotFoundException('Shared view not found'),
            new NotFoundException(),
            new HttpException('gone', HttpStatus.NOT_FOUND),
        ];
        const rendered = causes.map(render);
        for (const response of rendered) {
            expect(response.statusCode).toBe(404);
            expect(JSON.stringify(response.body)).toBe(JSON.stringify(SHARED_VIEW_NOT_ACTIVE_BODY));
            expect(response.headers.get('Cache-Control')).toBe('no-store');
            expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
            expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
            expect(response.headers.get('X-Robots-Tag')).toBe(
                'noindex, nofollow, noarchive, nosnippet',
            );
        }
    });

    it('answers a throttle with 429 and Retry-After: 60', () => {
        const response = render(new ThrottlerException());
        expect(response.statusCode).toBe(429);
        expect(response.headers.get('Retry-After')).toBe(60);
        expect(response.body).toEqual({
            statusCode: 429,
            message: 'shared_view_throttled',
            error: 'Too Many Requests',
        });
    });

    it('keeps other HTTP errors as they are', () => {
        const response = render(new ServiceUnavailableException('shared_view_unavailable'));
        expect(response.statusCode).toBe(503);
        expect(response.body).toMatchObject({ message: 'shared_view_unavailable' });
    });

    it('never echoes an unexpected error, and logs only its class name', () => {
        const logger = jest
            .spyOn((filter as unknown as { logger: { error: () => void } }).logger, 'error')
            .mockImplementation(() => undefined);
        const response = render(new Error(`exploded at /share/${TOKEN} with Bearer abc.def`));
        expect(response.statusCode).toBe(500);
        expect(JSON.stringify(response.body)).not.toContain('exploded');
        const logged = String((logger.mock.calls[0] as unknown[])[0]);
        expect(logged).toBe('Shared view public request failed: Error');
        expect(logged).not.toContain(TOKEN);
        expect(logged).not.toContain('abc.def');
        logger.mockRestore();
    });
});

describe('SharedViewPublicHeadersInterceptor', () => {
    async function run(indexable: boolean) {
        const response = makeResponse();
        const request: Record<string, unknown> = {};
        const context = {
            switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
        } as unknown as ExecutionContext;
        const next: CallHandler = {
            handle: () => {
                request[SHARED_VIEW_INDEXABLE_KEY] = indexable;
                return of({ ok: true });
            },
        };
        await lastValueFrom(new SharedViewPublicHeadersInterceptor().intercept(context, next));
        return response;
    }

    it('sends no-store, no-referrer, nosniff and the crawler block by default', async () => {
        const response = await run(false);
        expect(Object.fromEntries(response.headers)).toEqual({
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
            'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
        });
    });

    it('omits only the crawler block when the owner allowed indexing', async () => {
        const response = await run(true);
        expect(response.headers.has('X-Robots-Tag')).toBe(false);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    });
});

describe('shared view throttle buckets', () => {
    it('keys the token bucket by a hash, never the token', () => {
        const tracker = sharedViewTokenTracker({ body: { token: TOKEN } });
        expect(tracker).toMatch(/^token:[0-9a-f]{64}$/);
        expect(tracker).not.toContain(TOKEN);
        expect(sharedViewTokenTracker({ body: {} })).toBe('token:none');
    });

    it('shares one client bucket across every public route', () => {
        const a = sharedViewThrottleKey(
            { getClass: () => 'A', getHandler: () => 'x' } as never,
            'ip:1',
            'medium',
        );
        const b = sharedViewThrottleKey(
            { getClass: () => 'B', getHandler: () => 'y' } as never,
            'ip:1',
            'medium',
        );
        expect(a).toBe(b);
        expect(sharedViewThrottleKey({} as never, 'ip:2', 'medium')).not.toBe(a);
    });

    it('buckets a client by its resolved address', () => {
        const envBackup = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        expect(
            sharedViewClientTracker({ ip: '203.0.113.7', headers: { 'x-e2e-throttle-key': 'w1' } }),
        ).toBe('ip:203.0.113.7');
        process.env.NODE_ENV = envBackup;
    });
});
