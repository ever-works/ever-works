// Stub the auth barrel so its transitive `@ever-works/agent/database`
// import is not pulled into this controller test.
jest.mock('../auth', () => ({
    Public: () => () => undefined,
}));

import { HealthController } from './health.controller';
import type { HealthCheckResult, HealthCheckService } from '@nestjs/terminus';

const OK_RESULT: HealthCheckResult = {
    status: 'ok',
    info: {},
    error: {},
    details: {},
};

describe('HealthController', () => {
    let health: { check: jest.Mock };
    let db: { pingCheck: jest.Mock };
    let redis: { isHealthy: jest.Mock };
    let services: { report: jest.Mock };
    let controller: HealthController;

    // Env keys the build-info + service detection read; saved/restored so
    // tests don't leak into each other or depend on the runner's env.
    const ENV_KEYS = [
        'BUILD_VERSION',
        'npm_package_version',
        'GIT_SHA',
        'GIT_REF',
        'BUILD_RUN',
        'BUILD_TIME',
        'GITHUB_REPO_URL',
        'REDIS_URL',
        'THROTTLER_REDIS_URL',
        'PLUGIN_OPENROUTER_API_KEY',
        'SENTRY_DSN',
        'POSTHOG_API_KEY',
    ];
    const SAVED: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const k of ENV_KEYS) {
            SAVED[k] = process.env[k];
            delete process.env[k];
        }
        health = { check: jest.fn().mockResolvedValue(OK_RESULT) };
        db = { pingCheck: jest.fn() };
        redis = { isHealthy: jest.fn() };
        services = { report: jest.fn() };
        controller = new HealthController(
            health as unknown as HealthCheckService,
            db as never,
            redis as never,
            services as never,
        );
    });

    afterEach(() => {
        for (const k of ENV_KEYS) {
            if (SAVED[k] === undefined) delete process.env[k];
            else process.env[k] = SAVED[k];
        }
        jest.restoreAllMocks();
    });

    describe('version', () => {
        it('falls back to dev coordinates when nothing is stamped', () => {
            const info = controller.version();
            expect(info.name).toBe('api');
            expect(info.gitSha).toBe('dev');
            expect(info.shortSha).toBe('dev');
            expect(info.commitUrl).toBeNull();
            expect(typeof info.version).toBe('string');
        });

        it('reads the injected build coordinates and derives a commit URL', () => {
            process.env.BUILD_VERSION = '1.2.3';
            process.env.GIT_SHA = 'abcdef1234567890';
            process.env.GIT_REF = 'develop';
            process.env.BUILD_RUN = '142';

            const info = controller.version();

            expect(info.version).toBe('1.2.3');
            expect(info.shortSha).toBe('abcdef1');
            expect(info.gitRef).toBe('develop');
            expect(info.buildRun).toBe('142');
            expect(info.commitUrl).toBe(
                'https://github.com/ever-works/ever-works/commit/abcdef1234567890',
            );
        });

        it('never leaks env secrets in the payload', () => {
            process.env.SENTRY_DSN = 'https://secret@sentry.io/1';
            process.env.POSTHOG_API_KEY = 'phc_supersecret';
            const flat = JSON.stringify(controller.version());
            expect(flat).not.toContain('phc_supersecret');
            expect(flat).not.toContain('secret@sentry.io');
        });
    });

    describe('live', () => {
        it('runs an empty Terminus check (no dependencies)', async () => {
            await controller.live();
            expect(health.check).toHaveBeenCalledTimes(1);
            expect(health.check).toHaveBeenCalledWith([]);
        });
    });

    describe('ready', () => {
        it('checks the database + informational services, and embeds the version', async () => {
            const result = await controller.ready();

            expect(health.check).toHaveBeenCalledTimes(1);
            const checks = health.check.mock.calls[0][0] as Array<() => unknown>;
            // 1 DB ping + 7 informational services (no redis when unconfigured).
            expect(checks).toHaveLength(8);
            // The DB ping is the first registered check.
            checks[0]();
            expect(db.pingCheck).toHaveBeenCalledWith('database', { timeout: 3000 });
            expect(redis.isHealthy).not.toHaveBeenCalled();
            expect(result.status).toBe('ok');
            expect(result.version.name).toBe('api');
        });

        it('adds the Redis ping when a Redis URL is configured', async () => {
            process.env.REDIS_URL = 'redis://localhost:6379';

            await controller.ready();

            const checks = health.check.mock.calls[0][0] as Array<() => unknown>;
            // DB + Redis + 7 informational.
            expect(checks).toHaveLength(9);
            // Redis is the second check, right after the DB ping.
            checks[1]();
            expect(redis.isHealthy).toHaveBeenCalledWith('redis');
        });

        it('propagates a failing Terminus check (e.g. DB down → 503)', async () => {
            health.check.mockRejectedValueOnce(new Error('service unavailable'));
            await expect(controller.ready()).rejects.toThrow('service unavailable');
        });
    });
});
