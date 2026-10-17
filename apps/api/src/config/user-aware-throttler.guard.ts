import { ExecutionContext, Injectable } from '@nestjs/common';
import {
    ThrottlerGuard,
    type ThrottlerLimitDetail,
    type ThrottlerRequest,
} from '@nestjs/throttler';
import { IntegrationHttpException } from '../auth/integration/integration-http.exception';
import { integrationLimits, isWriteMethod } from '../auth/integration/integration-limits';

type ThrottledRequest = Record<string, unknown> & {
    user?: {
        userId?: unknown;
        id?: unknown;
        sub?: unknown;
        authMethod?: unknown;
        integration?: { keyId?: unknown };
    };
    method?: unknown;
    url?: unknown;
    originalUrl?: unknown;
    ip?: unknown;
    ips?: unknown;
    headers?: Record<string, unknown>;
    socket?: {
        remoteAddress?: unknown;
    };
};

@Injectable()
export class UserAwareThrottlerGuard extends ThrottlerGuard {
    /**
     * Test/CI escape hatch for the AUTH endpoints only. The e2e suite drives
     * every spec from a single CI IP and must register / log in / mint many
     * accounts, so the per-IP auth throttles (register 5/min, login 10/min,
     * anonymous 5/h, …) would 429 its bulk setup. When `E2E_DISABLE_AUTH_THROTTLE`
     * is set AND we are not in production, skip throttling for `/api/auth/*`
     * routes. NON-auth throttling (ingest / notification / global tiers) stays
     * fully active so those rate-limit specs keep their coverage, and this is
     * HARD-gated off in production so it can never weaken a real deployment.
     */
    async canActivate(context: ExecutionContext): Promise<boolean> {
        if (
            process.env.E2E_DISABLE_AUTH_THROTTLE === 'true' &&
            process.env.NODE_ENV !== 'production'
        ) {
            const req = context.switchToHttp().getRequest<ThrottledRequest>();
            const rawUrl =
                (typeof req.originalUrl === 'string' && req.originalUrl) ||
                (typeof req.url === 'string' && req.url) ||
                '';
            const path = rawUrl.split('?')[0];
            // Incidental per-IP throttles that the single CI IP trips
            // cumulatively across the suite (none asserted as a 429 by any
            // rate-limit spec):
            //   - `/api/auth/*`                     — register/login/etc.
            //   - `/api/claim/*`                    — tokenised invitation claim (10/min)
            //   - `/api/organizations/check-slug`   — public slug-availability (30/60s)
            // Skipping these keeps the bulk-setup paths green. NON-auth
            // throttling (ingest / notification / global) stays active so the
            // dedicated rate-limit specs keep coverage, and this whole branch is
            // hard-gated off in production.
            if (
                path.startsWith('/api/auth/') ||
                path.startsWith('/api/claim/') ||
                path === '/api/organizations/check-slug'
            ) {
                return true;
            }
        }
        return super.canActivate(context);
    }

    /**
     * EW-P1-2 — the integration principal's own tier (plan doc 02 §2). For an
     * `ew_int_` key the per-route caps (`@Throttle({ long: … })`, 30/min on
     * most writes) do not apply; instead ONE bucket per key and per kind —
     * `INTEGRATION_THROTTLE_WRITES_PER_MIN` (600) for writes and
     * `INTEGRATION_THROTTLE_READS_PER_MIN` (3000) for reads — spans every
     * route, plus the `short` burst tier per key. The `medium` tier is
     * skipped: at 300 per 10 s it would undercut the 3000/min read budget.
     * Every other caller is throttled exactly as before.
     */
    protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
        const { req } = this.getRequestResponse(requestProps.context) as {
            req: ThrottledRequest;
        };
        const keyId = integrationKeyId(req);
        if (!keyId) return super.handleRequest(requestProps);

        const limits = integrationLimits();
        const name = requestProps.throttler.name ?? 'default';
        if (name === 'short') {
            return super.handleRequest({
                ...requestProps,
                limit: limits.burstPerSec,
                ttl: 1000,
                blockDuration: 1000,
                generateKey: () => `integration:${keyId}:burst`,
            });
        }
        if (name === 'long') {
            const write = isWriteMethod(req.method);
            return super.handleRequest({
                ...requestProps,
                limit: write ? limits.writesPerMin : limits.readsPerMin,
                ttl: 60_000,
                blockDuration: 60_000,
                generateKey: () => `integration:${keyId}:${write ? 'writes' : 'reads'}`,
            });
        }
        return true;
    }

    /** EW-P1-2 — an integration key gets `429 rate_limited` in the integration envelope. */
    protected async throwThrottlingException(
        context: ExecutionContext,
        throttlerLimitDetail: ThrottlerLimitDetail,
    ): Promise<void> {
        const { req, res } = this.getRequestResponse(context) as {
            req: ThrottledRequest;
            res: Record<string, any>;
        };
        if (integrationKeyId(req)) {
            // Contract v1 B.1: a 429 carries a plain `Retry-After` (seconds)
            // next to the per-throttler `Retry-After-<name>` the base sets.
            this.setResponseHeader(
                res,
                'Retry-After',
                Math.max(1, Math.ceil(throttlerLimitDetail.timeToBlockExpire)),
            );
            throw new IntegrationHttpException(
                429,
                'rate_limited',
                'Rate limit exceeded for this integration key.',
                {
                    limit: throttlerLimitDetail.limit,
                    ttlMs: throttlerLimitDetail.ttl,
                    retryAfterSeconds: throttlerLimitDetail.timeToBlockExpire,
                },
            );
        }
        return super.throwThrottlingException(context, throttlerLimitDetail);
    }

    protected getTracker(req: ThrottledRequest): Promise<string> {
        const keyId = integrationKeyId(req);
        if (keyId) {
            return Promise.resolve(`integration:${keyId}`);
        }
        const userId = firstString(req.user?.userId, req.user?.id, req.user?.sub);
        if (userId) {
            return Promise.resolve(`user:${userId}`);
        }

        // E2E per-worker bucketing (non-prod only). The suite runs every shard's
        // Playwright workers from ONE machine IP, so platform-bearer endpoints
        // that throttle per-IP (e.g. activity-log ingest) get saturated by
        // CROSS-worker load — one worker's legitimate seed bounces 429 because
        // siblings filled the shared bucket. When Playwright stamps a stable
        // per-worker `x-e2e-throttle-key`, bucket by that instead so each worker
        // is isolated, WHILE a single worker's intentional burst still trips its
        // own bucket (the ingest rate-limit specs keep their 429 coverage).
        // Hard-gated off in production, where no client sends this header.
        if (process.env.NODE_ENV !== 'production') {
            const e2eKey = firstString(req.headers?.['x-e2e-throttle-key']);
            if (e2eKey) {
                return Promise.resolve(`e2e:${e2eKey}`);
            }
        }

        const proxiedIp =
            Array.isArray(req.ips) && typeof req.ips[0] === 'string' ? req.ips[0] : null;
        const ip = firstString(req.ip, proxiedIp, req.socket?.remoteAddress);

        return Promise.resolve(`ip:${ip || 'unknown'}`);
    }
}

/** The integration key id of an `ew_int_` request, else `null`. */
function integrationKeyId(req: ThrottledRequest | undefined): string | null {
    if (req?.user?.authMethod !== 'integration') return null;
    const keyId = req.user.integration?.keyId;
    return typeof keyId === 'string' && keyId.length > 0 ? keyId : null;
}

function firstString(...values: unknown[]): string | null {
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (trimmed.length > 0) return trimmed;
    }

    return null;
}
