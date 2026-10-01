/**
 * APW-06 T23 — `AppPublicSmokeService` (plan §5.5, spec FR-26 step 7, FR-36, FR-37; ACC-06-12,
 * ACC-06-13).
 *
 * T23's Test line (`tasks.md:414-416`) asks for three things by name: "local HTTPS server with a
 * mismatched certificate → `tls_not_ready`; resolver returning another address → `dns_not_pointing`,
 * both reported as warnings not failures (ACC-06-13); body mismatch → `check_failed` with the found
 * string ≤ 200 chars", and its Done-when adds "no response body beyond 200 characters leaves the
 * service". Every one of them is here, plus the window/retry arithmetic, the 1 MiB cap, the
 * no-redirect rule, secret scrubbing and the in-cluster parity of the two defaults.
 *
 * Two halves are worth reading before the cases:
 *
 * - **The live half** runs real servers on ephemeral ports (`node:http` for the HTTP cases, a bare
 *   TCP server for the TLS case) and the real global `fetch`, so the classifier is exercised by
 *   errors Node actually raises rather than by literals this spec made up. The codes were read off
 *   a live run first: a plaintext answer to a ClientHello arrives as
 *   `TypeError: fetch failed` → `cause.code = 'ERR_SSL_PACKET_LENGTH_TOO_LONG'`, a closed port as
 *   `ECONNREFUSED`, a name that does not exist as `ENOTFOUND`.
 * - **The certificate half** is why this spec commits **no PEM pair**. The repository is public and
 *   a committed private key is what secret scanners are for, so the mismatched-certificate
 *   requirement is proven by (a) the live TLS handshake failure above and (b) every certificate
 *   code — `ERR_TLS_CERT_ALTNAME_INVALID`, `DEPTH_ZERO_SELF_SIGNED_CERT`,
 *   `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `CERT_HAS_EXPIRED`, … — through `classifyPublicSmokeError`
 *   *and* through an undici-shaped rejection on the real `fetch` seam, both asserting the identical
 *   `tls_not_ready` outcome the task names. The reasoning is written out in the service's own header
 *   (the "A test fixture this file does not add" section) rather than left implicit.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';

import {
    APP_SMOKE_BODY_BYTES,
    APP_SMOKE_FOUND_CHARS,
    APP_SMOKE_PUBLIC_FIRST_WINDOW_S,
    APP_SMOKE_PUBLIC_WINDOW_S,
    APP_SMOKE_RETRY_S,
} from '@ever-works/contracts';
import type { AppSmokeInput, CheckResult } from '@ever-works/plugin';

import {
    APP_PUBLIC_SMOKE_HEALTH_CODE,
    APP_PUBLIC_SMOKE_MAX_ATTEMPTS,
    APP_PUBLIC_SMOKE_WARNING_CODES,
    APP_SMOKE_DEFAULT_LATENCY_MS,
    APP_SMOKE_DEFAULT_STATUS,
    APP_SMOKE_REDACTED,
    AppPublicSmokeService,
    checkName,
    classificationOf,
    classifyPublicSmokeError,
    errorCodes,
    excerpt,
    expectationsOf,
    firstUrl,
    judge,
    publicSmokeWindowSeconds,
    readCapped,
    scrubSecrets,
    smokeChecksFor,
    type AppPublicSmokeClassification,
    type AppPublicSmokeRequest,
} from '../app-public-smoke.service';

/* -------------------------------------------------------------------------- *
 * Harness — real sockets, and the two seams the window runs on
 * -------------------------------------------------------------------------- */

/** One received request, so a case can prove what was (and was not) sent. */
interface ReceivedRequest {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
}

/** A live HTTP server on 127.0.0.1, with the requests it answered recorded. */
class LiveServer {
    readonly requests: ReceivedRequest[] = [];
    private server: http.Server | null = null;
    private port = 0;

    static async start(
        handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
    ): Promise<LiveServer> {
        const live = new LiveServer();
        live.server = http.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on('data', (chunk: Buffer) => chunks.push(chunk));
            request.on('end', () => {
                live.requests.push({
                    method: String(request.method),
                    url: String(request.url),
                    headers: request.headers,
                    body: Buffer.concat(chunks).toString('utf8'),
                });
                handler(request, response);
            });
        });

        await new Promise<void>((resolve) => live.server?.listen(0, '127.0.0.1', resolve));
        const address = live.server.address();
        live.port = typeof address === 'object' && address ? address.port : 0;
        return live;
    }

    get origin(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    get url(): string {
        return `${this.origin}/`;
    }

    async close(): Promise<void> {
        await new Promise<void>((resolve) => {
            if (!this.server) return resolve();
            this.server.closeAllConnections?.();
            this.server.close(() => resolve());
        });
        this.server = null;
    }
}

/** A live TLS port that never completes a handshake: it answers the ClientHello with plaintext. */
class BrokenTlsServer {
    private server: net.Server | null = null;
    private port = 0;
    private readonly sockets = new Set<net.Socket>();

    static async start(): Promise<BrokenTlsServer> {
        const broken = new BrokenTlsServer();
        broken.server = net.createServer((socket) => {
            broken.sockets.add(socket);
            socket.on('error', () => undefined);
            socket.on('close', () => broken.sockets.delete(socket));
            socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi');
            socket.end();
        });

        await new Promise<void>((resolve) => broken.server?.listen(0, '127.0.0.1', resolve));
        const address = broken.server.address();
        broken.port = typeof address === 'object' && address ? address.port : 0;
        return broken;
    }

