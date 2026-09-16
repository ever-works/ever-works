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

async function connectSrcFor(apiUrl: string): Promise<string[]> {
    vi.stubEnv('NEXT_PUBLIC_API_URL', apiUrl);
    vi.resetModules();
    const { default: proxy } = await import('./proxy');
    // `/en/dashboard` takes the legacy-locale redirect, the shortest branch
    // that still leaves through `applySecurityHeaders`.
    const response = await proxy(new NextRequest('https://app.example/en/dashboard'));
    const csp = response.headers.get('content-security-policy');
    expect(csp, 'proxy() must set Content-Security-Policy').toBeTruthy();
    return parseCsp(csp as string).get('connect-src') ?? [];
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
