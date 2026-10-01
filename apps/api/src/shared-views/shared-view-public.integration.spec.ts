const sentryMock = {
    init: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    setUser: jest.fn(),
    setContext: jest.fn(),
    setTag: jest.fn(),
    setTags: jest.fn(),
    addBreadcrumb: jest.fn(),
    logger: {
        trace: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        fatal: jest.fn(),
    },
};
// `@sentry/nestjs`, `@sentry/profiling-node` and `posthog-node` are dependencies of
// `packages/monitoring`, NOT of `apps/api`: pnpm's strict layout means they cannot be
// resolved from a spec that lives here. They used to be mocked `virtual: true` under
// their bare names -- a DIFFERENT module from the one monitoring's interceptors load,
// so the mocks never reached them. `initPostHog({ apiKey: 'test-key' })` below then
// built a REAL PostHog client that flushed to the network (a CI red whenever that
// timed out after the suite: "Cannot log after tests are done"), and the secret-
// hygiene check in `afterEach` saw no Sentry or PostHog call at all. Each mock is
// now registered at the path monitoring itself resolves the package to.
function monitoringDependency(name: string): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dirname } = require('path') as typeof import('path');
    return require.resolve(name, { paths: [dirname(require.resolve('@ever-works/monitoring'))] });
}
jest.mock(monitoringDependency('@sentry/nestjs'), () => sentryMock);
jest.mock(monitoringDependency('@sentry/profiling-node'), () => ({
    nodeProfilingIntegration: jest.fn(() => ({})),
}));

const posthogCapture = jest.fn();
jest.mock(monitoringDependency('posthog-node'), () => ({
    PostHog: jest.fn().mockImplementation(() => ({
        capture: posthogCapture,
        identify: jest.fn(),
        shutdown: jest.fn().mockResolvedValue(undefined),
    })),
}));

jest.mock('@ever-works/agent/shared-views', () => ({
    SharedViewService: class SharedViewService {},
    SharedViewProjectionService: class SharedViewProjectionService {},
    SharedViewRepository: class SharedViewRepository {},
}));

