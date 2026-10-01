import chalk from 'chalk';
import {
    EVER_ID_ERROR_CODE_WIRE_VALUES,
    EVER_ID_LIMITS,
    EVER_ID_SCOPES,
    EVER_ID_WIRE_ERROR_CODES,
    type EverIdErrorCode,
    type EverIdWireErrorCode,
} from '@ever-works/contracts';
import { wait } from '../../utils/wait';
import { CredentialsService } from './credentials.service';

/**
 * `ever-works auth login --ever-id` — sign in with Ever ID using a code shown in the
 * terminal (APW-12: S8, S23, FR-39 to FR-43, spec §6.6).
 *
 * This is the OAuth 2.0 device authorization grant (RFC 8628), run directly against
 * Ever ID with the CLI's own public client:
 *
 *   GET  <api>/api/auth/ever-id/client-config        the issuer and the `cli` client id
 *   GET  <issuer>/.well-known/openid-configuration   the device and token endpoints
 *   POST <device_authorization_endpoint>             client id + scope → the codes
 *   POST <token_endpoint>, polled                    device code → Ever ID access token
 *   POST <api>/api/auth/ever-id/session              that token as a bearer → a session
 *
 * The session is stored exactly where the browser sign-in stores it. The terminal shows
 * Ever ID's verification address and the user code and nothing else: the device code,
 * the Ever ID access token and the session are never printed, and the access token is
 * dropped as soon as it has been exchanged. Every failure prints one line and the
 * command exits with code 1.
 */

/** The subset of `fetch` this flow uses; the spec answers every request itself. */
export type EverIdFetch = (
    url: string,
    init: {
        method: 'GET' | 'POST';
        headers: Record<string, string>;
        body?: string;
        signal?: AbortSignal;
    },
) => Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
}>;

export interface EverIdDeviceLoginOptions {
    /** The Ever Works API address (`--api-url`), with or without the trailing `/api`. */
    apiUrl: string;
    /** Defaults to the global `fetch`. */
    fetch?: EverIdFetch;
    /** Wall clock in milliseconds. Defaults to `Date.now`. */
    now?: () => number;
    /** Waits between two polls of the token endpoint. Defaults to a timer. */
    sleep?: (ms: number) => Promise<void>;
}

/** The lines this flow prints: spec §6.6 and S23, plus the ones the spec leaves to the client. */
export const EVER_ID_DEVICE_MESSAGES = {
    prompt: (verificationUri: string, userCode: string) =>
        `To sign in, open  ${verificationUri}  and enter the code:  ${userCode}`,
    waiting: (minutes: number) =>
        `Waiting for approval… (expires in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'})`,
    signedIn: (who: string) => `Signed in as ${who}.`,
    signedInAnonymous: 'Signed in.',
    providerUnavailable: `Ever ID isn't responding. Try "ever-works auth login" without --ever-id.`,
    expired: 'The code expired. Run the command again.',
    notConnected: 'Connect Ever ID to your Ever Works account in Settings → Security first.',
    unavailable: `Ever ID isn't available on this server. Try "ever-works auth login" without --ever-id.`,
    denied: 'Sign-in was declined at Ever ID. Run the command again to retry.',
    signInExpired: 'That sign-in expired or was already used. Run the command again.',
    accountSuspended: 'Account is suspended.',
    rateLimited: (seconds: number | null) =>
        seconds === null
            ? 'Too many attempts. Try again in a minute.'
            : `Too many attempts. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`,
    apiUnreachable: (origin: string) => `Could not reach Ever Works at ${origin}.`,
    invalidApiUrl: (value: string) => `Invalid --api-url: ${value}`,
    insecureApiUrl: (host: string) =>
        `Refusing to send an Ever ID sign-in over insecure HTTP to a non-local host (${host}). Use an https:// API URL.`,
    insecureProvider: (host: string) =>
        `Refusing to use Ever ID over insecure HTTP (${host}). Ask an administrator to check the Ever ID settings.`,
    providerRejected: (error: string) => `Ever ID refused the sign-in request (${error}).`,
    unexpectedStatus: (status: number) => `Ever ID sign-in failed (HTTP ${status}).`,
    unexpectedResponse:
        'Ever ID sign-in failed: the server sent an answer the CLI does not understand.',
    failed: (detail: string) => `Ever ID sign-in failed: ${detail}`,
} as const;

