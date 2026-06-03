import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

type ThrottledRequest = Record<string, unknown> & {
    user?: {
        userId?: unknown;
        id?: unknown;
        sub?: unknown;
    };
    url?: unknown;
    originalUrl?: unknown;
    ip?: unknown;
    ips?: unknown;
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
            // `/api/claim/*` is auth-adjacent onboarding (claim a tokenised
            // work-invitation; preview + accept are throttled 10/min/IP). The
            // suite drives many claim probes from the single CI IP, so that cap
            // trips incidentally — and no spec asserts a claim 429 (the claim
            // specs `test.skip` when one surfaces). Skip it alongside the auth
            // routes. NON-auth throttling (ingest / notification / global) stays
            // active, and this whole branch is hard-gated off in production.
            if (path.startsWith('/api/auth/') || path.startsWith('/api/claim/')) {
                return true;
            }
        }
        return super.canActivate(context);
    }

    protected getTracker(req: ThrottledRequest): Promise<string> {
        const userId = firstString(req.user?.userId, req.user?.id, req.user?.sub);
        if (userId) {
            return Promise.resolve(`user:${userId}`);
        }

        const proxiedIp =
            Array.isArray(req.ips) && typeof req.ips[0] === 'string' ? req.ips[0] : null;
        const ip = firstString(req.ip, proxiedIp, req.socket?.remoteAddress);

        return Promise.resolve(`ip:${ip || 'unknown'}`);
    }
}

function firstString(...values: unknown[]): string | null {
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (trimmed.length > 0) return trimmed;
    }

    return null;
}
