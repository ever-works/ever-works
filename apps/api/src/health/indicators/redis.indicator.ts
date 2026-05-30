import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import Redis from 'ioredis';
import { getRedisUrl } from '../service-detection';

/**
 * Readiness ping for Redis. Only wired into the readiness check when a Redis
 * URL is configured (the platform runs in-memory otherwise), so when present
 * it IS treated as critical — a configured-but-unreachable Redis means the
 * distributed throttler / queues are degraded and the pod should not be
 * considered ready.
 *
 * A fresh short-lived client is used per check (rather than reusing the
 * throttler's connection) to keep the indicator self-contained and avoid
 * coupling readiness to another module's connection lifecycle.
 */
@Injectable()
export class RedisHealthIndicator {
    constructor(private readonly healthIndicatorService: HealthIndicatorService) {}

    async isHealthy(key: string): Promise<HealthIndicatorResult> {
        const indicator = this.healthIndicatorService.check(key);
        const url = getRedisUrl();
        if (!url) {
            // Defensive: the controller only adds this check when configured.
            return indicator.up({ configured: false });
        }

        let client: Redis | undefined;
        try {
            client = new Redis(url, {
                lazyConnect: true,
                connectTimeout: 2000,
                // Cap the PING itself, not just the TCP handshake — a Redis
                // that accepts the socket but stops processing commands (hung
                // replica / bad proxy) would otherwise hang /health/ready.
                commandTimeout: 2000,
                maxRetriesPerRequest: 1,
                enableOfflineQueue: false,
                retryStrategy: () => null,
            });
            await client.connect();
            const startedAt = Date.now();
            const pong = await client.ping();
            const latencyMs = Date.now() - startedAt;
            if (pong !== 'PONG') {
                return indicator.down({ message: `unexpected PING reply: ${pong}` });
            }
            return indicator.up({ latencyMs });
        } catch (err) {
            return indicator.down({ message: (err as Error).message });
        } finally {
            try {
                await client?.quit();
            } catch {
                client?.disconnect();
            }
        }
    }
}