import 'reflect-metadata';
import { INestApplication, LoggerService, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import {
    SharedViewProjectionService,
    SharedViewRepository,
    SharedViewService,
} from '@ever-works/agent/shared-views';
import { PostHogInterceptor, SentryInterceptor, initPostHog } from '@ever-works/monitoring';
import * as request from 'supertest';
import { UserAwareThrottlerGuard } from '../config/user-aware-throttler.guard';
import { LoggingInterceptor } from '../logging.interceptor';
import { SharedViewPublicController } from './shared-view-public.controller';
import { SharedViewSessionGuard } from './shared-view-session.guard';
import { SharedViewSessionService } from './shared-view-session.service';
import { SharedViewViewDedupe } from './shared-view-view-dedupe';

/**
 * The public share-link API through a real HTTP stack: the platform throttler
 * guard, the global validation pipe, the request log, error monitoring and
 * product analytics interceptors, the view-session guard and the posture
 * filter. The domain services are stubbed with an in-memory view.
 *
 * Two things only an HTTP-level run proves:
 *   - refusals raised by GUARDS (a stale session, a throttle) still carry the
 *     identical body and the security headers;
 *   - neither the share token nor the view session reaches a log line, a
 *     monitoring call or an analytics event, across every path.
 */

const TOKEN = 'Zb3kQ9x_T1-vYwP0aLmN8cR4sD6fG2hJ5kL7qW9eR1t';
const OTHER_TOKEN = 'Qq3kQ9x_T1-vYwP0aLmN8cR4sD6fG2hJ5kL7qW9eR1t';

class CapturingLogger implements LoggerService {
    readonly lines: string[] = [];
    log(message: unknown) {
        this.lines.push(String(message));
    }
    error(message: unknown, ...rest: unknown[]) {
        this.lines.push([message, ...rest].map(String).join(' '));
    }
    warn(message: unknown) {
        this.lines.push(String(message));
    }
    debug(message: unknown) {
        this.lines.push(String(message));
    }
    verbose(message: unknown) {
        this.lines.push(String(message));
    }
}

describe('Shared view public API over HTTP', () => {
    const envBackup = { ...process.env };
    let app: INestApplication;
    let logger: CapturingLogger;
    let issuedSessions: string[];

    const view = {
        id: 'view-1',
        organizationId: 'org-1',
        tenantId: 'tenant-1',
        ownerUserId: 'owner-1',
        status: 'active',
        rotationCount: 0,
        sections: { board: true, knowledge: false },
        knowledgeClasses: [],
        searchIndexable: false,
        firstViewNotifiedAt: null,
    };

    const views = {
        resolveByToken: jest.fn(async (token: unknown) =>
            token === TOKEN && view.status === 'active' ? { ...view } : null,
        ),
        recordView: jest.fn().mockResolvedValue(undefined),
    };
    const projection = {
        projectBoard: jest.fn().mockResolvedValue({
            workspaceName: 'Northwind Studio',
            sections: { board: true, knowledge: false },
            columns: [],
            agents: [],
            recent: [],
            generatedAt: '2026-09-14T12:00:00.000Z',
        }),
    };
    const repository = {
        findById: jest.fn(async (id: string) => (id === view.id ? { ...view } : null)),
    };

    beforeAll(async () => {
        process.env.HTTP_DEBUG = 'true';
        process.env.SHARED_VIEW_SESSION_SECRET = 'a-long-enough-shared-view-secret';
        process.env.NODE_ENV = 'test';
        delete process.env.POSTHOG_CAPTURE_ENABLED;
        initPostHog({ apiKey: 'test-key' });

        const moduleRef = await Test.createTestingModule({
            imports: [
                ThrottlerModule.forRoot({
                    throttlers: [
                        { name: 'short', ttl: 1000, limit: 10_000 },
                        { name: 'medium', ttl: 10_000, limit: 10_000 },
                        { name: 'long', ttl: 60_000, limit: 10_000 },
                    ],
                }),
            ],
            controllers: [SharedViewPublicController],
            providers: [
                SharedViewSessionService,
                SharedViewSessionGuard,
                SharedViewViewDedupe,
                { provide: SharedViewService, useValue: views },
                { provide: SharedViewProjectionService, useValue: projection },
                { provide: SharedViewRepository, useValue: repository },
                { provide: APP_GUARD, useClass: UserAwareThrottlerGuard },
                { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
                { provide: APP_INTERCEPTOR, useClass: SentryInterceptor },
                { provide: APP_INTERCEPTOR, useClass: PostHogInterceptor },
            ],
        }).compile();

        logger = new CapturingLogger();
        app = moduleRef.createNestApplication({ logger });
        app.useGlobalPipes(
            new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
        );
        await app.init();
    });

    afterAll(async () => {
        await app?.close();
        process.env = { ...envBackup };
    });

    beforeEach(() => {
        view.status = 'active';
        view.rotationCount = 0;
        view.searchIndexable = false;
        issuedSessions = [];
    });

    afterEach(() => {
        // The hygiene contract, after every scenario: nothing recorded holds a secret.
        const recorded = JSON.stringify([
            logger.lines,
            sentryMock.setContext.mock.calls,
            sentryMock.setTag.mock.calls,
            sentryMock.captureException.mock.calls.map((call) => [
                String(call[0]?.message),
                call[1],
            ]),
            sentryMock.addBreadcrumb.mock.calls,
            posthogCapture.mock.calls,
        ]);
        expect(recorded).not.toContain(TOKEN);
        expect(recorded).not.toContain(OTHER_TOKEN);
        for (const session of issuedSessions) {
            expect(recorded).not.toContain(session);
            expect(recorded).not.toContain(session.split('.')[1]);
        }
    });

    let tokenExchanges = 0;
    const exchange = (token: unknown, ip = '203.0.113.7') => {
        if (token === TOKEN) tokenExchanges += 1;
        return request(app.getHttpServer())
            .post('/api/public/shared-view/sessions')
            .set('x-forwarded-for', ip)
            .send({ token });
    };

    const readBoard = (session: string) =>
        request(app.getHttpServer())
            .get('/api/public/shared-view/board')
            .set('Authorization', `Bearer ${session}`);

    function expectPosture(response: request.Response, indexable = false) {
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['referrer-policy']).toBe('no-referrer');
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        if (indexable) {
            expect(response.headers['x-robots-tag']).toBeUndefined();
        } else {
            expect(response.headers['x-robots-tag']).toBe(
                'noindex, nofollow, noarchive, nosnippet',
            );
        }
        expect(response.headers['set-cookie']).toBeUndefined();
    }

    it('exchanges the token in a body and reads the board with the session', async () => {
        const exchanged = await exchange(TOKEN).expect(200);
        issuedSessions.push(exchanged.body.viewSession);
        expectPosture(exchanged);
        expect(exchanged.body.expiresAt).toEqual(expect.any(String));

        const board = await readBoard(exchanged.body.viewSession).expect(200);
        expectPosture(board);
        expect(board.body.workspaceName).toBe('Northwind Studio');
    });

    it('lifts only the crawler block for an indexable view', async () => {
        view.searchIndexable = true;
        const exchanged = await exchange(TOKEN).expect(200);
        issuedSessions.push(exchanged.body.viewSession);
        expectPosture(exchanged, true);
        const board = await readBoard(exchanged.body.viewSession).expect(200);
        expectPosture(board, true);
    });

    it('answers unknown, malformed, paused and regenerated-away links with byte-identical responses', async () => {
        const live = await exchange(TOKEN).expect(200);
        issuedSessions.push(live.body.viewSession);

        const unknown = await exchange(OTHER_TOKEN).expect(404);
        const malformed = await exchange(42).expect(404);
        const missing = await request(app.getHttpServer())
            .post('/api/public/shared-view/sessions')
            .send({})
            .expect(404);

        view.rotationCount = 1; // the owner regenerated the link
        const staleSession = await readBoard(live.body.viewSession).expect(404);
        const forgedSession = await readBoard(`${live.body.viewSession}x`).expect(404);
        const noSession = await request(app.getHttpServer())
            .get('/api/public/shared-view/board')
            .expect(404);

        view.rotationCount = 0;
        view.status = 'paused'; // the owner turned sharing off
        const paused = await exchange(TOKEN).expect(404);
        const pausedSession = await readBoard(live.body.viewSession).expect(404);

        const bodies = [
            unknown,
            malformed,
            missing,
            staleSession,
            forgedSession,
            noSession,
            paused,
            pausedSession,
        ].map((response) => {
            expectPosture(response);
            return response.text;
        });
        expect(new Set(bodies).size).toBe(1);
        expect(JSON.parse(bodies[0])).toEqual({
            statusCode: 404,
            message: 'shared_view_not_active',
            error: 'Not Found',
        });
    });

    it('refuses any write verb on the board', async () => {
        const exchanged = await exchange(TOKEN).expect(200);
        issuedSessions.push(exchanged.body.viewSession);
        for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
            const response = await request(app.getHttpServer())
                [verb]('/api/public/shared-view/board')
                .set('Authorization', `Bearer ${exchanged.body.viewSession}`);
            expect(response.status).toBe(404);
        }
    });

    it('answers an unexpected failure with a generic 500 that echoes nothing', async () => {
        views.resolveByToken.mockRejectedValueOnce(
            new Error('lookup failed: database unavailable'),
        );
        const response = await exchange(TOKEN, '192.0.2.10').expect(500);
        expectPosture(response);
        expect(response.text).not.toContain('lookup failed');
    });
    it('throttles the 61st exchange on one token with 429 and Retry-After: 60, and never counts it', async () => {
        // Runs last: it spends the token's whole per-minute allowance. Earlier
        // scenarios already used part of it, so exchange until refused.
        let last: request.Response | undefined;
        do {
            last = await exchange(TOKEN, `198.51.100.${tokenExchanges}`);
            if (last.status === 200) issuedSessions.push(last.body.viewSession);
        } while (last.status === 200 && tokenExchanges < 70);

        expect(tokenExchanges).toBe(61);
        const countedBefore = views.recordView.mock.calls.length;
        expect(last.status).toBe(429);
        expect(last.headers['retry-after']).toBe('60');
        expectPosture(last);
        expect(last.body).toEqual({
            statusCode: 429,
            message: 'shared_view_throttled',
            error: 'Too Many Requests',
        });

        const again = await exchange(TOKEN, '198.51.100.250');
        expect(again.status).toBe(429);
        expect(views.recordView.mock.calls.length).toBe(countedBefore);
    });

    // Last, on purpose: the stubs above must be the modules monitoring's interceptors
    // actually call, or the secret-hygiene check in `afterEach` is vacuous for PostHog
    // (and a real client flushes to the network after the suite).
    it('saw the interceptors through the stubs: PostHog captures reached the mock', () => {
        expect(posthogCapture).toHaveBeenCalled();
    });
});