/** A failure whose message is the exact line the terminal shows. */
export class EverIdDeviceLoginError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'EverIdDeviceLoginError';
    }
}

/** The local-client kind this CLI signs in as (`GET /client-config`). */
const CLIENT_KIND = 'cli';

/** Exactly the scopes the device request asks for; no `audience`, no `resource` (plan §7). */
const DEVICE_SCOPE = ['openid', 'email', EVER_ID_SCOPES.SESSION_EXCHANGE].join(' ');

const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** Ever ID gets the platform's outbound budget (FR-15); after it, S16 applies. */
const PROVIDER_TIMEOUT_MS = EVER_ID_LIMITS.outboundTimeoutMs;

/** The Ever Works API gets the same budget as the CLI's HTTP client. */
const API_TIMEOUT_MS = 30_000;

/** RFC 8628 §3.5: back off on a failed poll, but stop waiting on an Ever ID that is down. */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

/** The production edge refuses requests without a real user agent. */
const USER_AGENT = 'ever-works-cli';

const MS_PER_SECOND = 1_000;

interface Seams {
    fetch: EverIdFetch;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
}

interface DeviceGrant {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresInSeconds: number;
    intervalSeconds: number;
}

interface EverWorksSession {
    token: string;
    email: string | null;
    username: string | null;
}

/**
 * Runs the device sign-in and stores the session. Throws {@link EverIdDeviceLoginError}
 * carrying the exact line to show for every failure it recognises.
 */
export async function signInWithEverIdDevice(
    options: EverIdDeviceLoginOptions,
): Promise<{ displayName: string | null }> {
    const seams: Seams = {
        fetch: options.fetch ?? fetch,
        now: options.now ?? Date.now,
        sleep: options.sleep ?? wait,
    };

    const apiBase = parseApiUrl(options.apiUrl);
    const { issuer, clientId } = await readClientConfig(seams, apiBase);
    const endpoints = await discoverEndpoints(seams, issuer);
    const grant = await requestDeviceGrant(seams, endpoints.deviceAuthorization, clientId);

    console.log(
        EVER_ID_DEVICE_MESSAGES.prompt(
            chalk.cyan(grant.verificationUri),
            chalk.bold(grant.userCode),
        ),
    );
    console.log(
        EVER_ID_DEVICE_MESSAGES.waiting(Math.max(1, Math.floor(grant.expiresInSeconds / 60))),
    );

    const session = await obtainSession(seams, apiBase, endpoints.token, clientId, grant);

    // The same file, shape and permissions as the browser sign-in (FR-42).
    await CredentialsService.save(
        CredentialsService.createWithExpiry(
            session.token,
            options.apiUrl,
            session.email ?? undefined,
        ),
    );

    return { displayName: session.email ?? session.username };
}

/**
 * The `--ever-id` branch of `ever-works auth login`: runs the sign-in, prints the
 * outcome and answers the exit code (0, or 1 on every failure).
 */
export async function runEverIdDeviceLogin(options: EverIdDeviceLoginOptions): Promise<number> {
    try {
        const { displayName } = await signInWithEverIdDevice(options);
        console.log(
            chalk.green(
                displayName
                    ? EVER_ID_DEVICE_MESSAGES.signedIn(sanitize(displayName))
                    : EVER_ID_DEVICE_MESSAGES.signedInAnonymous,
            ),
        );
        return 0;
    } catch (error) {
        const line =
            error instanceof EverIdDeviceLoginError
                ? error.message
                : EVER_ID_DEVICE_MESSAGES.failed(
                      sanitize(error instanceof Error ? error.message : String(error)),
                  );
        console.error(chalk.red(line));
        return 1;
    }
}

// ---------------------------------------------------------------------------
// The steps
// ---------------------------------------------------------------------------

async function readClientConfig(
    seams: Seams,
    apiBase: URL,
): Promise<{ issuer: URL; clientId: string }> {
    const reply = await send(seams, everIdApiUrl(apiBase, 'client-config'), {
        method: 'GET',
        timeoutMs: API_TIMEOUT_MS,
    });
    if (!reply) {
        throw new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.apiUnreachable(apiBase.origin));
    }
    if (!reply.ok) {
        throw apiFailure(reply);
    }

    const config = asRecord(reply.body);
    const issuer = parseUrl(stringField(config, 'issuer'));
    const localClients = config?.localClients;
    const clients: unknown[] = Array.isArray(localClients) ? localClients : [];
    const clientId = clients
        .map(asRecord)
        .filter((client) => client?.kind === CLIENT_KIND)
        .map((client) => stringField(client, 'clientId'))
        .find((id): id is string => id !== null);
    // Without an issuer or a client for this CLI there is nothing to sign in with.
    if (!issuer || !clientId) {
        throw new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.unavailable);
    }
    assertSecureProviderUrl(issuer);
    return { issuer, clientId };
}

