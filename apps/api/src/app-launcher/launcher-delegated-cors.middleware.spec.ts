import { RequestMethod } from '@nestjs/common';

import { AppLauncherModule } from './app-launcher.module';
import {
    APP_LAUNCHER_MAX_ORIGINS,
    APP_LAUNCHER_ORIGINS_ENV,
    LauncherDelegatedCorsMiddleware,
    parseLauncherOrigins,
    resolveLauncherOrigins,
} from './launcher-delegated-cors.middleware';

/**
 * APW-11 T26 — the delegated-read CORS contract (plan §4.7, ACC-11-38).
 *
 * The properties this file exists to hold, in the order they matter:
 *
 *   1. **No credentials, ever.** A cross-origin read from a customer page must never be able to carry
 *      cookies — the delegated read is bearer-token only. The assertion is on the *absence* of the
 *      header, which is the direction that matters.
 *   2. **The allow-list is exact.** Not a pattern, not a suffix match: an origin is on it or it is not.
 *      A near-miss (`https://apps.example.com.attacker.test`) gets nothing.
 *   3. **A misconfigured production deploy does not boot** — more than the ceiling, or an entry that is
 *      not an exact `https://` origin, throws at boot the way `assertProductionCorsConfig` does.
 *   4. **Only the two read routes are touched.** The write route and every other API route get no CORS
 *      headers from this middleware.
 */

const ALLOWED = 'https://apps.example.com';
const OTHER_ALLOWED = 'https://launcher.example.org:8443';
const NOT_ALLOWED = 'https://apps.example.com.attacker.test';

interface FakeResponse {
    headers: Record<string, string>;
    statusCode: number | null;
    ended: boolean;
    setHeader(name: string, value: string): void;
    status(code: number): FakeResponse;
    end(): void;
}

function fakeResponse(): FakeResponse {
    return {
        headers: {},
        statusCode: null,
        ended: false,
        setHeader(name: string, value: string) {
            this.headers[name] = value;
        },
        status(code: number) {
            this.statusCode = code;
            return this;
        },
        end() {
            this.ended = true;
        },
    };
}

function run(middleware: LauncherDelegatedCorsMiddleware, method: string, origin?: string) {
    const req = { method, headers: origin === undefined ? {} : { origin } };
    const res = fakeResponse();
    const next = jest.fn();

    // The middleware declares the minimal shapes its sibling middleware documents (see its own import
    // comment); these fakes satisfy exactly those and nothing more.
    middleware.use(
        req as unknown as Parameters<LauncherDelegatedCorsMiddleware['use']>[0],
        res as unknown as Parameters<LauncherDelegatedCorsMiddleware['use']>[1],
        next as unknown as Parameters<LauncherDelegatedCorsMiddleware['use']>[2],
    );

    return { res, next };
}

