import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { isSafeWebhookUrl, safeFetchWithDnsPin, SsrfBlockedError } from '../utils/ssrf-guard';
import {
    signWebhookV2,
    WEBHOOK_V2_EVENT_ID_HEADER,
    WEBHOOK_V2_SIGNATURE_HEADER,
} from './webhook-signature-v2';

/**
 * DI token for the optional `WebhookHttpClient` override. Tests and the
 * Trigger.dev runtime can bind a custom client; production wiring leaves
 * the token unbound and the service falls back to global `fetch`.
 */
export const WEBHOOK_HTTP_CLIENT = Symbol.for('WebhookHttpClient');

/**
 * Canonical outbound headers. Two signature headers are emitted on every
 * delivery:
 *
 *  - `X-Ever-Works-Signature-256` — the public, brand-owned header name
 *    documented for receivers (see `docs/specs/features/webhook-delivery.md`).
 *  - `X-Hub-Signature-256` — the GitHub-style alias, kept for receivers
 *    that already accept that header (the onboarding terminal fan-out
 *    has been shipping it since before EW-634).
 *
 * Both carry the same `sha256=<hex>` value computed over the raw JSON body.
 */
export interface WebhookHeaders {
    readonly 'Content-Type': 'application/json; charset=utf-8';
    readonly 'X-Hub-Signature-256': string;
    readonly 'X-Ever-Works-Signature-256': string;
    readonly 'X-Ever-Works-Event': string;
    readonly 'X-Ever-Works-Delivery': string;
}

export interface SignedDelivery {
    readonly url: string;
    readonly body: string;
    readonly headers: WebhookHeaders;
    readonly deliveryId: string;
}

/**
 * Webhooks v2 headers (integration contract v1 B.5). No legacy
 * `sha256=` headers: a v2 receiver verifies `X-Ever-Works-Signature`
 * (`t=<unix>,v1=<hex>`, one `v1` per live secret during a rotation).
 */
export interface WebhookHeadersV2 {
    readonly 'Content-Type': 'application/json; charset=utf-8';
    readonly 'X-Ever-Works-Signature': string;
    readonly 'X-Ever-Works-Event': string;
    readonly 'X-Ever-Works-Event-Id': string;
    readonly 'X-Ever-Works-Delivery': string;
}

export interface SignedDeliveryV2 {
    readonly url: string;
    readonly body: string;
    readonly headers: WebhookHeadersV2;
    readonly deliveryId: string;
}

/**
 * Outcome buckets the Trigger.dev task branches on for retry classification:
 *
 *  - `success`          → 2xx; mark the subscription as delivered.
 *  - `client_error`     → 4xx; do NOT retry, but bump the failure counter.
 *  - `server_error`     → 5xx or network error; throw so Trigger.dev retries.
 *  - `ssrf_blocked`     → URL was refused before the request hit the wire;
 *                         do NOT retry — the URL will never be safe.
 *  - `redirect_refused` → upstream tried to redirect us; do NOT retry,
 *                         re-registration is required.
 *  - `payload_too_large`→ `Content-Length` exceeded 1 MiB; do NOT retry.
 *  - `timeout`          → AbortError fired (network or server hang); retry.
 */
export type DeliveryOutcome =
    | 'success'
    | 'client_error'
    | 'server_error'
    | 'ssrf_blocked'
    | 'redirect_refused'
    | 'payload_too_large'
    | 'timeout';

export interface DeliveryResult {
    readonly ok: boolean;
    readonly outcome: DeliveryOutcome;
    readonly status?: number;
    readonly error?: string;
    readonly deliveryId: string;
    /** Wall-clock duration of the HTTP attempt, in milliseconds. */
    readonly durationMs?: number;
}

export interface WebhookDeliveryRequest {
    readonly url: string;
    readonly secret: string;
    readonly event: string;
    readonly payload: Record<string, unknown>;
    /** Optional pre-generated delivery id (defaults to a fresh UUIDv4). */
    readonly deliveryId?: string;
    /** Per-attempt override; defaults to {@link DEFAULT_TIMEOUT_MS}. */
    readonly timeoutMs?: number;
    /**
     * Webhooks v2: `2` signs with `X-Ever-Works-Signature: t=,v1=` and sends
     * `X-Ever-Works-Event-Id`; anything else keeps the v1 headers.
     */
    readonly signatureVersion?: 1 | 2;
    /** v2: a rotated-out secret still in its grace window — signed as a second `v1=`. */
    readonly previousSecret?: string | null;
    /** v2: the domain event id; defaults to `payload.id`, then the delivery id. */
    readonly eventId?: string | null;
    /** v2: the signing time in unix seconds (tests); defaults to now. */
    readonly timestampSeconds?: number;
}

