import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { getAuthFromRequestMock, intlMock } = vi.hoisted(() => ({
    getAuthFromRequestMock: vi.fn(),
    intlMock: vi.fn(async (_request: unknown) => new Response(null, { status: 200 })),
}));

vi.mock('next-intl/middleware', () => ({ default: () => intlMock }));
vi.mock('./lib/auth', () => ({ getAuthFromRequest: getAuthFromRequestMock }));

/**
 * `connect-src` must authorise the live-view socket.
 *
 * The Agent computer surface and the streaming terminal open a WebSocket on
 * the API ORIGIN (`lib/api/computer-bff.ts` `toComputerSocketUrl`:
 * `origin.replace(/^http/, 'ws')`). CSP3 scheme-part matching does NOT let an
 * `http:`/`https:` source expression authorise a `ws:`/`wss:` URL, so listing
 * the API origin alone is not enough — Chrome refuses the connection with
 *
 *   Connecting to 'ws://127.0.0.1:3100/ws/computer/<id>' violates the
 *   following Content Security Policy directive: "connect-src 'self'
 *   http://127.0.0.1:3100 …". The action has been blocked.
 *
 * `new WebSocket()` then throws `SecurityError`, `use-computer-attach.ts`
 * reports `cannot-connect`, and the live surface is replaced by the
 * "cannot connect" card — for every user, on every environment, not just CI.
 *
 * `buildCsp()` runs once at module load, so each case re-imports `proxy`
 * with the env it is modelling.
 */
const CDN_CONNECT_SOURCES = ['https://cdn.jsdelivr.net', 'https://unpkg.com'];

function parseCsp(csp: string): Map<string, string[]> {
    const directives = new Map<string, string[]>();
    for (const part of csp.split(';')) {
        const [name, ...values] = part.trim().split(/\s+/);
        if (name) directives.set(name.toLowerCase(), values);
    }
    return directives;
}

/**
 * Both API env vars, stubbed together.
 *
 * `API_URL` has to be pinned as explicitly as `NEXT_PUBLIC_API_URL`: it is the
 * value the attach-token routes mint `wsUrl` from, so leaving it to whatever
 * the developer happens to export would make every case here env-dependent.
 * `undefined` genuinely unsets the variable for the duration of the test.
 */
async function connectSrcForEnv(env: {
    NEXT_PUBLIC_API_URL?: string;
    API_URL?: string;
}): Promise<string[]> {
    vi.stubEnv('NEXT_PUBLIC_API_URL', env.NEXT_PUBLIC_API_URL);
    vi.stubEnv('API_URL', env.API_URL);
    vi.resetModules();
    const { default: proxy } = await import('./proxy');
    // `/en/dashboard` takes the legacy-locale redirect, the shortest branch
    // that still leaves through `applySecurityHeaders`.
    const response = await proxy(new NextRequest('https://app.example/en/dashboard'));
    const csp = response.headers.get('content-security-policy');
    expect(csp, 'proxy() must set Content-Security-Policy').toBeTruthy();
    return parseCsp(csp as string).get('connect-src') ?? [];
}

async function connectSrcFor(apiUrl: string): Promise<string[]> {
    return connectSrcForEnv({ NEXT_PUBLIC_API_URL: apiUrl, API_URL: undefined });
}

/**
 * The socket origin an attach-token response would actually name, computed
 * through the SAME code path the BFF uses — `lib/constants.ts` `API_URL` and
 * `lib/api/computer-bff.ts` `toComputerSocketUrl` — under whatever env is
 * currently stubbed. Call this only after `connectSrcForEnv`, which resets the
 * module registry so both modules re-read the stubbed env.
 */
async function mintedSocketOrigin(): Promise<string> {
    const { API_URL } = await import('./lib/constants');
    const { toComputerSocketUrl } = await import('./lib/api/computer-bff');
    const wsUrl = toComputerSocketUrl(API_URL, '/ws/computer/8a2f0c3e');
    return new URL(wsUrl).origin;
}