    get url(): string {
        return `https://127.0.0.1:${this.port}/`;
    }

    async close(): Promise<void> {
        // undici keeps the connection alive, so a half-open socket would hold `close()` for ever:
        // the sockets this server accepted are destroyed before the listener is closed.
        for (const socket of this.sockets) socket.destroy();
        this.sockets.clear();

        await new Promise<void>((resolve) => {
            if (!this.server) return resolve();
            this.server.close(() => resolve());
        });
        this.server = null;
    }
}

/**
 * The service with its three seams controlled: the clock (so a 600 s window costs no wall time), the
 * DNS lookup, and `fetch` (so an undici-shaped certificate error reaches the real classifier).
 */
class TestSmoke extends AppPublicSmokeService {
    readonly sleeps: number[] = [];
    readonly resolved: string[] = [];
    readonly fetches: Array<{ url: string; init?: RequestInit }> = [];
    /** When set, `now()` reads this counter instead of the wall clock. */
    clock: number | null = null;
    tick = 0;
    addresses: string[] = [];
    failWith: unknown = null;

    protected now(): number {
        if (this.clock === null) return Date.now();
        return this.clock;
    }

    protected async sleep(ms: number): Promise<void> {
        this.sleeps.push(ms);
        this.tick += ms;
        if (this.clock !== null) this.clock += ms;
    }

    protected async resolveHostAddresses(host: string): Promise<string[]> {
        this.resolved.push(host);
        return this.addresses;
    }

    protected fetchImpl: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        this.fetches.push({ url: String(input), init });
        if (this.failWith) throw this.failWith;

        return await fetch(input, init);
    };

    /** The seam is `protected` on the service; a case sets it to drive a synthetic failure. */
    setFetch(impl: typeof fetch): void {
        this.fetchImpl = impl;
    }
}

/** A check, with §4.8's defaults unless a case says otherwise. */
function check(overrides: Partial<AppSmokeInput> = {}): AppSmokeInput {
    return {
        name: 'health',
        component: 'web',
        http: { path: '/health' },
        ...overrides,
    } as AppSmokeInput;
}

/** An undici-shaped rejection: `TypeError: fetch failed` wrapping the real socket error. */
function fetchFailure(code: string, message = 'fetch failed'): Error {
    const cause = Object.assign(new Error(code), { code });
    return Object.assign(new TypeError(message), { cause });
}