/**
 * Minimal HTTP client surface so the service is trivially mockable in tests
 * and pluggable to whatever HTTP library the host app prefers. The default
 * binding uses global `fetch` (Node 22+, the project's required runtime),
 * wrapped in {@link FetchWebhookHttpClient} below.
 */
export interface WebhookHttpClient {
    post(args: {
        url: string;
        body: string;
        headers: Record<string, string>;
        timeoutMs: number;
    }): Promise<HttpClientResponse>;
}

export interface HttpClientResponse {
    readonly status: number;
    /**
     * `'manual'` if the upstream replied with a 3xx; the delivery worker
     * treats that as a hard `redirect_refused` outcome — the registered URL
     * is the registered URL.
     */
    readonly redirected?: boolean;
}

/**
 * `EVER_WORKS_WEBHOOK_ALLOW_LOOPBACK=true` — **local development only**: lets
 * webhook deliveries reach a receiver on the same machine (for example a local
 * Gauzy at `http://127.0.0.1:3000`, the Gauzy ↔ Ever Works end-to-end run).
 * The SSRF guard refuses loopback targets everywhere, so without it a local
 * pair could never receive a webhook. Honoured only for the exact value
 * `true` in a `NODE_ENV` of `development` or `test` (a deployed environment
 * ignores it), and it admits only `localhost`, `127.0.0.1` and `[::1]`: every
 * other private, link-local or metadata address stays refused. Read per call.
 */
export function webhookLoopbackAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
    return (
        env.EVER_WORKS_WEBHOOK_ALLOW_LOOPBACK === 'true' &&
        (env.NODE_ENV === 'development' || env.NODE_ENV === 'test')
    );
}

const LOOPBACK_WEBHOOK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A loopback receiver URL (`http(s)://localhost|127.0.0.1|[::1]`, no credentials). */
export function isLoopbackWebhookUrl(rawUrl: string): boolean {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return false;
    }
    return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        !url.username &&
        !url.password &&
        LOOPBACK_WEBHOOK_HOSTS.has(url.hostname.toLowerCase())
    );
}

/** A loopback URL the development switch admits right now. */
function isAllowedLoopbackWebhookUrl(rawUrl: string): boolean {
    return webhookLoopbackAllowed() && isLoopbackWebhookUrl(rawUrl);
}

/** Per-delivery body cap, before any compression. */
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
const DEFAULT_TIMEOUT_MS = 10_000;
const SIGNATURE_HEADER_LEGACY = 'X-Hub-Signature-256';
const SIGNATURE_HEADER = 'X-Ever-Works-Signature-256';

@Injectable()
export class FetchWebhookHttpClient implements WebhookHttpClient {
    async post(args: {
        url: string;
        body: string;
        headers: Record<string, string>;
        timeoutMs: number;
    }): Promise<HttpClientResponse> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), args.timeoutMs);
        try {
            // safeFetchWithDnsPin re-checks the lexical SSRF guard AND resolves
            // DNS to refuse any private/loopback/link-local/metadata IP before
            // the socket connect. See ssrf-guard.ts for the documented partial
            // mitigation (no IP-pinned connection — see M-23 follow-up).
            //
            // `redirect: 'manual'` means a 3xx response surfaces with
            // `response.status` in [300, 400) and `response.type === 'opaqueredirect'`.
            // The delivery worker treats any 3xx as `redirect_refused`.
            const init = {
                method: 'POST',
                body: args.body,
                headers: args.headers,
                signal: controller.signal,
                redirect: 'manual' as const,
            };
            // The development-only loopback switch: a local receiver, sent
            // directly (the DNS-pinned fetch refuses loopback by design).
            const response = isAllowedLoopbackWebhookUrl(args.url)
                ? await fetch(args.url, init)
                : await safeFetchWithDnsPin(args.url, init);
            return { status: response.status, redirected: response.redirected };
        } finally {
            clearTimeout(timer);
        }
    }
}

@Injectable()
export class WebhookDeliveryService {
    private readonly logger = new Logger(WebhookDeliveryService.name);
    private readonly httpClient: WebhookHttpClient;

