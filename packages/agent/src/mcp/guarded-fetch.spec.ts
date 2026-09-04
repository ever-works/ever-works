import { createGuardedFetch, MAX_REDIRECTS, pinnedConnect, pinnedFetch } from './guarded-fetch';

/**
 * The property under test is what CROSSES a redirect, not whether fetch works.
 * Every case here is a hop that used to be taken implicitly by the platform's
 * redirect following, with the caller's headers attached.
 */

interface Hop {
    url: string;
    init: RequestInit | undefined;
}

function scriptedFetch(script: Array<{ status: number; location?: string }>) {
    const hops: Hop[] = [];
    let index = 0;

    const impl = jest.fn(async (url: string, init?: RequestInit) => {
        hops.push({ url, init });
        const step = script[Math.min(index, script.length - 1)];
        index += 1;
        const headers = new Headers();
        if (step.location) headers.set('location', step.location);
        return new Response(null, { status: step.status, headers });
    });

    return { impl, hops };
}

describe('createGuardedFetch', () => {
    it('returns a non-redirect response untouched', async () => {
        const { impl, hops } = scriptedFetch([{ status: 200 }]);
        const fetchImpl = createGuardedFetch({ fetchImpl: impl });

        const response = await fetchImpl('https://api.example.com/mcp', {
            headers: { 'X-API-Key': 'secret' },
        });

        expect(response.status).toBe(200);
        expect(hops).toHaveLength(1);
        // The first request must carry the credential — that is the point of
        // configuring one.
        expect(hops[0].init?.headers).toEqual({ 'X-API-Key': 'secret' });
    });

    it('always requests manual redirects, so no hop is taken implicitly', async () => {
        const { impl, hops } = scriptedFetch([{ status: 200 }]);
        await createGuardedFetch({ fetchImpl: impl })('https://api.example.com/mcp');

        expect(hops[0].init?.redirect).toBe('manual');
    });

    it('KEEPS headers on a same-origin redirect', async () => {
        const { impl, hops } = scriptedFetch([
            { status: 307, location: 'https://api.example.com/v2/mcp' },
            { status: 200 },
        ]);
        const fetchImpl = createGuardedFetch({ fetchImpl: impl });

        await fetchImpl('https://api.example.com/mcp', {
            headers: { 'X-API-Key': 'secret' },
        });

        expect(hops).toHaveLength(2);
        expect(hops[1].url).toBe('https://api.example.com/v2/mcp');
        // Same origin, so the credential is still going to the server it was
        // configured for.
        expect(hops[1].init?.headers).toEqual({ 'X-API-Key': 'secret' });
    });

    it('DROPS every caller header on a cross-origin redirect', async () => {
        const { impl, hops } = scriptedFetch([
            { status: 302, location: 'https://evil.example.net/collect' },
            { status: 200 },
        ]);
        const fetchImpl = createGuardedFetch({ fetchImpl: impl });

        await fetchImpl('https://api.example.com/mcp', {
            headers: { 'X-API-Key': 'secret', Authorization: 'Bearer t0ken' },
        });

        expect(hops[1].url).toBe('https://evil.example.net/collect');
        // The platform strips `Authorization` cross-origin but NOT custom
        // headers, which is exactly how an MCP credential would leak.
        expect(hops[1].init?.headers).toBeUndefined();
        expect(JSON.stringify(hops[1].init ?? {})).not.toContain('secret');
        expect(JSON.stringify(hops[1].init ?? {})).not.toContain('t0ken');
    });

    it('drops headers when a redirect changes only the PORT', async () => {
        // Same host, different port is a different origin — and
        // `https://api.example.com:8443` is a plausible-looking target.
        const { impl, hops } = scriptedFetch([
            { status: 307, location: 'https://api.example.com:8443/mcp' },
            { status: 200 },
        ]);
        const fetchImpl = createGuardedFetch({ fetchImpl: impl });

        await fetchImpl('https://api.example.com/mcp', {
            headers: { 'X-API-Key': 'secret' },
        });

        expect(hops[1].init?.headers).toBeUndefined();
    });

    it('drops headers when a redirect downgrades the SCHEME', async () => {
        const { impl, hops } = scriptedFetch([
            { status: 302, location: 'http://api.example.com/mcp' },
            { status: 200 },
        ]);
        const fetchImpl = createGuardedFetch({ fetchImpl: impl });

        await fetchImpl('https://api.example.com/mcp', {
            headers: { 'X-API-Key': 'secret' },
        });

        // https → http is a different origin, so the credential must not ride
        // along onto a plaintext hop.
        expect(hops[1].init?.headers).toBeUndefined();
    });

    it('resolves a RELATIVE Location against the current URL', async () => {
        const { impl, hops } = scriptedFetch([
            { status: 307, location: '/v2/mcp' },
            { status: 200 },
        ]);
        const fetchImpl = createGuardedFetch({ fetchImpl: impl });

        await fetchImpl('https://api.example.com/mcp');

        expect(hops[1].url).toBe('https://api.example.com/v2/mcp');
    });

    it('rewrites POST to a bodyless GET after a 303', async () => {
        const { impl, hops } = scriptedFetch([
            { status: 303, location: 'https://api.example.com/result' },
            { status: 200 },
        ]);
        const fetchImpl = createGuardedFetch({ fetchImpl: impl });

        await fetchImpl('https://api.example.com/mcp', {
            method: 'POST',
            body: '{"a":1}',
            headers: { 'X-API-Key': 'secret' },
        });

        expect(hops[1].init?.method).toBe('GET');
        expect(hops[1].init?.body).toBeUndefined();
    });

    it('preserves the method across a 307, which is what 307 means', async () => {
        const { impl, hops } = scriptedFetch([
            { status: 307, location: 'https://api.example.com/v2' },
            { status: 200 },
        ]);
        const fetchImpl = createGuardedFetch({ fetchImpl: impl });

        await fetchImpl('https://api.example.com/mcp', { method: 'POST', body: '{}' });

        expect(hops[1].init?.method).toBe('POST');
    });

    it('drops to GET on a cross-origin 307, rather than sending a bodyless POST', async () => {
        const { impl, hops } = scriptedFetch([
            { status: 307, location: 'https://evil.example.net/collect' },
            { status: 200 },
        ]);
        const fetchImpl = createGuardedFetch({ fetchImpl: impl });

        await fetchImpl('https://api.example.com/mcp', {
            method: 'POST',
            body: '{"a":1}',
            headers: { 'X-API-Key': 'secret' },
        });

        // A 307 preserves the method by definition, so keeping POST while
        // dropping the body would send a bodyless POST to a host the caller
        // never addressed — a request neither side asked for, which a server
        // may still act on.
        expect(hops[1].init?.method).toBe('GET');
        expect(hops[1].init?.body).toBeUndefined();
        expect(hops[1].init?.headers).toBeUndefined();
    });

    it('still preserves POST across a SAME-origin 307', async () => {
        const { impl, hops } = scriptedFetch([
            { status: 307, location: 'https://api.example.com/v2' },
            { status: 200 },
        ]);
        const fetchImpl = createGuardedFetch({ fetchImpl: impl });

        await fetchImpl('https://api.example.com/mcp', { method: 'POST', body: '{}' });

        // Same origin keeps the caller's request intact; only the origin
        // crossing forfeits it.
        expect(hops[1].init?.method).toBe('POST');
        expect(hops[1].init?.body).toBe('{}');
    });

    it('refuses a redirect loop rather than following it forever', async () => {
        const { impl } = scriptedFetch([{ status: 302, location: 'https://api.example.com/a' }]);
        const fetchImpl = createGuardedFetch({ fetchImpl: impl });

        await expect(fetchImpl('https://api.example.com/mcp')).rejects.toThrow(/Too many/u);
        expect(impl).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
    });

    it('returns a redirect status that carries no Location instead of guessing', async () => {
        const { impl } = scriptedFetch([{ status: 302 }]);
        const fetchImpl = createGuardedFetch({ fetchImpl: impl });

        const response = await fetchImpl('https://api.example.com/mcp');

        expect(response.status).toBe(302);
        expect(impl).toHaveBeenCalledTimes(1);
    });

    it('re-runs the guard on the redirect TARGET, not only the first URL', async () => {
        // The whole reason redirects are followed here: the first URL passing
        // the guard says nothing about where it points.
        const { impl, hops } = scriptedFetch([
            { status: 302, location: 'http://127.0.0.1:6379/' },
            { status: 200 },
        ]);
        const fetchImpl = createGuardedFetch({ fetchImpl: impl });

        await fetchImpl('https://api.example.com/mcp');

        // The stub stands in for the DNS-pinned fetch, so this asserts the
        // target is handed to it for checking rather than fetched directly.
        expect(hops[1].url).toBe('http://127.0.0.1:6379/');
        expect(impl).toHaveBeenCalledTimes(2);
    });
});