async function discoverEndpoints(
    seams: Seams,
    issuer: URL,
): Promise<{ deviceAuthorization: URL; token: URL }> {
    const discoveryUrl = `${issuer.origin}${issuer.pathname.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const reply = await send(seams, discoveryUrl, {
        method: 'GET',
        timeoutMs: PROVIDER_TIMEOUT_MS,
    });
    if (!reply || !reply.ok) {
        throw new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.providerUnavailable);
    }

    const document = asRecord(reply.body);
    if (!document) {
        throw new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.providerUnavailable);
    }
    const deviceAuthorization = parseUrl(stringField(document, 'device_authorization_endpoint'));
    const token = parseUrl(stringField(document, 'token_endpoint'));
    // A provider that does not offer device authorization cannot run this sign-in.
    if (!deviceAuthorization) {
        throw new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.unavailable);
    }
    if (!token) {
        throw new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.providerUnavailable);
    }
    assertSecureProviderUrl(deviceAuthorization);
    assertSecureProviderUrl(token);
    return { deviceAuthorization, token };
}

async function requestDeviceGrant(
    seams: Seams,
    endpoint: URL,
    clientId: string,
): Promise<DeviceGrant> {
    const reply = await send(seams, endpoint.toString(), {
        method: 'POST',
        form: { client_id: clientId, scope: DEVICE_SCOPE },
        timeoutMs: PROVIDER_TIMEOUT_MS,
    });
    if (!reply || reply.status >= 500) {
        throw new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.providerUnavailable);
    }
    if (reply.status === 429) {
        throw new EverIdDeviceLoginError(
            EVER_ID_DEVICE_MESSAGES.rateLimited(retryAfterSeconds(reply.retryAfter)),
        );
    }
    if (!reply.ok) {
        throw new EverIdDeviceLoginError(
            EVER_ID_DEVICE_MESSAGES.providerRejected(
                sanitize(oauthError(reply.body) ?? `HTTP ${reply.status}`),
            ),
        );
    }

    const body = asRecord(reply.body);
    const deviceCode = stringField(body, 'device_code');
    const userCode = sanitize(stringField(body, 'user_code') ?? '');
    // Only the plain verification address is shown: `verification_uri_complete` would put
    // the user code in an address (spec FR-42).
    const verificationUri = parseUrl(stringField(body, 'verification_uri'));
    if (!deviceCode || !userCode || !verificationUri) {
        throw new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.providerUnavailable);
    }
    assertSecureProviderUrl(verificationUri);

    const expiresIn = positiveNumber(body?.expires_in);
    const interval = positiveNumber(body?.interval);
    return {
        deviceCode,
        userCode,
        verificationUri: verificationUri.href,
        // FR-41: never wait past 900 seconds, whatever the provider answers.
        expiresInSeconds: Math.min(
            expiresIn ?? EVER_ID_LIMITS.deviceCodeMaxLifetimeSeconds,
            EVER_ID_LIMITS.deviceCodeMaxLifetimeSeconds,
        ),
        // FR-41: never poll faster than the provider asks, and never faster than every 5 s.
        intervalSeconds: Math.max(
            interval ?? EVER_ID_LIMITS.devicePollMinIntervalSeconds,
            EVER_ID_LIMITS.devicePollMinIntervalSeconds,
        ),
    };
}

/**
 * Polls for Ever ID's access token and trades it for an Ever Works session. The access
 * token never leaves this frame, so nothing holds it once the exchange is done (FR-42).
 */
async function obtainSession(
    seams: Seams,
    apiBase: URL,
    tokenEndpoint: URL,
    clientId: string,
    grant: DeviceGrant,
): Promise<EverWorksSession> {
    const accessToken = await pollForAccessToken(seams, tokenEndpoint, clientId, grant);
    return exchangeForSession(seams, apiBase, accessToken);
}

/** RFC 8628 §3.4–3.5 with the FR-41 bounds. */
async function pollForAccessToken(
    seams: Seams,
    tokenEndpoint: URL,
    clientId: string,
    grant: DeviceGrant,
): Promise<string> {
    const deadline = seams.now() + grant.expiresInSeconds * MS_PER_SECOND;
    const slowDownStepMs = EVER_ID_LIMITS.devicePollSlowDownStepSeconds * MS_PER_SECOND;
    let intervalMs = grant.intervalSeconds * MS_PER_SECOND;
    let consecutiveFailures = 0;

    for (;;) {
        await seams.sleep(intervalMs);
        if (seams.now() >= deadline) {
            throw new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.expired);
        }

        const reply = await send(seams, tokenEndpoint.toString(), {
            method: 'POST',
            form: {
                grant_type: DEVICE_CODE_GRANT_TYPE,
                device_code: grant.deviceCode,
                client_id: clientId,
            },
            timeoutMs: PROVIDER_TIMEOUT_MS,
        });

        if (!reply || reply.status >= 500) {
            // A connection failure halves the polling rate before the next try (§3.5).
            consecutiveFailures += 1;
            if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                throw new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.providerUnavailable);
            }
            intervalMs *= 2;
            continue;
        }
        consecutiveFailures = 0;

        if (reply.ok) {
            const accessToken = stringField(asRecord(reply.body), 'access_token');
            if (!accessToken) {
                throw new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.providerUnavailable);
            }
            return accessToken;
        }
        if (reply.status === 429) {
            intervalMs += slowDownStepMs;
            continue;
        }

        const error = oauthError(reply.body);
        switch (error) {
            case 'authorization_pending':
                continue;
            case 'slow_down':
                // "MUST be increased by 5 seconds for this and all subsequent requests."
                intervalMs += slowDownStepMs;
                continue;
            case 'expired_token':
                throw new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.expired);
            case 'access_denied':
                throw new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.denied);
            default:
                throw new EverIdDeviceLoginError(
                    EVER_ID_DEVICE_MESSAGES.providerRejected(
                        sanitize(error ?? `HTTP ${reply.status}`),
                    ),
                );
        }
    }
}

async function exchangeForSession(
    seams: Seams,
    apiBase: URL,
    accessToken: string,
): Promise<EverWorksSession> {
    const reply = await send(seams, everIdApiUrl(apiBase, 'session'), {
        method: 'POST',
        json: {},
        bearer: accessToken,
        timeoutMs: API_TIMEOUT_MS,
    });
    if (!reply) {
        throw new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.apiUnreachable(apiBase.origin));
    }
    if (!reply.ok) {
        throw apiFailure(reply);
    }

    const body = asRecord(reply.body);
    const token = stringField(body, 'access_token');
    if (!token) {
        throw new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.unexpectedResponse);
    }
    const user = asRecord(body?.user);
    return { token, email: stringField(user, 'email'), username: stringField(user, 'username') };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface SendSpec {
    method: 'GET' | 'POST';
    /** Sent as `application/x-www-form-urlencoded`, as the provider's endpoints require. */
    form?: Record<string, string>;
    /** Sent as JSON to the Ever Works API. */
    json?: Record<string, unknown>;
    /** Sent as `Authorization: Bearer …`. */
    bearer?: string;
    timeoutMs: number;
}

interface Reply {
    ok: boolean;
    status: number;
    retryAfter: string | null;
    /** The parsed JSON body, or `undefined` when there was none or it was not JSON. */
    body: unknown;
}

/** One request. Answers `undefined` when the server could not be reached or read. */
async function send(seams: Seams, url: string, spec: SendSpec): Promise<Reply | undefined> {
    const headers: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
    };
    let body: string | undefined;
    if (spec.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(spec.form).toString();
    } else if (spec.json) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(spec.json);
    }
    if (spec.bearer) {
        headers.Authorization = `Bearer ${spec.bearer}`;
    }

    try {
        const response = await seams.fetch(url, {
            method: spec.method,
            headers,
            ...(body === undefined ? {} : { body }),
            signal: AbortSignal.timeout(spec.timeoutMs),
        });
        const text = await response.text();
        return {
            ok: response.ok,
            status: response.status,
            retryAfter: response.headers.get('retry-after'),
            body: parseJson(text),
        };
    } catch {
        // Network failure, timeout or a body that could not be read. The cause is not
        // shown: it may carry provider text, and the line for this case is fixed.
        return undefined;
    }
}

/** Maps an Ever Works API refusal (the `{ status, code, message }` body) to its line. */
function apiFailure(reply: Reply): EverIdDeviceLoginError {
    if (reply.status === 429) {
        return new EverIdDeviceLoginError(
            EVER_ID_DEVICE_MESSAGES.rateLimited(retryAfterSeconds(reply.retryAfter)),
        );
    }
    switch (everIdErrorCode(reply.body)) {
        case 'ever_id_disabled':
            return new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.unavailable);
        case 'provider_unavailable':
            return new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.providerUnavailable);
        case 'not_connected':
            return new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.notConnected);
        case 'account_disabled':
            return new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.accountSuspended);
        case 'transaction_invalid':
            return new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.signInExpired);
        default:
            break;
    }
    if (reply.status === 404) {
        return new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.unavailable);
    }
    if (reply.status === 503) {
        return new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.providerUnavailable);
    }
    return new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.unexpectedStatus(reply.status));
}

/**
 * The wire code of an Ever ID error body. CONTRACTS §12 puts the snake_case code on the
 * wire; the camelCase member name maps onto the same code, since both spellings are in
 * use (`EVER_ID_ERROR_CODE_WIRE_VALUES`).
 */
function everIdErrorCode(body: unknown): EverIdWireErrorCode | null {
    const code = stringField(asRecord(body), 'code');
    if (!code) {
        return null;
    }
    if ((EVER_ID_WIRE_ERROR_CODES as readonly string[]).includes(code)) {
        return code as EverIdWireErrorCode;
    }
    return Object.prototype.hasOwnProperty.call(EVER_ID_ERROR_CODE_WIRE_VALUES, code)
        ? EVER_ID_ERROR_CODE_WIRE_VALUES[code as EverIdErrorCode]
        : null;
}

/** The RFC 6749 §5.2 `error` of a provider refusal. */
function oauthError(body: unknown): string | null {
    return stringField(asRecord(body), 'error');
}

function retryAfterSeconds(value: string | null): number | null {
    const seconds = Number(value);
    return value !== null && Number.isInteger(seconds) && seconds > 0 ? seconds : null;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * Validates `--api-url` before any request: the Ever ID access token is later sent to it
 * as a bearer, so cleartext HTTP is allowed only to this machine (the rule the CLI's
 * HTTP client applies to the stored session).
 */
function parseApiUrl(apiUrl: string): URL {
    const parsed = parseUrl(apiUrl);
    if (!parsed) {
        throw new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.invalidApiUrl(sanitize(apiUrl)));
    }
    if (!isSecureUrl(parsed)) {
        throw new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.insecureApiUrl(parsed.host));
    }
    return parsed;
}

/** `<api>/api/auth/ever-id/<route>`, with `/api` added when the address lacks it, as the HTTP client does. */
function everIdApiUrl(apiBase: URL, route: string): string {
    const root = `${apiBase.origin}${apiBase.pathname.replace(/\/+$/, '')}`;
    const api = root.endsWith('/api') ? root : `${root}/api`;
    return `${api}/auth/ever-id/${route}`;
}

/** FR-2: Ever ID is reached over HTTPS, or over HTTP on this machine only. */
function assertSecureProviderUrl(url: URL): void {
    if (!isSecureUrl(url)) {
        throw new EverIdDeviceLoginError(EVER_ID_DEVICE_MESSAGES.insecureProvider(url.host));
    }
}

function isSecureUrl(url: URL): boolean {
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
}

function isLoopbackHost(hostname: string): boolean {
    return (
        hostname === 'localhost' ||
        hostname === '[::1]' ||
        /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(hostname)
    );
}

/** An absolute http(s) URL, or `null`. */
function parseUrl(value: string | null): URL | null {
    if (!value) {
        return null;
    }
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * Text from Ever ID or the API reaches the terminal without control characters, so a
 * crafted answer cannot rewrite earlier lines — the same treatment `oauth.service.ts`
 * gives the browser hand-off's error text.
 */
function sanitize(value: string): string {
    return (
        value
            // eslint-disable-next-line no-control-regex
            .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
            .trim()
            .slice(0, 200)
    );
}

function parseJson(text: string): unknown {
    if (!text) {
        return undefined;
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
    const value = record?.[key];
    return typeof value === 'string' && value ? value : null;
}

function positiveNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}