describe('LauncherDelegatedCorsMiddleware (APW-11 T26, plan §4.7)', () => {
    const middleware = new LauncherDelegatedCorsMiddleware([ALLOWED, OTHER_ALLOWED]);

    it('sets ACAO, Vary and Allow-Headers for an allow-listed origin — and NEVER Allow-Credentials', () => {
        const { res, next } = run(middleware, 'GET', ALLOWED);

        expect(res.headers['Access-Control-Allow-Origin']).toBe(ALLOWED);
        expect(res.headers['Vary']).toBe('Origin');
        expect(res.headers['Access-Control-Allow-Headers']).toBe('Authorization');
        // The property the whole surface turns on: absent, not merely false.
        expect(res.headers).not.toHaveProperty('Access-Control-Allow-Credentials');
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('answers an allow-listed origin with the second entry too, including its port', () => {
        const { res } = run(middleware, 'GET', OTHER_ALLOWED);

        expect(res.headers['Access-Control-Allow-Origin']).toBe(OTHER_ALLOWED);
    });

    it('gives an origin that is NOT allow-listed no CORS headers at all (ACC-11-38)', () => {
        const { res, next } = run(middleware, 'GET', NOT_ALLOWED);

        expect(res.headers).toEqual({});
        // The request still reaches the handler: the browser is what blocks the read (spec S22).
        expect(next).toHaveBeenCalledTimes(1);
    });

    it('gives a request with no Origin header no CORS headers — a same-origin call is not a CORS call', () => {
        const { res } = run(middleware, 'GET');

        expect(res.headers).toEqual({});
    });

    it('answers preflight with 204, for allow-listed and unknown origins alike, and never calls next', () => {
        const allowed = run(middleware, 'OPTIONS', ALLOWED);
        expect(allowed.res.statusCode).toBe(204);
        expect(allowed.res.ended).toBe(true);
        expect(allowed.next).not.toHaveBeenCalled();
        expect(allowed.res.headers['Access-Control-Allow-Origin']).toBe(ALLOWED);

        const unknown = run(middleware, 'OPTIONS', NOT_ALLOWED);
        expect(unknown.res.statusCode).toBe(204);
        expect(unknown.res.ended).toBe(true);
        expect(unknown.next).not.toHaveBeenCalled();
        expect(unknown.res.headers).toEqual({});
    });
});

describe('the allow-list is parsed exactly (plan §4.7)', () => {
    it('accepts exact https origins, with and without a port', () => {
        const parsed = parseLauncherOrigins(`${ALLOWED}, ${OTHER_ALLOWED} ,https://a.b.co`);

        expect(parsed.origins).toEqual([ALLOWED, OTHER_ALLOWED, 'https://a.b.co']);
        expect(parsed.invalid).toEqual([]);
        expect(parsed.tooMany).toBe(false);
    });

    it('refuses everything that is not an exact origin, verbatim, rather than coercing it', () => {
        const parsed = parseLauncherOrigins(
            [
                'https://apps.example.com/', // trailing slash
                'http://apps.example.com', // not https
                '*', // wildcard
                'https://*.example.com', // wildcard host
                'apps.example.com', // no scheme
                'https://apps.example.com/path', // path
                'https://user:pw@apps.example.com', // credentials
            ].join(','),
        );

        expect(parsed.origins).toEqual([]);
        expect(parsed.invalid).toHaveLength(7);
    });

    it('de-duplicates case-insensitively, keeping the first spelling', () => {
        const parsed = parseLauncherOrigins('https://Apps.Example.com,https://apps.example.com');

        expect(parsed.origins).toEqual(['https://Apps.Example.com']);
    });

    it('flags more than fifty valid origins', () => {
        const many = Array.from(
            { length: APP_LAUNCHER_MAX_ORIGINS + 1 },
            (_unused, index) => `https://app${index}.example.com`,
        ).join(',');

        const parsed = parseLauncherOrigins(many);
        expect(parsed.origins).toHaveLength(APP_LAUNCHER_MAX_ORIGINS + 1);
        expect(parsed.tooMany).toBe(true);
    });
});

describe('boot validation (plan §4.7: invalid entries fail boot in production)', () => {
    const env = (values: Record<string, string>): NodeJS.ProcessEnv =>
        values as unknown as NodeJS.ProcessEnv;

    it('throws in production when an entry is not an exact origin', () => {
        expect(() =>
            resolveLauncherOrigins(
                env({
                    NODE_ENV: 'production',
                    [APP_LAUNCHER_ORIGINS_ENV]: 'http://apps.example.com',
                }),
            ),
        ).toThrow(/not exact https:\/\/ origins/);
    });

    it('throws in production when a 51st origin is configured', () => {
        const many = Array.from(
            { length: APP_LAUNCHER_MAX_ORIGINS + 1 },
            (_unused, index) => `https://app${index}.example.com`,
        ).join(',');

        expect(() =>
            resolveLauncherOrigins(
                env({ NODE_ENV: 'production', [APP_LAUNCHER_ORIGINS_ENV]: many }),
            ),
        ).toThrow(new RegExp(`maximum is ${APP_LAUNCHER_MAX_ORIGINS}`));
    });

    it('accepts exactly fifty in production', () => {
        const fifty = Array.from(
            { length: APP_LAUNCHER_MAX_ORIGINS },
            (_unused, index) => `https://app${index}.example.com`,
        ).join(',');

        expect(
            resolveLauncherOrigins(
                env({ NODE_ENV: 'production', [APP_LAUNCHER_ORIGINS_ENV]: fifty }),
            ),
        ).toHaveLength(APP_LAUNCHER_MAX_ORIGINS);
    });

    it('drops invalid entries outside production instead of refusing to boot, and truncates past the ceiling', () => {
        expect(
            resolveLauncherOrigins(
                env({
                    NODE_ENV: 'development',
                    [APP_LAUNCHER_ORIGINS_ENV]: `${ALLOWED},http://nope`,
                }),
            ),
        ).toEqual([ALLOWED]);

        const many = Array.from(
            { length: APP_LAUNCHER_MAX_ORIGINS + 5 },
            (_unused, index) => `https://app${index}.example.com`,
        ).join(',');

        expect(
            resolveLauncherOrigins(env({ NODE_ENV: 'test', [APP_LAUNCHER_ORIGINS_ENV]: many })),
        ).toHaveLength(APP_LAUNCHER_MAX_ORIGINS);
    });

    it('answers an empty list for an unset variable — an unconfigured launcher is readable by nobody', () => {
        expect(resolveLauncherOrigins(env({ NODE_ENV: 'production' }))).toEqual([]);
    });
});

describe('the module applies it to the two read routes and nothing else', () => {
    it('registers GET and OPTIONS for both launcher reads, and no other route or method', () => {
        const apply = jest.fn().mockReturnValue({ forRoutes: jest.fn() });
        const consumer = { apply } as unknown as Parameters<AppLauncherModule['configure']>[0];

        new AppLauncherModule().configure(consumer);

        expect(apply).toHaveBeenCalledWith(LauncherDelegatedCorsMiddleware);

        const routes = (apply.mock.results[0].value.forRoutes as jest.Mock).mock.calls[0];
        expect(routes).toEqual([
            { path: 'api/me/apps', method: RequestMethod.GET },
            { path: 'api/me/apps', method: RequestMethod.OPTIONS },
            { path: 'api/app-launcher/platforms', method: RequestMethod.GET },
            { path: 'api/app-launcher/platforms', method: RequestMethod.OPTIONS },
        ]);

        // The write route is deliberately absent: a cross-origin arrangement write is not a thing.
        expect(routes).not.toContainEqual(
            expect.objectContaining({ path: 'api/me/apps/preferences' }),
        );
    });
});
