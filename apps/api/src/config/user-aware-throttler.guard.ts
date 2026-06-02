import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

type ThrottledRequest = Record<string, unknown> & {
    user?: {
        userId?: unknown;
        id?: unknown;
        sub?: unknown;
    };
    ip?: unknown;
    ips?: unknown;
    socket?: {
        remoteAddress?: unknown;
    };
};

@Injectable()
export class UserAwareThrottlerGuard extends ThrottlerGuard {
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
