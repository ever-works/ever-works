import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { isSafeWebhookUrl, safeFetchWithDnsPin, SsrfBlockedError } from '../utils/ssrf-guard';

/**
 * DI token for the optional `WebhookHttpClient` override. Tests and the
 * Trigger.dev runtime can bind a custom client; production wiring leaves
 * the token unbound and the service falls back to global `fetch`.
 */
export const WEBHOOK_HTTP_CLIENT = Symbol.for('WebhookHttpClient');

export interface WebhookHeaders {
    readonly 'Content-Type': 'application/json; charset=utf-8';
    readonly 'X-Hub-Signature-256': string;
    readonly 'X-Ever-Works-Event': string;
    readonly 'X-Ever-Works-Delivery': string;
}

export interface SignedDelivery {
    readonly url: string;
    readonly body: string;
    readonly headers: WebhookHeaders;
    readonly deliveryId: string;
}

export interface DeliveryResult {
    readonly ok: boolean;
    readonly status?: number;
    readonly error?: string;
    readonly deliveryId: string;
}

export interface WebhookDeliveryRequest {
    readonly url: string;
    readonly secret: string;
    readonly event: string;
    readonly payload: Record<string, unknown>;
    /** Optional pre-generated delivery id (defaults to a fresh UUIDv4). */
    readonly deliveryId?: string;
}

/**
 * Minimal HTTP client surface so the service is trivially mockable in tests
 * and pluggable to whatever HTTP library the host app prefers (axios,
 * undici, fetch). The default binding in the module uses global `fetch`,
 * which is available in Node 22+ (the project's required runtime).
 */
export interface WebhookHttpClient {
    post(args: {
        url: string;
        body: string;
        headers: Record<string, string>;
        timeoutMs: number;
    }): Promise<{
        status: number;
    }>;
}

@Injectable()
export class FetchWebhookHttpClient implements WebhookHttpClient {
    async post(args: {
        url: string;
        body: string;
        headers: Record<string, string>;
        timeoutMs: number;
    }): Promise<{ status: number }> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), args.timeoutMs);
        try {
            // safeFetchWithDnsPin re-checks the lexical SSRF guard AND resolves
            // DNS to refuse any private/loopback/link-local/metadata IP before
            // the socket connect. See ssrf-guard.ts for the documented partial
            // mitigation (no IP-pinned connection — see M-23 follow-up).
            const response = await safeFetchWithDnsPin(args.url, {
                method: 'POST',
                body: args.body,
                headers: args.headers,
                signal: controller.signal,
            });
            return { status: response.status };
        } finally {
            clearTimeout(timer);
        }
    }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const SIGNATURE_HEADER = 'X-Hub-Signature-256';

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
     * Build a signed delivery without sending it. Useful for tests and for
     * the Trigger.dev task wrapper that wants control over retry semantics.
     */
    sign(request: WebhookDeliveryRequest): SignedDelivery {
        const body = JSON.stringify(request.payload);
        const signature = computeSignature(body, request.secret);
        const deliveryId = request.deliveryId ?? randomUUID();

        return {
            url: request.url,
            body,
            deliveryId,
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'X-Hub-Signature-256': signature,
                'X-Ever-Works-Event': request.event,
                'X-Ever-Works-Delivery': deliveryId,
            },
        };
    }

    /**
     * Sign + POST in one call. Returns `{ ok: false }` for SSRF-blocked URLs,
     * timeouts, network errors, and non-2xx responses. The caller (typically a
     * Trigger.dev task) decides whether and how to retry.
     */
    async deliver(request: WebhookDeliveryRequest): Promise<DeliveryResult> {
        if (!isSafeWebhookUrl(request.url)) {
            this.logger.warn(`webhook.ssrf_blocked url=${redactUrl(request.url)}`);
            return {
                ok: false,
                error: 'ssrf_blocked',
                deliveryId: request.deliveryId ?? randomUUID(),
            };
        }

        const signed = this.sign(request);
        try {
            const response = await this.httpClient.post({
                url: signed.url,
                body: signed.body,
                headers: signed.headers as unknown as Record<string, string>,
                timeoutMs: DEFAULT_TIMEOUT_MS,
            });
            const ok = response.status >= 200 && response.status < 300;
            if (!ok) {
                this.logger.warn(
                    `webhook.delivery_failed url=${redactUrl(signed.url)} status=${response.status} delivery=${signed.deliveryId}`,
                );
            }
            return { ok, status: response.status, deliveryId: signed.deliveryId };
        } catch (err) {
            // The default FetchWebhookHttpClient calls safeFetchWithDnsPin, which
            // throws SsrfBlockedError if the hostname resolves to a private IP.
            // Surface that as the same `ssrf_blocked` error code the lexical
            // guard above uses so retry policies in Trigger.dev treat both
            // cases identically (don't retry — the URL will never be safe).
            if (err instanceof SsrfBlockedError) {
                this.logger.warn(
                    `webhook.ssrf_blocked url=${redactUrl(signed.url)} reason=${err.code} delivery=${signed.deliveryId}`,
                );
                return { ok: false, error: 'ssrf_blocked', deliveryId: signed.deliveryId };
            }
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(
                `webhook.delivery_error url=${redactUrl(signed.url)} reason=${message} delivery=${signed.deliveryId}`,
            );
            return { ok: false, error: message, deliveryId: signed.deliveryId };
        }
    }

    /**
     * Constant-time signature verification. Use on the receiving side (e.g.
     * if Ever Works ever consumes its own webhooks) and exposed for agents
     * via documentation in `docs/agent-services/zero-friction-onboarding.md`.
     */
    static verify(rawBody: string, headerValue: string, secret: string): boolean {
        const expected = computeSignature(rawBody, secret);
        const a = Buffer.from(headerValue);
        const b = Buffer.from(expected);
        if (a.length !== b.length) return false;
        return timingSafeEqual(a, b);
    }
}

export const WEBHOOK_SIGNATURE_HEADER = SIGNATURE_HEADER;

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
