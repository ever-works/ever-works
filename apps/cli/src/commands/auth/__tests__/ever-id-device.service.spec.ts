import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialsService } from '../credentials.service';
import { runEverIdDeviceLogin, type EverIdFetch } from '../ever-id-device.service';

/**
 * Sign in with Ever ID using a code (APW-12: S8, S23, FR-39 to FR-43, ACC-12-28,
 * ACC-12-31; spec §6.6).
 *
 * Ever ID, the Ever Works API and the clock are faked, so the 5-second polling and the
 * 900-second expiry run instantly. Everything the flow prints — on stdout, on stderr or
 * through any console method — is captured, so the "never printed" assertions cover the
 * whole terminal rather than the lines the flow meant to print.
 */

const fsMocks = vi.hoisted(() => ({
    ensureDir: vi.fn(),
    writeJson: vi.fn(),
    chmod: vi.fn(),
    readJson: vi.fn(),
    pathExists: vi.fn(),
    remove: vi.fn(),
}));

vi.mock('fs-extra', () => ({ default: fsMocks, ...fsMocks }));

const API_URL = 'https://api.example.test';
const ISSUER = 'https://id.example.test';
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const DEVICE_ENDPOINT = `${ISSUER}/oauth/v2/device_authorization`;
const TOKEN_ENDPOINT = `${ISSUER}/oauth/v2/token`;
const VERIFICATION_URI = `${ISSUER}/device`;
const CLI_CLIENT_ID = 'cli-client-id';
const USER_CODE = 'WDJB-MJHT';
const DEVICE_CODE = 'device-code-Zx9QpL3mVt7Rw2Kc4Hn8';
const ACCESS_TOKEN = 'ever-id-access-token-9f8e7d6c5b4a3210';