describe('pinnedFetch — DNS rebinding', () => {
    it('refuses when ANY resolved address is private, not just the first', async () => {
        // A response mixing a public and a private record would otherwise pass
        // whenever the public one happens to be picked — a coin toss, not a
        // control.
        const resolver = jest.fn().mockResolvedValue([
            { address: '93.184.216.34', family: 4 },
            { address: '127.0.0.1', family: 4 },
        ]);

        await expect(
            pinnedFetch('https://rebind.example.com/mcp', undefined, resolver),
        ).rejects.toMatchObject({ code: 'dns_private_ip' });
    });

    it('refuses a private IPv6 answer', async () => {
        const resolver = jest.fn().mockResolvedValue([{ address: '::1', family: 6 }]);

        await expect(
            pinnedFetch('https://rebind.example.com/mcp', undefined, resolver),
        ).rejects.toMatchObject({ code: 'dns_private_ip' });
    });

    it('refuses when the lookup returns nothing', async () => {
        const resolver = jest.fn().mockResolvedValue([]);

        await expect(
            pinnedFetch('https://nowhere.example.com/mcp', undefined, resolver),
        ).rejects.toMatchObject({ code: 'dns_no_results' });
    });

    it('refuses a lookup failure rather than falling through to fetch', async () => {
        const resolver = jest.fn().mockRejectedValue(new Error('SERVFAIL'));

        await expect(
            pinnedFetch('https://broken.example.com/mcp', undefined, resolver),
        ).rejects.toMatchObject({ code: 'dns_lookup_failed' });
    });

    it('applies the lexical guard before spending a DNS lookup', async () => {
        const resolver = jest.fn();

        await expect(
            pinnedFetch('http://169.254.169.254/latest/meta-data/', undefined, resolver),
        ).rejects.toMatchObject({ code: 'lexical_blocked' });

        expect(resolver).not.toHaveBeenCalled();
    });

    it('does NOT resolve a literal-IP host — there is no name to rebind', async () => {
        const resolver = jest.fn();

        // Rejected by the lexical guard, and the point is that the resolver
        // was never consulted: a literal address cannot be rebound.
        await expect(
            pinnedFetch('http://127.0.0.1:6379/mcp', undefined, resolver),
        ).rejects.toMatchObject({ code: 'lexical_blocked' });

        expect(resolver).not.toHaveBeenCalled();
    });
});