    constructor(
        @Optional()
        @Inject(WEBHOOK_HTTP_CLIENT)
        httpClient?: WebhookHttpClient,
    ) {
        // Default value lives in the body — NOT the parameter signature —
        // because NestJS resolves constructor params via emitted decorator
        // metadata. With an interface-typed parameter (no class to inject),
        // a default-in-signature still triggers `Nest can't resolve
        // dependencies of WebhookDeliveryService (?)` even when @Optional()
        // is present. Keeping the parameter optional and applying the
        // fallback inside the body sidesteps that resolution path.
        this.httpClient = httpClient ?? new FetchWebhookHttpClient();
    }

    /**
     * Build a signed delivery without sending it. Useful for tests, for the
     * Trigger.dev task wrapper that wants control over retry semantics, and
     * for the receiver-side documentation snippet (so receivers can compute
     * the expected signature and timing-safe-compare it themselves).
     */
    sign(request: WebhookDeliveryRequest): SignedDelivery {
        const body = JSON.stringify(request.payload);
        if (Buffer.byteLength(body, 'utf8') > WEBHOOK_MAX_BODY_BYTES) {
            // We refuse to even sign an oversized payload — the worker
            // would have to throw it away on the way out, so fail fast at
            // the producer so the caller gets a clear error in-band.
            throw new PayloadTooLargeError(Buffer.byteLength(body, 'utf8'));
        }
        const signature = computeSignature(body, request.secret);
        const deliveryId = request.deliveryId ?? randomUUID();

        return {
            url: request.url,
            body,
            deliveryId,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'X-Hub-Signature-256': signature,
                'X-Ever-Works-Signature-256': signature,
                'X-Ever-Works-Event': request.event,
                'X-Ever-Works-Delivery': deliveryId,
            },
        };
    }

    /**
     * Webhooks v2: build a delivery signed `X-Ever-Works-Signature: t=,v1=` over
     * `"<t>.<rawBody>"` (one `v1` per live secret) without sending it.
     */
    signV2(request: WebhookDeliveryRequest): SignedDeliveryV2 {
        const body = JSON.stringify(request.payload);
        if (Buffer.byteLength(body, 'utf8') > WEBHOOK_MAX_BODY_BYTES) {
            throw new PayloadTooLargeError(Buffer.byteLength(body, 'utf8'));
        }
        const deliveryId = request.deliveryId ?? randomUUID();
        const timestamp = request.timestampSeconds ?? Math.floor(Date.now() / 1000);
        const secrets = [request.secret];
        if (request.previousSecret && request.previousSecret !== request.secret) {
            secrets.push(request.previousSecret);
        }
        const payloadId = (request.payload as { id?: unknown }).id;
        const eventId = request.eventId ?? (typeof payloadId === 'string' ? payloadId : deliveryId);
        return {
            url: request.url,
            body,
            deliveryId,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                [WEBHOOK_V2_SIGNATURE_HEADER]: signWebhookV2(body, secrets, timestamp),
                'X-Ever-Works-Event': request.event,
                [WEBHOOK_V2_EVENT_ID_HEADER]: eventId,
                'X-Ever-Works-Delivery': deliveryId,
            } as WebhookHeadersV2,
        };
    }

    /**
     * Sign + POST in one call. Returns a {@link DeliveryResult} with a
     * discriminated `outcome` field; the caller (typically the Trigger.dev
     * task) inspects `outcome` to decide whether to retry, mark failed, or
     * mark delivered. The service itself never throws into the caller.
     */
    async deliver(request: WebhookDeliveryRequest): Promise<DeliveryResult> {
        const deliveryId = request.deliveryId ?? randomUUID();

        if (!isSafeWebhookUrl(request.url) && !isAllowedLoopbackWebhookUrl(request.url)) {
            this.logger.warn(`webhook.ssrf_blocked url=${redactUrl(request.url)}`);
            return {
                ok: false,
                outcome: 'ssrf_blocked',
                error: 'ssrf_blocked',
                deliveryId,
            };
        }

        let signed: SignedDelivery | SignedDeliveryV2;
        try {
            signed =
                request.signatureVersion === 2
                    ? this.signV2({ ...request, deliveryId })
                    : this.sign({ ...request, deliveryId });
        } catch (err) {
            if (err instanceof PayloadTooLargeError) {
                this.logger.warn(
                    `webhook.payload_too_large url=${redactUrl(request.url)} bytes=${err.byteLength}`,
                );
                return {
                    ok: false,
                    outcome: 'payload_too_large',
                    error: `payload_too_large bytes=${err.byteLength}`,
                    deliveryId,
                };
            }
            throw err;
        }

        const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const startedAt = Date.now();
        try {
            const response = await this.httpClient.post({
                url: signed.url,
                body: signed.body,
                headers: signed.headers as unknown as Record<string, string>,
                timeoutMs,
            });
            const durationMs = Date.now() - startedAt;
            // Redirect: receiver tried to send us somewhere else. The
            // registered URL is the contract — we refuse to follow it and
            // surface that as a non-retryable outcome so the operator
            // notices and re-registers.
            if (response.status >= 300 && response.status < 400) {
                this.logger.warn(
                    `webhook.redirect_refused url=${redactUrl(signed.url)} status=${response.status} delivery=${signed.deliveryId}`,
                );
                return {
                    ok: false,
                    outcome: 'redirect_refused',
                    status: response.status,
                    deliveryId: signed.deliveryId,
                    durationMs,
                };
            }
            const outcome: DeliveryOutcome =
                response.status >= 200 && response.status < 300
                    ? 'success'
                    : response.status >= 400 && response.status < 500
                      ? 'client_error'
                      : 'server_error';
            if (outcome !== 'success') {
                this.logger.warn(
                    `webhook.delivery_failed url=${redactUrl(signed.url)} status=${response.status} outcome=${outcome} delivery=${signed.deliveryId}`,
                );
            }
            return {
                ok: outcome === 'success',
                outcome,
                status: response.status,
                deliveryId: signed.deliveryId,
                durationMs,
            };
        } catch (err) {
            const durationMs = Date.now() - startedAt;
            // The default FetchWebhookHttpClient calls safeFetchWithDnsPin, which
            // throws SsrfBlockedError if the hostname resolves to a private IP.
            // Surface that as the same `ssrf_blocked` outcome the lexical guard
            // uses so retry policies in Trigger.dev treat both cases identically.
            if (err instanceof SsrfBlockedError) {
                this.logger.warn(
                    `webhook.ssrf_blocked url=${redactUrl(signed.url)} reason=${err.code} delivery=${signed.deliveryId}`,
                );
                return {
                    ok: false,
                    outcome: 'ssrf_blocked',
                    error: 'ssrf_blocked',
                    deliveryId: signed.deliveryId,
                    durationMs,
                };
            }
            const message = err instanceof Error ? err.message : String(err);
            // AbortController.abort() surfaces as DOMException name 'AbortError'
            // (Node 22 fetch) or sometimes as 'TimeoutError'. Treat both as
            // retryable timeouts.
            const isTimeout =
                err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
            const outcome: DeliveryOutcome = isTimeout ? 'timeout' : 'server_error';
            this.logger.warn(
                `webhook.delivery_error url=${redactUrl(signed.url)} reason=${message} outcome=${outcome} delivery=${signed.deliveryId}`,
            );
            return {
                ok: false,
                outcome,
                error: message,
                deliveryId: signed.deliveryId,
                durationMs,
            };
        }
    }

    /**
     * Constant-time signature verification. Use on the receiving side; the
     * receiver-side reference snippet in `docs/specs/features/webhook-delivery.md`
     * shows the canonical Node / Bun / Deno implementation.
     *
     * Accepts the value of either `X-Ever-Works-Signature-256` or its
     * `X-Hub-Signature-256` alias — both carry the same `sha256=<hex>`.
     */
    static verify(rawBody: string, headerValue: string, secret: string): boolean {
        if (!headerValue) return false;
        const expected = computeSignature(rawBody, secret);
        const a = Buffer.from(headerValue);
        const b = Buffer.from(expected);
        if (a.length !== b.length) return false;
        return timingSafeEqual(a, b);
    }
}

export const WEBHOOK_SIGNATURE_HEADER = SIGNATURE_HEADER;
export const WEBHOOK_SIGNATURE_HEADER_LEGACY = SIGNATURE_HEADER_LEGACY;

/**
 * Thrown by {@link WebhookDeliveryService.sign} when the JSON-serialized
 * payload exceeds {@link WEBHOOK_MAX_BODY_BYTES}. {@link WebhookDeliveryService.deliver}
 * catches this internally and reports `outcome: 'payload_too_large'`.
 */
export class PayloadTooLargeError extends Error {
    constructor(public readonly byteLength: number) {
        super(`webhook payload exceeds ${WEBHOOK_MAX_BODY_BYTES} bytes (got ${byteLength})`);
        this.name = 'PayloadTooLargeError';
    }
}

function computeSignature(body: string, secret: string): string {
    return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function redactUrl(url: string): string {
    try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.hostname}${parsed.pathname.length > 1 ? parsed.pathname : ''}`;
    } catch {
        return '[invalid-url]';
    }
}