describe('AppPublicSmokeService (APW-06 T23)', () => {
    const live: LiveServer[] = [];
    const broken: BrokenTlsServer[] = [];

    afterEach(async () => {
        await Promise.all(live.splice(0).map((server) => server.close()));
        await Promise.all(broken.splice(0).map((server) => server.close()));
        jest.restoreAllMocks();
    });

    async function serve(
        handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
    ): Promise<LiveServer> {
        const server = await LiveServer.start(handler);
        live.push(server);
        return server;
    }

    async function serveTlsGarbage(): Promise<BrokenTlsServer> {
        const server = await BrokenTlsServer.start();
        broken.push(server);
        return server;
    }

    /**
     * The ingress address the windowed cases pin, matching what `TestSmoke.resolveHostAddresses`
     * answers for `app.example.com`. A documentation-range address (RFC 5737 TEST-NET-2), so it
     * can never be a real host if a case ever escapes the seam.
     */
    const CLOCKED_INGRESS_IP = '198.51.100.4';

    /**
     * A one-attempt request: `windowSeconds: 1` keeps a failing case from retrying for real.
     *
     * `ingressAddresses` defaults to `['127.0.0.1']` because every live server in this file
     * listens on `127.0.0.1` (`LiveServer.start` → `listen(0, '127.0.0.1')`), and because an
     * EMPTY list is no longer a skipped gate — since 2026-09-21 it is a refusal
     * (`dnsVerdict` answers `pointing: false`, `attempt` fails every check
     * `dns_not_pointing`). Supplying the address here is what the real caller does
     * (`app-health.service.ts:1232`), so the cases below go on testing what they were written
     * to test — latency, classification, redaction, retries — instead of tripping the DNS
     * gate. The cases that are ABOUT the gate pass their own `ingressAddresses` and override
     * this.
     */
    function request(overrides: Partial<AppPublicSmokeRequest> = {}): AppPublicSmokeRequest {
        return {
            workId: '11111111-1111-4111-8111-111111111111',
            urls: ['http://127.0.0.1:1/'],
            checks: [check()],
            windowSeconds: 1,
            ingressAddresses: ['127.0.0.1'],
            ...overrides,
        };
    }

    /* ---------------------------------------------------------------------- *
     * The numbers of §5.3, and the two defaults that must match the runner
     * ---------------------------------------------------------------------- */

    describe('windows and defaults (§5.3, FR-26 step 7)', () => {
        it('answers 600 s on the first publish and 180 s afterwards', () => {
            expect(publicSmokeWindowSeconds(true)).toBe(600);
            expect(publicSmokeWindowSeconds(false)).toBe(180);
            expect(publicSmokeWindowSeconds(true)).toBe(APP_SMOKE_PUBLIC_FIRST_WINDOW_S);
            expect(publicSmokeWindowSeconds(false)).toBe(APP_SMOKE_PUBLIC_WINDOW_S);
        });

        it('retries every 10 s and caps the attempts so the window loop is finite', () => {
            expect(APP_SMOKE_RETRY_S).toBe(10);
            // 600 s ÷ 10 s + 1: the cap can never be reached by a clock that moves, and it is what
            // stops a clock that does not.
            expect(APP_PUBLIC_SMOKE_MAX_ATTEMPTS).toBe(61);
        });

        it('keeps §4.8’s three defaults identical to the in-cluster runner’s', () => {
            const script = fs.readFileSync(
                path.join(
                    __dirname,
                    '..',
                    '..',
                    '..',
                    '..',
                    'plugins',
                    'k8s',
                    'src',
                    'app',
                    'app-runner.script.ts',
                ),
                'utf8',
            );

            expect(APP_SMOKE_DEFAULT_STATUS).toEqual([200, 201, 204]);
            expect(APP_SMOKE_DEFAULT_LATENCY_MS).toBe(10_000);
            expect(APP_SMOKE_BODY_BYTES).toBe(1_048_576);
            expect(APP_SMOKE_FOUND_CHARS).toBe(200);

            // The runner writes the same four as its own constants; a drift on either side is a
            // public check that judges a body the other half judged differently.
            expect(script).toContain('var MAX_BODY_BYTES = 1048576;');
            expect(script).toContain('var FOUND_CHARS = 200;');
            expect(script).toContain('var DEFAULT_STATUS = [200, 201, 204];');
            expect(script).toContain('var DEFAULT_LATENCY_MS = 10000;');
            expect(script).toContain(
                "var init = { method: String((request && request.method) || 'POST'), redirect: 'manual'",
            );
        });

        it('names the four classifications and marks exactly one of them health-relevant', () => {
            expect(APP_PUBLIC_SMOKE_WARNING_CODES).toEqual([
                'dns_not_pointing',
                'tls_not_ready',
                'unreachable',
            ]);
            expect(APP_PUBLIC_SMOKE_HEALTH_CODE).toBe('check_failed');
            expect(APP_PUBLIC_SMOKE_WARNING_CODES).not.toContain('check_failed');
        });
    });

    /* ---------------------------------------------------------------------- *
     * The live HTTP half
     * ---------------------------------------------------------------------- */

    describe('over the public address (FR-36)', () => {
        it('passes when every expectation holds, and reports one attempt', async () => {
            const server = await serve((_request, response) => {
                response.writeHead(200, { 'content-type': 'text/plain' });
                response.end('ever-works is up');
            });

            const smoke = new TestSmoke();
            const run = await smoke.run(
                request({
                    urls: [server.url],
                    checks: [
                        check({
                            name: 'home',
                            expect: { status: [200], bodyContains: ['is up'], maxLatencyMs: 5_000 },
                        }),
                    ],
                }),
            );

            expect(run.passed).toBe(true);
            expect(run.outcome).toBe('passed');
            expect(run.attempts).toBe(1);
            expect(run.warnings).toEqual([]);
            expect(run.failures).toEqual([]);
            expect(run.healthRelevant).toBe(false);
            expect(run.checks).toEqual([
                { name: 'home', status: 'passed', httpStatus: 200, latencyMs: expect.any(Number) },
            ]);
        });

        it('never follows a redirect: a 302 is judged by its own status (FR-36)', async () => {
            const server = await serve((_request, response) => {
                response.writeHead(302, { location: '/elsewhere' });
                response.end();
            });
            const smoke = new TestSmoke();

            const run = await smoke.run(
                request({ urls: [server.url], checks: [check({ name: 'home' })] }),
            );

            expect(smoke.fetches).toHaveLength(1);
            for (const sent of smoke.fetches) expect(sent.init?.redirect).toBe('manual');
            expect(server.requests).toHaveLength(1);
            expect(server.requests[0].url).toBe('/health');
            expect(run.checks[0]).toMatchObject({
                name: 'home',
                status: 'failed',
                httpStatus: 302,
                classification: 'check_failed',
                failedExpectation: 'status is one of 200, 201, 204 but was 302',
            });
        });

        it('classifies a body mismatch `check_failed`, quoting at most 200 characters', async () => {
            // S7's own shape: the login page must not have been baked with a build-time address.
            const body = `<!doctype html><title>Welcome</title><script>api("http://localhost:3000")</script>`;
            const server = await serve((_request, response) => {
                response.writeHead(200, { 'content-type': 'text/html' });
                response.end(body);
            });
            const smoke = new TestSmoke();

            const run = await smoke.run(
                request({
                    urls: [server.url],
                    checks: [
                        check({
                            name: 'login',
                            expect: { status: [200], bodyNotContains: ['localhost:3000'] },
                        }),
                    ],
                }),
            );

            const failed = run.checks[0];
            expect(failed.status).toBe('failed');
            expect(failed.classification).toBe('check_failed');
            expect(failed.failedExpectation).toBe('body must not contain "localhost:3000"');
            expect(failed.found).toContain('localhost:3000');
            expect(run.outcome).toBe('failed');
            expect(run.healthRelevant).toBe(true);
            expect(run.failures).toHaveLength(1);
            expect(run.failures[0]).toMatchObject({ code: 'check_failed', check: 'login' });
        });

        it('quotes the string that was found, never a body beyond 200 characters', async () => {
            const server = await serve((_request, response) => {
                response.writeHead(200);
                response.end(`prefix ${'y'.repeat(500)} localhost:3000 ${'z'.repeat(500)}`);
            });
            const smoke = new TestSmoke();

            const run = await smoke.run(
                request({
                    urls: [server.url],
                    checks: [
                        check({
                            name: 'login',
                            expect: { bodyNotContains: ['localhost:3000'] },
                        }),
                    ],
                }),
            );

            const found = run.checks[0].found ?? '';
            expect(found).toContain('localhost:3000');
            expect(found.length).toBeLessThanOrEqual(APP_SMOKE_FOUND_CHARS);
            expect(found).toContain('…');

            // Nothing the service returns carries a longer body: every string on the result is
            // either the excerpt or a short message.
            const longest = longestString(run);
            expect(longest.length).toBeLessThanOrEqual(APP_SMOKE_FOUND_CHARS);
        });

        it('reads at most the first 1 MiB, so a marker beyond the cap is never judged', async () => {
            const marker = 'SECRET-MARKER-AFTER-THE-CAP';
            const server = await serve((_request, response) => {
                response.writeHead(200);
                response.write('a'.repeat(APP_SMOKE_BODY_BYTES));
                response.end(marker);
            });
            const smoke = new TestSmoke();

            const run = await smoke.run(
                request({
                    urls: [server.url],
                    checks: [check({ name: 'big', expect: { bodyNotContains: [marker] } })],
                }),
            );

            expect(run.checks[0].status).toBe('passed');
            expect(run.checks[0].found).toBeUndefined();
        });

        it('scrubs a secret value out of the excerpt (FR-37, Constitution VII)', async () => {
            const secret = 'sk-live-0123456789abcdef';
            const server = await serve((_request, response) => {
                response.writeHead(200);
                response.end(`somewhere ${secret} is the answer`);
            });
            const smoke = new TestSmoke();

            const run = await smoke.run(
                request({
                    urls: [server.url],
                    checks: [check({ name: 'leak', expect: { bodyNotContains: [secret] } })],
                    secretValues: [secret],
                }),
            );

            const found = run.checks[0].found ?? '';
            expect(found).not.toContain(secret);
            expect(found).toContain(APP_SMOKE_REDACTED);
        });

        it('fails a check that answers slower than its own latency limit — not `unreachable`', async () => {
            const server = await serve((_request, response) => {
                setTimeout(() => {
                    response.writeHead(200);
                    response.end('late');
                }, 400);
            });
            const smoke = new TestSmoke();

            const run = await smoke.run(
                request({
                    urls: [server.url],
                    checks: [check({ name: 'slow', expect: { maxLatencyMs: 50 } })],
                }),
            );

            expect(run.checks[0]).toMatchObject({ name: 'slow', status: 'failed' });
            expect(run.checks[0].classification).toBe('check_failed');
            expect(run.checks[0].failedExpectation).toBe(
                'latency must be at most 50 ms but the request did not answer within 50 ms',
            );
            expect(run.healthRelevant).toBe(true);
        });

        it('sends a POST check’s JSON body, and one request per check', async () => {
            const server = await serve((_request, response) => {
                response.writeHead(201);
                response.end('created');
            });
            const smoke = new TestSmoke();

            await smoke.run(
                request({
                    urls: [server.url],
                    checks: [
                        check({
                            name: 'seed',
                            http: { method: 'POST', path: '/seed', body: { rows: 2 } },
                            expect: { status: [201] },
                        }),
                    ],
                }),
            );

            expect(server.requests).toHaveLength(1);
            expect(server.requests[0]).toMatchObject({ method: 'POST', url: '/seed' });
            expect(server.requests[0].body).toBe('{"rows":2}');
            expect(server.requests[0].headers['content-type']).toBe('application/json');
        });
    });

    /* ---------------------------------------------------------------------- *
     * TLS — the live handshake failure, and every certificate code
     * ---------------------------------------------------------------------- */

    describe('TLS (plan §5.5, S18/S19, ACC-06-13)', () => {
        it('classifies a live TLS handshake failure `tls_not_ready`', async () => {
            const server = await serveTlsGarbage();
            const smoke = new TestSmoke();

            const run = await smoke.run(
                request({ urls: [server.url], checks: [check({ name: 'home' })] }),
            );

            expect(run.checks[0].status).toBe('failed');
            expect(run.checks[0].classification).toBe('tls_not_ready');
            // ACC-06-13: a warning, never a failure — nothing here may roll a Deployment back.
            expect(run.outcome).toBe('warnings');
            expect(run.passed).toBe(false);
            expect(run.failures).toEqual([]);
            expect(run.healthRelevant).toBe(false);
            expect(run.warnings).toEqual([
                expect.objectContaining({ code: 'tls_not_ready', check: 'home' }),
            ]);
        });

        it('classifies a mismatched certificate `tls_not_ready` through the real fetch seam', async () => {
            const smoke = new TestSmoke();
            // The URL below is a NAME, and `request()`'s default expectation is `127.0.0.1`
            // (every live server in this file listens there). Resolve the name to it so the
            // DNS gate — §5.5's FIRST classification step, and a refusal since 2026-09-21 when
            // it cannot be satisfied — passes and this case reaches the TLS classification it
            // is about.
            smoke.addresses = ['127.0.0.1'];
            smoke.failWith = fetchFailure(
                'ERR_TLS_CERT_ALTNAME_INVALID',
                'Hostname/IP does not match certificate',
            );

            const run = await smoke.run(
                request({ urls: ['https://app.example.com/'], checks: [check({ name: 'home' })] }),
            );

            expect(run.checks[0]).toMatchObject({
                name: 'home',
                status: 'failed',
                classification: 'tls_not_ready',
            });
            expect(run.outcome).toBe('warnings');
            expect(run.failures).toEqual([]);
            expect(run.healthRelevant).toBe(false);
            expect(smoke.fetches[0].init?.redirect).toBe('manual');
        });

        it.each([
            ['ERR_TLS_CERT_ALTNAME_INVALID', 'a certificate for another host'],
            ['DEPTH_ZERO_SELF_SIGNED_CERT', 'a self-signed certificate'],
            ['SELF_SIGNED_CERT_IN_CHAIN', 'a self-signed chain'],
            ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'an unverifiable leaf'],
            ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'a missing issuer'],
            ['CERT_HAS_EXPIRED', 'an expired certificate'],
            ['ERR_SSL_PACKET_LENGTH_TOO_LONG', 'a plaintext answer to a ClientHello'],
            ['EPROTO', 'a protocol error during the handshake'],
        ])('classifies %s (%s) as tls_not_ready', (code) => {
            expect(classifyPublicSmokeError(fetchFailure(code))).toBe('tls_not_ready');
        });
    });

    /* ---------------------------------------------------------------------- *
     * DNS — the resolver returning another address
     * ---------------------------------------------------------------------- */

    describe('DNS (plan §5.5, S19, ACC-06-13)', () => {
        it('classifies every check `dns_not_pointing` without sending a request', async () => {
            const server = await serve((_request, response) => {
                response.writeHead(200);
                response.end('up');
            });
            const smoke = new TestSmoke();
            smoke.addresses = ['203.0.113.7'];

            const run = await smoke.run(
                request({
                    urls: ['http://app.example.com/'],
                    checks: [
                        check({ name: 'home' }),
                        check({ name: 'login', http: { path: '/login' } }),
                    ],
                    ingressAddresses: ['198.51.100.4'],
                }),
            );

            expect(smoke.resolved).toEqual(['app.example.com']);
            expect(smoke.fetches).toEqual([]);
            expect(server.requests).toEqual([]);
            expect(run.checks.map((entry) => entry.classification)).toEqual([
                'dns_not_pointing',
                'dns_not_pointing',
            ]);
            expect(run.dns).toEqual({
                host: 'app.example.com',
                addresses: ['203.0.113.7'],
                expected: ['198.51.100.4'],
                pointing: false,
            });
            expect(run.checks[0].failedExpectation).toBe(
                "app.example.com must resolve to the cluster's ingress address (198.51.100.4) " +
                    'but resolved to 203.0.113.7',
            );

            // ACC-06-13: "reported as warnings not failures" — nothing to roll back, nothing that
            // counts toward health, and S19 can show the record to create.
            expect(run.outcome).toBe('warnings');
            expect(run.failures).toEqual([]);
            expect(run.healthRelevant).toBe(false);
            expect(run.warnings.map((entry) => entry.code)).toEqual([
                'dns_not_pointing',
                'dns_not_pointing',
            ]);
        });

        it('runs the checks when the host does resolve to the ingress address', async () => {
            const server = await serve((_request, response) => {
                response.writeHead(200);
                response.end('up');
            });
            const smoke = new TestSmoke();
            smoke.addresses = ['198.51.100.4'];

            // A literal address is not looked up at all — the verdict compares the literal itself.
            const literal = await smoke.run(
                request({
                    urls: [server.url],
                    checks: [check({ name: 'home' })],
                    ingressAddresses: ['127.0.0.1'],
                }),
            );

            expect(literal.dns).toMatchObject({ host: '127.0.0.1', pointing: true });
            expect(smoke.resolved).toEqual([]);
            expect(literal.passed).toBe(true);
            expect(server.requests).toHaveLength(1);

            // …and a name that resolves to the ingress address goes through the resolver once.
            const named = new TestSmoke();
            named.addresses = ['198.51.100.4'];
            named.setFetch(async () => new Response('up', { status: 200 }));

            const byName = await named.run(
                request({
                    urls: ['https://app.example.com/'],
                    checks: [check({ name: 'home' })],
                    ingressAddresses: ['198.51.100.4'],
                }),
            );

            expect(named.resolved).toEqual(['app.example.com']);
            expect(byName.dns?.pointing).toBe(true);
            expect(byName.passed).toBe(true);
            expect(byName.checks[0]).toMatchObject({
                name: 'home',
                status: 'passed',
                httpStatus: 200,
            });
        });

        it('treats "the name does not resolve at all" as not pointing', async () => {
            const smoke = new TestSmoke();
            smoke.addresses = [];

            const run = await smoke.run(
                request({
                    urls: ['https://app.example.com/'],
                    checks: [check({ name: 'home' })],
                    ingressAddresses: ['198.51.100.4'],
                }),
            );

            expect(run.dns).toMatchObject({ addresses: [], pointing: false });
            expect(run.warnings[0].code).toBe('dns_not_pointing');
            expect(run.warnings[0].message).toContain('but resolved to nothing');
        });

        it('REFUSES the checks when no ingress address was supplied, rather than dialling unverified', async () => {
            // This case asserted the opposite until 2026-09-21 — `run.dns` null, no
            // resolution, `passed: true`. That was the vulnerability, not the contract: an
            // empty `ingressAddresses` is the DEFAULT (the field is optional, and
            // `app-health.service.ts:1232` supplies `[]` whenever the ingress address is not
            // yet known), so the one configuration that switched the DNS gate off was the one
            // every un-provisioned Work was in, and a cluster-privileged worker then dialled
            // whatever the member's host resolved to.
            //
            // The case is kept, with its expectation inverted and the reason stated, because
            // it is the only place that pins what an absent expectation list means.
            const server = await serve((_request, response) => {
                response.writeHead(200);
                response.end('up');
            });
            const smoke = new TestSmoke();
            smoke.addresses = ['203.0.113.7'];

            const run = await smoke.run(
                request({
                    urls: [server.url],
                    checks: [check({ name: 'home' })],
                    // Explicitly empty — this case IS the empty-list rule, and `request()`'s
                    // default supplies an address for every other case.
                    ingressAddresses: [],
                }),
            );

            expect(run.dns).not.toBeNull();
            expect(run.dns?.pointing).toBe(false);
            expect(run.dns?.expected).toEqual([]);
            expect(run.passed).toBe(false);
            expect(run.checks[0].classification).toBe('dns_not_pointing');
            expect(run.checks[0].failedExpectation).toContain('no ingress address was supplied');
            // Nothing was dialled: the refusal happens before the first request.
            expect(smoke.fetches).toEqual([]);
        });

        it('routes the service default fetch through the SSRF guard, not the bare global', () => {
            // The seam itself, asserted structurally: `AppPublicSmokeService`'s own
            // `fetchImpl` (the one a worker gets when it does NOT override the seam) must
            // refuse a private address. `TestSmoke` overrides the seam, so this case reads
            // the base class's default rather than a subclass's.
            const service = new AppPublicSmokeService();
            const impl = (service as unknown as { fetchImpl: typeof fetch }).fetchImpl;

            return expect(impl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow();
        });
    });

    /* ---------------------------------------------------------------------- *
     * Unreachable
     * ---------------------------------------------------------------------- */

    describe('unreachable (plan §5.5)', () => {
        it('classifies a refused connection `unreachable`, as a warning', async () => {
            const server = await serve((_request, response) => response.end('up'));
            const origin = server.origin;
            await server.close();

            const smoke = new TestSmoke();
            const run = await smoke.run(
                request({ urls: [`${origin}/`], checks: [check({ name: 'home' })] }),
            );

            expect(run.checks[0].status).toBe('failed');
            expect(run.checks[0].classification).toBe('unreachable');
            expect(run.outcome).toBe('warnings');
            expect(run.failures).toEqual([]);
            expect(run.healthRelevant).toBe(false);
        });

        it.each([
            ['ECONNREFUSED', 'unreachable'],
            ['ECONNRESET', 'unreachable'],
            ['ETIMEDOUT', 'unreachable'],
            ['EHOSTUNREACH', 'unreachable'],
            ['UND_ERR_CONNECT_TIMEOUT', 'unreachable'],
            ['UND_ERR_SOCKET', 'unreachable'],
            ['EAI_AGAIN', 'unreachable'],
            ['ENOTFOUND', 'dns_not_pointing'],
            ['EAI_NONAME', 'dns_not_pointing'],
        ])('classifies %s as %s', (code, expected) => {
            expect(classifyPublicSmokeError(fetchFailure(code))).toBe(expected);
        });

        it('walks the cause chain, and defaults to unreachable for anything unknown', () => {
            expect(
                errorCodes(
                    Object.assign(new TypeError('fetch failed'), {
                        cause: Object.assign(new Error('socket'), {
                            cause: Object.assign(new Error('tls'), {
                                code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
                            }),
                        }),
                    }),
                ),
            ).toEqual(['depth_zero_self_signed_cert']);

            expect(classifyPublicSmokeError(new Error('something else'))).toBe('unreachable');
            expect(classifyPublicSmokeError(null)).toBe('unreachable');
        });
    });

    /* ---------------------------------------------------------------------- *
     * Windows and retries — the fake clock
     * ---------------------------------------------------------------------- */

    describe('windows and retries (600 s / 180 s, every 10 s)', () => {
        /** A service whose clock only moves when it sleeps, and a check that fails until told not to. */
        function clocked(outcomes: boolean[]): {
            smoke: TestSmoke;
            run: (
                overrides?: Partial<AppPublicSmokeRequest>,
            ) => Promise<Awaited<ReturnType<TestSmoke['run']>>>;
        } {
            const smoke = new TestSmoke();
            smoke.clock = 1_000_000;
            // `app.example.com` is a NAME, so the DNS verdict resolves it through the seam.
            // Both halves are supplied so the gate passes and these cases go on measuring the
            // window and the retry cadence: an empty `ingressAddresses` is a refusal since
            // 2026-09-21, and a name that resolves to nothing is `dns_not_pointing`.
            smoke.addresses = [CLOCKED_INGRESS_IP];
            let call = 0;
            smoke.setFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
                smoke.fetches.push({ url: String(input), init });
                const ok = outcomes[Math.min(call, outcomes.length - 1)];
                call += 1;

                return new Response(ok ? 'up' : 'down', { status: ok ? 200 : 503 });
            });

            return {
                smoke,
                // Deliberately not the shared `request()` helper: that one pins `windowSeconds: 1`
                // to keep a real failing case to one attempt, and these cases are about the window.
                run: (overrides = {}) =>
                    smoke.run({
                        workId: '11111111-1111-4111-8111-111111111111',
                        urls: ['https://app.example.com/'],
                        checks: [check({ name: 'home', expect: { status: [200] } })],
                        ingressAddresses: [CLOCKED_INGRESS_IP],
                        ...overrides,
                    }),
            };
        }

        it('stops at the first passing attempt and sleeps not at all', async () => {
            const { smoke, run } = clocked([true]);
            const result = await run();

            expect(result.attempts).toBe(1);
            expect(result.passed).toBe(true);
            expect(smoke.sleeps).toEqual([]);
        });

        it('retries every 10 s until a check passes — the third attempt here', async () => {
            const { smoke, run } = clocked([false, false, true]);
            const result = await run();

            expect(result.attempts).toBe(3);
            expect(result.passed).toBe(true);
            expect(smoke.sleeps).toEqual([10_000, 10_000]);
        });

        it('uses 600 s on the first publish: 60 attempts, 59 waits of 10 s', async () => {
            const { smoke, run } = clocked([false]);
            const result = await run({
                windowSeconds: undefined,
                isFirstDeploymentOnCluster: true,
            });

            expect(result.windowSeconds).toBe(600);
            expect(result.attempts).toBe(60);
            expect(smoke.sleeps).toHaveLength(59);
            expect(smoke.sleeps.every((ms) => ms === 10_000)).toBe(true);
            expect(smoke.tick).toBe(590_000);
            expect(result.passed).toBe(false);
        });

        it('uses 180 s on every later publish: 18 attempts', async () => {
            const { smoke, run } = clocked([false]);
            const result = await run({
                windowSeconds: undefined,
                isFirstDeploymentOnCluster: false,
            });

            expect(result.windowSeconds).toBe(180);
            expect(result.attempts).toBe(18);
            expect(smoke.sleeps).toHaveLength(17);
            expect(smoke.tick).toBe(170_000);
        });

        it('lets the caller’s own window win over the pair', async () => {
            const { smoke, run } = clocked([false]);
            const result = await run({ windowSeconds: 30 });

            expect(result.windowSeconds).toBe(30);
            expect(result.attempts).toBe(3);
            expect(smoke.tick).toBe(20_000);
        });
    });

    /* ---------------------------------------------------------------------- *
     * The check set, the empty run and the in-cluster half
     * ---------------------------------------------------------------------- */

    describe('the check set (FR-36) and the result channels', () => {
        it('runs a `first-deploy` check on the first Deployment only', async () => {
            const always = check({ name: 'always' });
            const first = check({ name: 'first', when: 'first-deploy' });

            expect(smokeChecksFor(false, [always, first])).toEqual([always]);
            expect(smokeChecksFor(undefined, [always, first])).toEqual([always]);
            expect(smokeChecksFor(true, [always, first])).toEqual([always, first]);
            expect(smokeChecksFor(true, [check({ name: 'plain', when: 'always' })])).toHaveLength(
                1,
            );
        });

        it('leaves a `first-deploy` check out of a later Deployment’s public run', async () => {
            const server = await serve((_request, response) => response.end('up'));
            const smoke = new TestSmoke();

            const run = await smoke.run(
                request({
                    urls: [server.url],
                    checks: [
                        check({ name: 'always' }),
                        check({ name: 'first', when: 'first-deploy' }),
                    ],
                    isFirstDeploymentOnCluster: false,
                }),
            );

            expect(run.checks.map((entry) => entry.name)).toEqual(['always']);
            expect(server.requests).toHaveLength(1);
        });

        it('answers an empty passing run when nothing was published or nothing applies', async () => {
            const smoke = new TestSmoke();

            for (const empty of [
                request({ urls: [] }),
                request({ urls: ['not-a-url'] }),
                request({ checks: [] }),
            ]) {
                const run = await smoke.run(empty);
                expect(run).toMatchObject({
                    checks: [],
                    passed: true,
                    outcome: 'passed',
                    attempts: 0,
                    dns: null,
                    healthRelevant: false,
                });
            }

            expect(smoke.fetches).toEqual([]);
        });

        it('counts a `check_failed` toward health only while in-cluster did not fail (FR-37)', async () => {
            const server = await serve((_request, response) => {
                response.writeHead(503);
                response.end('down');
            });
            const failing: CheckResult = {
                name: 'home',
                status: 'failed',
                classification: 'check_failed',
                failedExpectation: 'status is one of 200 but was 503',
            };
            const smoke = new TestSmoke();

            const withoutPeer = await smoke.run(
                request({
                    urls: [server.url],
                    checks: [check({ name: 'home', expect: { status: [200] } })],
                }),
            );
            expect(withoutPeer.failures).toEqual([
                expect.objectContaining({ check: 'home', healthRelevant: true }),
            ]);
            expect(withoutPeer.healthRelevant).toBe(true);

            const peerFailed = await smoke.run(
                request({
                    urls: [server.url],
                    checks: [check({ name: 'home', expect: { status: [200] } })],
                    inCluster: [{ ...failing }],
                }),
            );
            expect(peerFailed.failures).toEqual([
                expect.objectContaining({ check: 'home', healthRelevant: false }),
            ]);
            expect(peerFailed.healthRelevant).toBe(false);
        });

        it('reports a `passed` run as the plugin’s own `AppSmokeRun` shape', async () => {
            const server = await serve((_request, response) => response.end('up'));
            const smoke = new TestSmoke();

            const run = await smoke.run(
                request({ urls: [server.url], checks: [check({ name: 'home' })] }),
            );

            // What `hooks.verifyPublic` returns to `deployApp`: only `checks` and `passed` are read
            // by the plugin (`app-deployer.ts:1631-1645`), and both are present and well-typed.
            expect(run).toMatchObject({ checks: expect.any(Array), passed: true });
            expect(run.observedAt).toEqual(expect.any(String));
            expect(new Date(run.observedAt).toString()).not.toBe('Invalid Date');
        });
    });

    /* ---------------------------------------------------------------------- *
     * The pure helpers
     * ---------------------------------------------------------------------- */

    describe('pure helpers', () => {
        it('reads a check’s expectations with §4.8’s defaults', () => {
            expect(expectationsOf(check())).toEqual({
                method: 'GET',
                headers: { accept: '*/*' },
                body: undefined,
                status: [200, 201, 204],
                bodyContains: [],
                bodyNotContains: [],
                maxLatencyMs: 10_000,
            });

            expect(
                expectationsOf(
                    check({
                        http: { method: 'POST', path: '/seed', body: { a: 1 } },
                        expect: { status: [204], bodyContains: ['ok'], maxLatencyMs: 1_500 },
                    }),
                ),
            ).toMatchObject({
                method: 'POST',
                body: '{"a":1}',
                status: [204],
                bodyContains: ['ok'],
                maxLatencyMs: 1_500,
            });
        });

        it('judges in the runner’s order: status, latency, contains, not-contains', () => {
            const expectations = expectationsOf(
                check({ expect: { status: [200], bodyContains: ['ok'], maxLatencyMs: 100 } }),
            );

            expect(judge('c', 500, 'ok', 5, expectations)).toMatchObject({
                status: 'failed',
                failedExpectation: 'status is one of 200 but was 500',
            });
            expect(judge('c', 200, 'ok', 500, expectations)).toMatchObject({
                status: 'failed',
                failedExpectation: 'latency must be at most 100 ms but was 500 ms',
            });
            expect(judge('c', 200, 'nope', 5, expectations)).toMatchObject({
                status: 'failed',
                failedExpectation: 'body must contain "ok"',
                found: 'nope',
            });
            expect(judge('c', 200, 'ok', 5, expectations).status).toBe('passed');
        });

        it('truncates an excerpt to 200 characters around the offending string', () => {
            const text = `${'a'.repeat(300)}NEEDLE${'b'.repeat(300)}`;
            const found = excerpt(text, text.indexOf('NEEDLE'));

            expect(found).toContain('NEEDLE');
            expect(found.length).toBeLessThanOrEqual(APP_SMOKE_FOUND_CHARS);
            expect(found.startsWith('…')).toBe(true);
            expect(found.endsWith('…')).toBe(true);

            expect(excerpt('short')).toBe('short');
            expect(excerpt('')).toBe('');
        });

        it('scrubs the longest secret first and leaves other text alone', () => {
            expect(scrubSecrets('a TOKEN-1234567890 b', ['TOKEN-1234567890'])).toBe(
                `a ${APP_SMOKE_REDACTED} b`,
            );
            expect(scrubSecrets('x', [])).toBe('x');
            expect(scrubSecrets('', ['x'])).toBe('');
        });

        it('accepts only a usable published URL', () => {
            expect(firstUrl(['https://app.example.com/'])?.hostname).toBe('app.example.com');
            expect(firstUrl(['', '  ', 'nonsense', 'http://ok.example.com/'])?.hostname).toBe(
                'ok.example.com',
            );
            expect(firstUrl([])).toBeNull();
            expect(firstUrl(undefined)).toBeNull();
        });

        it('names a check even when its name is missing, and defaults a failed classification', () => {
            expect(checkName(check({ name: 'home' }))).toBe('home');
            expect(checkName(check({ name: '   ' }))).toBe('check');
            expect(checkName(null)).toBe('check');
            expect(classificationOf({ name: 'x', status: 'failed' })).toBe('check_failed');
            expect(
                classificationOf({ name: 'x', status: 'failed', classification: 'tls_not_ready' }),
            ).toBe('tls_not_ready');
        });

        it('caps a streamed body at the byte limit and cancels the rest', async () => {
            const response = new Response(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new Uint8Array(10));
                        controller.enqueue(new Uint8Array(10));
                        controller.close();
                    },
                }),
            );

            const read = await readCapped(response, 15);
            expect(read.bytes).toBe(15);
            expect(read.truncated).toBe(true);
            expect(read.text).toHaveLength(15);

            const whole = await readCapped(new Response('hello'), 15);
            expect(whole).toEqual({ text: 'hello', bytes: 5, truncated: false });
        });

        it('keeps the classification type assignable to the plugin’s own union', () => {
            // A type-level pin: `AppPublicSmokeClassification` and `CheckResult['classification']`
            // must stay mutually assignable, or a classification this service produces could not be
            // put on a `CheckResult` the plugin reads.
            const fromService: AppPublicSmokeClassification = 'dns_not_pointing';
            const onCheck: NonNullable<CheckResult['classification']> = fromService;
            const back: AppPublicSmokeClassification = onCheck;

            expect(back).toBe('dns_not_pointing');
        });
    });
});

/** The longest string anywhere on a result — the assertion that no body left the service. */
function longestString(value: unknown, seen = new Set<unknown>()): string {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object' || seen.has(value)) return '';
    seen.add(value);

    let longest = '';
    for (const entry of Array.isArray(value) ? value : Object.values(value)) {
        const candidate = longestString(entry, seen);
        if (candidate.length > longest.length) longest = candidate;
    }

    return longest;
}