/**
 * The real connection path, against a real server.
 *
 * Everything above injects `fetchImpl`, which is right for testing what crosses
 * a redirect but means `pinnedConnect` — the code that actually opens the
 * socket — ran in no test at all. `pinnedFetch` cannot be pointed at a local
 * server because `isSafeWebhookUrl` refuses loopback, so the untestable shape
 * was structural rather than an oversight.
 *
 * It hid a deadlock: `await dispatcher.close()` before returning the Response
 * waits for a body the caller has not been given the chance to read yet.
 */
describe('pinnedConnect against a live server', () => {
    let server: import('node:http').Server;
    let origin: string;

    beforeAll(async () => {
        const http = await import('node:http');
        server = http.createServer((req, res) => {
            const size = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('n') ?? 10);
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('x'.repeat(size));
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    });

    afterAll(async () => {
        // `close()` only stops the server ACCEPTING; it then waits for every
        // open connection to end. undici keeps its sockets alive by default, so
        // `close()` alone never settles and the server stays an open handle —
        // which is what "a worker process has failed to exit gracefully"
        // actually meant here. Dropping the live sockets first is the fix; a
        // `setImmediate` yield was not, and confirmed it by not helping.
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const loopback = { address: '127.0.0.1', family: 4 };

    it('returns a small body', async () => {
        const response = await pinnedConnect(`${origin}/?n=10`, undefined, loopback);
        await expect(response.text()).resolves.toHaveLength(10);
    });

    /**
     * The regression. A body larger than the socket buffer cannot complete
     * before the Response is handed back, so awaiting `close()` first hung
     * forever. 10 bytes passed; 200 KB never returned — and an SSE stream,
     * which never ends, hung on connect.
     *
     * The timeout is the assertion: without it a failure hangs the suite
     * instead of reporting.
     */
    it('returns a body larger than the socket buffer without hanging', async () => {
        const size = 200_000;

        const response = await withTimeout(
            pinnedConnect(`${origin}/?n=${size}`, undefined, loopback),
            5000,
            'pinnedConnect did not return',
        );
        const body = await withTimeout(response.text(), 5000, 'body never finished');

        expect(body).toHaveLength(size);
    }, 20000);

    it('rejects, rather than hanging, when the connection fails', async () => {
        // Port 1 is reserved and nothing listens on it.
        await expect(
            withTimeout(
                pinnedConnect('http://127.0.0.1:1/', undefined, loopback),
                5000,
                'pinnedConnect neither resolved nor rejected',
            ),
        ).rejects.toBeDefined();
    }, 20000);
});

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), ms);
        }),
    ]).finally(() => clearTimeout(timer)) as Promise<T>;
}