function jwt(payload: Record<string, unknown>): string {
    const encode = (part: unknown) => Buffer.from(JSON.stringify(part)).toString('base64url');
    return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.session-signature`;
}

const SESSION_TOKEN = jwt({
    sub: 'user-1',
    email: 'alice@example.com',
    username: 'alice',
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
});

/** Never printed, never put in an address. */
const SECRETS = [DEVICE_CODE, ACCESS_TOKEN, SESSION_TOKEN];

/** Fake-clock origin; every step before polling happens at this instant. */
const START = 1_000_000;

/**
 * Far above the 180 polls a 900-second code allows at the 5-second floor. Past it the
 * fake stops answering, so a flow that never stops polling fails instead of spinning
 * on the fake clock forever.
 */
const MAX_REQUESTS = 1_000;

type Reply = Awaited<ReturnType<EverIdFetch>>;

interface RecordedRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    /** Fake-clock time at which the request was sent. */
    at: number;
}

type Route = (request: RecordedRequest) => Reply;

function reply(status: number, body?: unknown, headers: Record<string, string> = {}): Reply {
    const byName = new Map(
        Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => byName.get(name.toLowerCase()) ?? null },
        text: async () => (body === undefined ? '' : JSON.stringify(body)),
    };
}

function apiError(status: number, code: string): Reply {
    return reply(status, { status: 'error', code, message: `Refused (${code}).` });
}

const pending = () => reply(400, { error: 'authorization_pending' });
const slowDown = () => reply(400, { error: 'slow_down' });
const issued = () =>
    reply(200, { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 900 });
const unreachable: Route = () => {
    throw new TypeError('fetch failed');
};

/** Answers the token endpoint with `replies` in order, then keeps repeating the last one. */
function tokenReplies(...replies: Array<Reply | 'unreachable'>): Route {
    let index = 0;
    return (request) => {
        const next = replies[Math.min(index, replies.length - 1)];
        index += 1;
        return next === 'unreachable' ? unreachable(request) : next;
    };
}

function deviceGrant(overrides: Record<string, unknown> = {}): Route {
    return () =>
        reply(200, {
            device_code: DEVICE_CODE,
            user_code: USER_CODE,
            verification_uri: VERIFICATION_URI,
            verification_uri_complete: `${VERIFICATION_URI}?user_code=${USER_CODE}`,
            expires_in: 900,
            interval: 5,
            ...overrides,
        });
}

interface Routes {
    clientConfig: Route;
    discovery: Route;
    device: Route;
    token: Route;
    session: Route;
}

interface World {
    apiUrl: string;
    fetch: EverIdFetch;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    sleeps: number[];
    requests: RecordedRequest[];
}

function world(routes: Partial<Routes> = {}, apiUrl = API_URL): World {
    let clock = START;
    const sleeps: number[] = [];
    const requests: RecordedRequest[] = [];
    const api = `${apiUrl.replace(/\/+$/, '').replace(/\/api$/, '')}/api/auth/ever-id`;
    const table: Record<string, Route> = {
        [`${api}/client-config`]:
            routes.clientConfig ??
            (() =>
                reply(200, {
                    issuer: ISSUER,
                    localClients: [
                        { kind: 'node', clientId: 'node-client-id' },
                        { kind: 'cli', clientId: CLI_CLIENT_ID },
                    ],
                    scopes: ['openid', 'email', 'ever-works:session'],
                })),
        [DISCOVERY_URL]:
            routes.discovery ??
            (() =>
                reply(200, {
                    issuer: ISSUER,
                    authorization_endpoint: `${ISSUER}/oauth/v2/authorize`,
                    device_authorization_endpoint: DEVICE_ENDPOINT,
                    token_endpoint: TOKEN_ENDPOINT,
                    jwks_uri: `${ISSUER}/oauth/v2/keys`,
                })),
        [DEVICE_ENDPOINT]: routes.device ?? deviceGrant(),
        [TOKEN_ENDPOINT]: routes.token ?? tokenReplies(pending(), issued()),
        [`${api}/session`]:
            routes.session ??
            (() =>
                reply(200, {
                    access_token: SESSION_TOKEN,
                    user: { id: 'user-1', email: 'alice@example.com', username: 'alice' },
                })),
    };
    return {
        apiUrl,
        fetch: async (url, init) => {
            const request: RecordedRequest = {
                url,
                method: init.method,
                headers: init.headers,
                body: init.body,
                at: clock,
            };
            requests.push(request);
            if (requests.length > MAX_REQUESTS) {
                throw new Error('runaway polling');
            }
            const route = table[url];
            if (!route) {
                throw new Error(`unexpected request: ${init.method} ${url}`);
            }
            return route(request);
        },
        now: () => clock,
        sleep: async (ms) => {
            sleeps.push(ms);
            clock += ms;
        },
        sleeps,
        requests,
    };
}

function signIn(w: World): Promise<number> {
    return runEverIdDeviceLogin({ apiUrl: w.apiUrl, fetch: w.fetch, now: w.now, sleep: w.sleep });
}

function requestsTo(w: World, url: string): RecordedRequest[] {
    return w.requests.filter((request) => request.url === url);
}

function form(request: RecordedRequest): Record<string, string> {
    return Object.fromEntries(new URLSearchParams(request.body ?? ''));
}

const PROMPT = `To sign in, open  ${VERIFICATION_URI}  and enter the code:  ${USER_CODE}`;
const PROVIDER_UNAVAILABLE = `Ever ID isn't responding. Try "ever-works auth login" without --ever-id.`;
const UNAVAILABLE = `Ever ID isn't available on this server. Try "ever-works auth login" without --ever-id.`;
const EXPIRED = 'The code expired. Run the command again.';
const NOT_CONNECTED = 'Connect Ever ID to your Ever Works account in Settings → Security first.';

describe('runEverIdDeviceLogin', () => {
    let terminal: string[];
    let chalkLevel: typeof chalk.level;

    const lines = () => terminal;
    const lastLine = () => terminal[terminal.length - 1];

    beforeEach(() => {
        // Colour codes would otherwise depend on the terminal running the spec, and the
        // control-character assertions below must see exactly what the flow wrote.
        chalkLevel = chalk.level;
        chalk.level = 0;

        for (const mock of Object.values(fsMocks)) {
            mock.mockReset();
        }
        fsMocks.ensureDir.mockResolvedValue(undefined);
        fsMocks.writeJson.mockResolvedValue(undefined);
        fsMocks.chmod.mockResolvedValue(undefined);

        terminal = [];
        const record = (...args: unknown[]) => {
            terminal.push(args.map(String).join(' '));
        };
        for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
            vi.spyOn(console, method).mockImplementation(record);
        }
        const write = ((chunk: unknown) => {
            terminal.push(String(chunk));
            return true;
        }) as typeof process.stdout.write;
        vi.spyOn(process.stdout, 'write').mockImplementation(write);
        vi.spyOn(process.stderr, 'write').mockImplementation(write);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        chalk.level = chalkLevel;
    });

    describe('signing in', () => {
        it('shows only the verification address and the code, then signs in (spec §6.6)', async () => {
            const w = world();

            await expect(signIn(w)).resolves.toBe(0);

            expect(lines()).toEqual([
                PROMPT,
                'Waiting for approval… (expires in 15 minutes)',
                'Signed in as alice@example.com.',
            ]);
        });

        it('stores the session exactly where the browser sign-in stores it', async () => {
            const w = world();

            await signIn(w);

            expect(fsMocks.writeJson).toHaveBeenCalledTimes(1);
            expect(fsMocks.writeJson).toHaveBeenCalledWith(
                CredentialsService.credentialsPath,
                expect.objectContaining({
                    token: SESSION_TOKEN,
                    apiUrl: API_URL,
                    email: 'alice@example.com',
                    username: 'alice',
                }),
                { spaces: 2 },
            );
            expect(fsMocks.chmod).toHaveBeenCalledWith(CredentialsService.credentialsPath, 0o600);
        });

        it('reads the client config, discovers Ever ID and asks for exactly client_id and scope', async () => {
            const w = world();

            await signIn(w);

            const [config, discovery, device] = w.requests;
            expect(config).toMatchObject({
                method: 'GET',
                url: `${API_URL}/api/auth/ever-id/client-config`,
            });
            expect(discovery).toMatchObject({ method: 'GET', url: DISCOVERY_URL });
            expect(device).toMatchObject({ method: 'POST', url: DEVICE_ENDPOINT });
            expect(device.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
            // No `audience` and no `resource` (plan §7); the `cli` client, not the `node` one.
            expect(form(device)).toEqual({
                client_id: CLI_CLIENT_ID,
                scope: 'openid email ever-works:session',
            });
        });

        it('polls the token endpoint with the device code grant', async () => {
            const w = world();

            await signIn(w);

            const polls = requestsTo(w, TOKEN_ENDPOINT);
            expect(polls).toHaveLength(2);
            for (const poll of polls) {
                expect(poll.method).toBe('POST');
                expect(form(poll)).toEqual({
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                    device_code: DEVICE_CODE,
                    client_id: CLI_CLIENT_ID,
                });
            }
        });

        it('exchanges the Ever ID access token for a session with it as the bearer', async () => {
            const w = world();

            await signIn(w);

            const [exchange] = requestsTo(w, `${API_URL}/api/auth/ever-id/session`);
            expect(exchange.method).toBe('POST');
            expect(exchange.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
            // Nothing else carries the access token.
            const others = w.requests.filter((request) => request !== exchange);
            expect(JSON.stringify(others)).not.toContain(ACCESS_TOKEN);
        });

        it('accepts an API address that already ends in /api', async () => {
            const w = world({}, `${API_URL}/api/`);

            await expect(signIn(w)).resolves.toBe(0);
            expect(w.requests[0].url).toBe(`${API_URL}/api/auth/ever-id/client-config`);
        });

        it('accepts plain http to this machine, as local development needs', async () => {
            const w = world({}, 'http://localhost:3100');

            await expect(signIn(w)).resolves.toBe(0);
            expect(w.requests[0].url).toBe('http://localhost:3100/api/auth/ever-id/client-config');
        });

        it('names the account by its username when the API returns no e-mail address', async () => {
            const w = world({
                session: () =>
                    reply(200, {
                        access_token: SESSION_TOKEN,
                        user: { id: 'user-1', email: null, username: 'alice' },
                    }),
            });

            await expect(signIn(w)).resolves.toBe(0);
            expect(lastLine()).toBe('Signed in as alice.');
        });

        it('shows the remaining time in whole minutes', async () => {
            const w = world({ device: deviceGrant({ expires_in: 90 }) });

            await signIn(w);

            expect(lines()[1]).toBe('Waiting for approval… (expires in 1 minute)');
        });

        it('never shows the verification address that embeds the code', async () => {
            const w = world();

            await signIn(w);

            expect(lines().join('\n')).not.toContain('user_code=');
        });
    });

    describe('polling (FR-41, ACC-12-31)', () => {
        it.each([1, 0, -3, 4.9, undefined, 'fast'])(
            'never polls faster than every 5 seconds (interval %s)',
            async (interval) => {
                const w = world({
                    device: deviceGrant({ interval }),
                    token: tokenReplies(pending(), pending(), issued()),
                });

                await expect(signIn(w)).resolves.toBe(0);
                expect(w.sleeps).toEqual([5000, 5000, 5000]);
            },
        );

        it('honours a longer interval from Ever ID', async () => {
            const w = world({ device: deviceGrant({ interval: 12 }) });

            await signIn(w);

            expect(w.sleeps).toEqual([12_000, 12_000]);
        });

        it('adds 5 seconds for this and every later poll on each slow_down', async () => {
            const w = world({
                token: tokenReplies(slowDown(), slowDown(), pending(), issued()),
            });

            await expect(signIn(w)).resolves.toBe(0);
            expect(w.sleeps).toEqual([5000, 10_000, 15_000, 15_000]);
        });

        it('keeps polling while authorization is pending', async () => {
            const w = world({
                token: tokenReplies(pending(), pending(), pending(), pending(), issued()),
            });

            await expect(signIn(w)).resolves.toBe(0);
            expect(requestsTo(w, TOKEN_ENDPOINT)).toHaveLength(5);
        });

        it('prints "Signed in as …" within 5 seconds of the approval at Ever ID (S8, ACC-12-28)', async () => {
            const approvedAt = START + 37_000;
            const w = world({
                token: (request) => (request.at >= approvedAt ? issued() : pending()),
            });

            await expect(signIn(w)).resolves.toBe(0);

            const [exchange] = requestsTo(w, `${API_URL}/api/auth/ever-id/session`);
            expect(exchange.at - approvedAt).toBeGreaterThanOrEqual(0);
            expect(exchange.at - approvedAt).toBeLessThanOrEqual(5000);
            expect(lastLine()).toBe('Signed in as alice@example.com.');
        });

        it('backs off when a poll cannot reach Ever ID, then carries on', async () => {
            const w = world({ token: tokenReplies('unreachable', pending(), issued()) });

            await expect(signIn(w)).resolves.toBe(0);
            expect(w.sleeps).toEqual([5000, 10_000, 10_000]);
        });

        it('treats a 429 from the token endpoint like slow_down', async () => {
            const w = world({ token: tokenReplies(reply(429), issued()) });

            await expect(signIn(w)).resolves.toBe(0);
            expect(w.sleeps).toEqual([5000, 10_000]);
        });

        it('gives up after three polls in a row cannot reach Ever ID', async () => {
            const w = world({ token: tokenReplies('unreachable', reply(503), 'unreachable') });

            await expect(signIn(w)).resolves.toBe(1);
            expect(w.sleeps).toEqual([5000, 10_000, 20_000]);
            expect(lastLine()).toBe(PROVIDER_UNAVAILABLE);
        });
    });

    describe('expiry (FR-41)', () => {
        it('stops with "The code expired" when Ever ID says so', async () => {
            const w = world({
                token: tokenReplies(pending(), reply(400, { error: 'expired_token' })),
            });

            await expect(signIn(w)).resolves.toBe(1);
            expect(lastLine()).toBe(EXPIRED);
            expect(requestsTo(w, `${API_URL}/api/auth/ever-id/session`)).toHaveLength(0);
            expect(fsMocks.writeJson).not.toHaveBeenCalled();
        });

        it('stops when the code’s lifetime runs out', async () => {
            const w = world({ device: deviceGrant({ expires_in: 20 }), token: pending });

            await expect(signIn(w)).resolves.toBe(1);
            expect(lastLine()).toBe(EXPIRED);
            expect(requestsTo(w, TOKEN_ENDPOINT).map((poll) => poll.at - START)).toEqual([
                5000, 10_000, 15_000,
            ]);
        });

        it('never waits more than 900 seconds, whatever Ever ID answers', async () => {
            const w = world({ device: deviceGrant({ expires_in: 3600 }), token: pending });

            await expect(signIn(w)).resolves.toBe(1);
            expect(lastLine()).toBe(EXPIRED);
            expect(lines()[1]).toBe('Waiting for approval… (expires in 15 minutes)');
            const polls = requestsTo(w, TOKEN_ENDPOINT);
            expect(polls[polls.length - 1].at - START).toBeLessThan(900_000);
            expect(w.now() - START).toBe(900_000);
        });

        it('falls back to the 900-second ceiling when Ever ID gives no lifetime', async () => {
            const w = world({ device: deviceGrant({ expires_in: undefined }), token: pending });

            await expect(signIn(w)).resolves.toBe(1);
            expect(w.now() - START).toBe(900_000);
        });
    });

    describe('failures (exit code 1)', () => {
        it('stops when the person declines at Ever ID', async () => {
            const w = world({
                token: tokenReplies(pending(), reply(400, { error: 'access_denied' })),
            });

            await expect(signIn(w)).resolves.toBe(1);
            expect(lastLine()).toBe(
                'Sign-in was declined at Ever ID. Run the command again to retry.',
            );
            expect(fsMocks.writeJson).not.toHaveBeenCalled();
        });

        it('asks an unconnected Ever ID to be connected first and creates nothing (S23)', async () => {
            const w = world({ session: () => apiError(403, 'not_connected') });

            await expect(signIn(w)).resolves.toBe(1);
            expect(lastLine()).toBe(NOT_CONNECTED);
            expect(fsMocks.writeJson).not.toHaveBeenCalled();
        });

        it('says Ever ID is not available when the server has it turned off (404)', async () => {
            const w = world({ clientConfig: () => apiError(404, 'ever_id_disabled') });

            await expect(signIn(w)).resolves.toBe(1);
            expect(lastLine()).toBe(UNAVAILABLE);
            // Ever ID itself is never contacted.
            expect(w.requests.map((request) => request.url)).toEqual([
                `${API_URL}/api/auth/ever-id/client-config`,
            ]);
        });

        it.each<[string, Partial<Routes>]>([
            [
                'no client for the CLI',
                {
                    clientConfig: () =>
                        reply(200, {
                            issuer: ISSUER,
                            localClients: [{ kind: 'node', clientId: 'n' }],
                            scopes: [],
                        }),
                },
            ],
            [
                'no device authorization at Ever ID',
                { discovery: () => reply(200, { issuer: ISSUER, token_endpoint: TOKEN_ENDPOINT }) },
            ],
        ])('says Ever ID is not available when there is %s', async (_case, routes) => {
            const w = world(routes);

            await expect(signIn(w)).resolves.toBe(1);
            expect(lastLine()).toBe(UNAVAILABLE);
            expect(requestsTo(w, DEVICE_ENDPOINT)).toHaveLength(0);
        });

        it.each<[string, Partial<Routes>]>([
            ['discovery cannot be reached', { discovery: unreachable }],
            ['discovery fails', { discovery: () => reply(500) }],
            ['device authorization cannot be reached', { device: unreachable }],
            ['device authorization is unavailable', { device: () => reply(503) }],
            [
                'device authorization answers nonsense',
                { device: () => reply(200, { hello: 'world' }) },
            ],
            [
                'the API reports Ever ID unavailable',
                { session: () => apiError(503, 'provider_unavailable') },
            ],
        ])('says Ever ID is not responding when %s', async (_case, routes) => {
            const w = world(routes);

            await expect(signIn(w)).resolves.toBe(1);
            expect(lastLine()).toBe(PROVIDER_UNAVAILABLE);
            expect(fsMocks.writeJson).not.toHaveBeenCalled();
        });

        it.each<[string, Reply, string]>([
            [
                'a refused token',
                apiError(401, 'transaction_invalid'),
                'That sign-in expired or was already used. Run the command again.',
            ],
            ['a suspended account', apiError(403, 'account_disabled'), 'Account is suspended.'],
            ['the camelCase code spelling', apiError(403, 'notConnected'), NOT_CONNECTED],
            [
                'a rate limit with Retry-After',
                reply(429, undefined, { 'Retry-After': '30' }),
                'Too many attempts. Try again in 30 seconds.',
            ],
            [
                'a rate limit without Retry-After',
                reply(429),
                'Too many attempts. Try again in a minute.',
            ],
            [
                'an unexpected status',
                reply(500, { message: 'boom' }),
                'Ever ID sign-in failed (HTTP 500).',
            ],
            [
                'a session-less answer',
                reply(200, { user: { email: 'alice@example.com' } }),
                'Ever ID sign-in failed: the server sent an answer the CLI does not understand.',
            ],
        ])('reports %s from the exchange in one line', async (_case, answer, line) => {
            const w = world({ session: () => answer });

            await expect(signIn(w)).resolves.toBe(1);
            expect(lastLine()).toBe(line);
            expect(fsMocks.writeJson).not.toHaveBeenCalled();
        });

        it('says when the Ever Works API cannot be reached', async () => {
            const w = world({ clientConfig: unreachable });

            await expect(signIn(w)).resolves.toBe(1);
            expect(lastLine()).toBe('Could not reach Ever Works at https://api.example.test.');
        });

        it('reports a provider refusal by its error code', async () => {
            const w = world({ device: () => reply(400, { error: 'invalid_client' }) });

            await expect(signIn(w)).resolves.toBe(1);
            expect(lastLine()).toBe('Ever ID refused the sign-in request (invalid_client).');
        });

        it('rejects an --api-url that is not an address, before any request', async () => {
            const w = world({}, 'not a url');

            await expect(signIn(w)).resolves.toBe(1);
            expect(lastLine()).toBe('Invalid --api-url: not a url');
            expect(w.requests).toHaveLength(0);
        });

        it('refuses to send the Ever ID token over plain http to another machine', async () => {
            const w = world({}, 'http://api.example.test');

            await expect(signIn(w)).resolves.toBe(1);
            expect(lastLine()).toBe(
                'Refusing to send an Ever ID sign-in over insecure HTTP to a non-local host (api.example.test). Use an https:// API URL.',
            );
            expect(w.requests).toHaveLength(0);
        });

        it.each<[string, Partial<Routes>]>([
            [
                'issuer',
                {
                    clientConfig: () =>
                        reply(200, {
                            issuer: 'http://id.example.test',
                            localClients: [{ kind: 'cli', clientId: CLI_CLIENT_ID }],
                            scopes: [],
                        }),
                },
            ],
            [
                'token endpoint',
                {
                    discovery: () =>
                        reply(200, {
                            device_authorization_endpoint: DEVICE_ENDPOINT,
                            token_endpoint: 'http://id.example.test/token',
                        }),
                },
            ],
            [
                'verification address',
                { device: deviceGrant({ verification_uri: 'http://id.example.test/device' }) },
            ],
        ])('refuses an Ever ID %s on plain http', async (_case, routes) => {
            const w = world(routes);

            await expect(signIn(w)).resolves.toBe(1);
            expect(lastLine()).toBe(
                'Refusing to use Ever ID over insecure HTTP (id.example.test). Ask an administrator to check the Ever ID settings.',
            );
            expect(requestsTo(w, TOKEN_ENDPOINT)).toHaveLength(0);
        });

        it('does not treat a host that merely starts with "127." as this machine', async () => {
            const w = world({}, 'http://127.example.test');

            await expect(signIn(w)).resolves.toBe(1);
            expect(w.requests).toHaveLength(0);
        });

        it('strips control characters from what Ever ID sends before printing it', async () => {
            const refused = world({
                device: () =>
                    reply(400, { error: 'invalid_client\u001b[2J\u001b[H\r\n✓ Signed in' }),
            });
            await expect(signIn(refused)).resolves.toBe(1);

            const shown = world({
                device: deviceGrant({ user_code: '\u001b[31mWDJB\u0007-MJHT\u001b[0m' }),
            });
            await expect(signIn(shown)).resolves.toBe(0);

            const printed = terminal.join('\n');
            expect(printed).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
            expect(lines()[0]).toBe(
                'Ever ID refused the sign-in request (invalid_client [2J [H  ✓ Signed in).',
            );
        });
    });

    describe('secrets (FR-42, ACC-12-28)', () => {
        it.each<[string, Partial<Routes>]>([
            ['a successful sign-in', {}],
            ['an exchange the API refuses', { session: () => apiError(403, 'not_connected') }],
            [
                'an exchange whose error echoes the token',
                { session: () => reply(500, { message: `bad token ${ACCESS_TOKEN}` }) },
            ],
            ['an exchange that cannot be reached', { session: unreachable }],
            [
                'a provider refusal that describes the device code',
                {
                    token: () =>
                        reply(400, {
                            error: 'invalid_grant',
                            error_description: `unknown ${DEVICE_CODE}`,
                        }),
                },
            ],
            ['an expired code', { token: () => reply(400, { error: 'expired_token' }) }],
        ])(
            'never prints the device code, the access token or the session (%s)',
            async (_case, routes) => {
                const w = world(routes);

                await signIn(w);

                const printed = terminal.join('\n');
                for (const secret of SECRETS) {
                    expect(printed).not.toContain(secret);
                }
            },
        );

        it('never puts a token or a code in any address it requests', async () => {
            const w = world();

            await signIn(w);

            for (const request of w.requests) {
                for (const value of [...SECRETS, USER_CODE]) {
                    expect(request.url).not.toContain(value);
                }
            }
        });
    });
});