describe('web CSP connect-src authorises the live-view socket', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthFromRequestMock.mockResolvedValue({ isAuthenticated: true, isExpired: false });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    it.each([
        ['http://127.0.0.1:3100/api', 'http://127.0.0.1:3100', 'ws://127.0.0.1:3100'],
        ['https://api.ever.works/api', 'https://api.ever.works', 'wss://api.ever.works'],
    ])('lists both the API origin and its socket twin for %s', async (apiUrl, http, ws) => {
        const connect = await connectSrcFor(apiUrl);

        expect(connect).toContain(http);
        expect(connect).toContain(ws);
        // The existing allow-list is untouched by the socket entry.
        expect(connect).toEqual(expect.arrayContaining(["'self'", ...CDN_CONNECT_SOURCES]));
    });

    it('derives the socket origin from the sanitised host, not the raw env', async () => {
        const connect = await connectSrcFor('not a url');

        // A malformed value still falls back to the hard-coded default, and the
        // socket twin follows it — it can never carry a directive separator.
        expect(connect).toContain('https://api.ever.works');
        expect(connect).toContain('wss://api.ever.works');
        for (const source of connect.filter((s) => !s.startsWith("'"))) {
            expect(source).toMatch(/^(?:https?|wss?):\/\/(?:\*\.)?[a-zA-Z0-9.-]+(?::\d{1,5})?$/);
        }
    });

    it("keeps next.config.ts's connect-src the byte-twin of proxy.ts's", () => {
        // Vitest's root is `apps/web` (see vitest.config.ts).
        const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');
        const connectSrcLine = (source: string): string => {
            const match = source.match(/connect-src 'self'[^`]*/);
            expect(match, 'connect-src directive not found').not.toBeNull();
            return (match as RegExpMatchArray)[0].trim();
        };

        const fromNextConfig = connectSrcLine(read('next.config.ts'));
        const fromProxy = connectSrcLine(read('src/proxy.ts'));

        // The two builders are maintained as twins; drift between them means a
        // policy that differs between the static headers and the middleware.
        expect(fromNextConfig).toBe(fromProxy);
        // Both must interpolate the socket origin right after the API origin.
        expect(fromNextConfig).toContain('${apiHost} ${apiWsHost}');
    });
});

/**
 * The socket source must name the origin the BFF ACTUALLY hands the browser.
 *
 * `NEXT_PUBLIC_API_URL` is the browser-facing API origin, but the live-view and
 * streaming-terminal `wsUrl` is minted server-side from the SERVER-ONLY
 * `API_URL` (`toComputerSocketUrl(API_URL, wsPath)`), and the browser opens
 * exactly that URL — it cannot substitute the public origin. In this repo
 * `NEXT_PUBLIC_API_URL` is set in one place only (`.github/workflows/e2e.yml`);
 * `docker-compose.yml`, every `.deploy/k8s` manifest and `apps/web/.env.example`
 * set `API_URL` alone. So a policy derived from `NEXT_PUBLIC_API_URL` only names
 * the right host inside the CI job and nowhere else.
 *
 * Each case below is a real deployment shape, and each asserts the policy
 * against the origin computed through the BFF's own code path rather than
 * against a hand-written expectation of what the policy contains.
 */
describe('web CSP connect-src names the socket origin the BFF mints', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAuthFromRequestMock.mockResolvedValue({ isAuthenticated: true, isExpired: false });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.resetModules();
    });

    const socketSourcesOf = (connect: string[]): string[] =>
        connect.filter((source) => /^wss?:\/\//.test(source));

    it.each([
        {
            shape: 'docker-compose.yml / k8s — only API_URL is set',
            env: { API_URL: 'http://ever-works-api:3100' },
            socket: 'ws://ever-works-api:3100',
        },
        {
            shape: 'apps/web/.env.example — the documented local dev env',
            env: { API_URL: 'http://localhost:3100' },
            socket: 'ws://localhost:3100',
        },
        {
            shape: 'public ingress + in-cluster API — both set and different',
            env: {
                NEXT_PUBLIC_API_URL: 'https://api.ever.works/api',
                API_URL: 'http://ever-works-api:3100',
            },
            socket: 'ws://ever-works-api:3100',
        },
        {
            shape: 'nothing set at all — both fall back',
            env: {},
            socket: 'ws://localhost:3100',
        },
        {
            shape: '.github/workflows/e2e.yml — both set, one origin',
            env: {
                NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3100/api',
                API_URL: 'http://127.0.0.1:3100',
            },
            socket: 'ws://127.0.0.1:3100',
        },
    ])('authorises the live-view socket for $shape', async ({ env, socket }) => {
        const connect = await connectSrcForEnv(env);

        // Guard the fixture itself: this is the origin `attach-token` would
        // name for this env, straight out of the BFF's own helpers.
        expect(await mintedSocketOrigin()).toBe(socket);
        expect(
            connect,
            `connect-src does not authorise the minted socket origin ${socket}: "${connect.join(' ')}"`,
        ).toContain(socket);
    });

    it('names both socket origins when the public and in-cluster API differ', async () => {
        const connect = await connectSrcForEnv({
            NEXT_PUBLIC_API_URL: 'https://api.ever.works/api',
            API_URL: 'http://ever-works-api:3100',
        });

        // The browser-facing origin keeps its http + ws pair …
        expect(connect).toContain('https://api.ever.works');
        expect(connect).toContain('wss://api.ever.works');
        // … and the origin the BFF actually mints from is authorised too.
        expect(connect).toContain('ws://ever-works-api:3100');
    });

    it('emits exactly one socket source when the two origins coincide', async () => {
        const connect = await connectSrcForEnv({
            NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3100/api',
            API_URL: 'http://127.0.0.1:3100',
        });

        expect(socketSourcesOf(connect)).toEqual(['ws://127.0.0.1:3100']);
    });

    it('drops an API_URL that is not an http(s) origin instead of emitting it', async () => {
        const connect = await connectSrcForEnv({
            NEXT_PUBLIC_API_URL: 'https://api.ever.works',
            API_URL: 'file:///etc/passwd',
        });

        expect(socketSourcesOf(connect)).toEqual(['wss://api.ever.works']);
    });

    it('authorises a bracketed IPv6 API origin instead of dropping it', async () => {
        // Review finding on #2455. `new URL('http://[::1]:3100').origin` keeps
        // the brackets, and the attach-token routes mint `ws://[::1]:3100/…`
        // from that same origin — so a host pattern that admits only
        // `[a-zA-Z0-9.-]` silently drops the source and CSP blocks the very
        // socket this module exists to authorise. Failing closed here is not
        // safe, it is a dead live view on an IPv6 deployment.
        const connect = await connectSrcForEnv({
            NEXT_PUBLIC_API_URL: 'http://[::1]:3100',
            API_URL: 'http://[::1]:3100',
        });

        expect(socketSourcesOf(connect)).toEqual(['ws://[::1]:3100']);
    });

    it('still refuses a bracketed host that is not an IPv6 literal', async () => {
        // The brackets are not a bypass: the inner class admits hex digits,
        // `:` and `.` only, which is narrower than the named-host class.
        const connect = await connectSrcForEnv({
            NEXT_PUBLIC_API_URL: 'https://api.ever.works',
            API_URL: 'http://[evil; default-src *]:3100',
        });

        expect(socketSourcesOf(connect)).toEqual(['wss://api.ever.works']);
    });

    it('never widens the policy — every socket source is a bare scheme+host[:port]', async () => {
        const connect = await connectSrcForEnv({
            NEXT_PUBLIC_API_URL: 'https://api.ever.works',
            API_URL: "http://ever-works-api:3100/x; default-src *; connect-src 'unsafe-inline'",
        });

        expect(socketSourcesOf(connect)).toEqual([
            'wss://api.ever.works',
            'ws://ever-works-api:3100',
        ]);
        for (const source of socketSourcesOf(connect)) {
            // No bare `ws:` scheme, no wildcard, no directive separator.
            expect(source).toMatch(/^wss?:\/\/[a-zA-Z0-9.-]+(?::\d{1,5})?$/);
        }
    });
});
