import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import {
    HealthCheck,
    HealthCheckResult,
    HealthCheckService,
    HealthIndicatorFunction,
    TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { Public } from '../auth';
import { getBuildInfo, BuildInfo } from './build-info';
import { detectInformationalServices, getRedisUrl } from './service-detection';
import { RedisHealthIndicator } from './indicators/redis.indicator';
import { ConfiguredServiceHealthIndicator } from './indicators/configured-service.indicator';

// Tight CSP for JSON-only API endpoints — mirrors APIController. The
// csp-strict e2e contract pins that EVERY API surface declares a CSP, so
// each handler sets it explicitly as belt-and-braces against the helmet
// header being dropped on some Node 22 + Express paths.
const API_JSON_CSP =
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * Standard health + version surface, additive to the existing trivial
 * `GET /api/health` / `GET /` in `APIController` (kept for backward compat
 * and current k8s liveness probes).
 *
 * - `GET /api/version`      — build/release identity (footer + ops).
 * - `GET /api/health/live`  — liveness (process up).
 * - `GET /api/health/ready` — readiness: DB (+ Redis if configured) are
 *   critical; AI/Sentry/PostHog/Trigger.dev/Stripe/email/storage are
 *   reported informationally. Embeds the version block on success.
 *
 * All endpoints are `@Public()` (k8s probes + the unauthenticated web footer
 * call them) and JSON-only, so the response is safe to expose publicly: it
 * carries up/down + configured flags, never any secret values.
 */
@ApiTags('Health')
@Controller()
export class HealthController {
    constructor(
        private readonly health: HealthCheckService,
        private readonly db: TypeOrmHealthIndicator,
        private readonly redis: RedisHealthIndicator,
        private readonly services: ConfiguredServiceHealthIndicator,
    ) {}

    @Public()
    @Get('api/version')
    @Header('Content-Security-Policy', API_JSON_CSP)
    @Header('Cache-Control', 'public, max-age=300')
    @ApiOperation({
        summary: 'Build version',
        description:
            'Build/release identity of the running API (version + commit/build coordinates). Safe to call without auth; cache-friendly.',
    })
    @ApiResponse({ status: 200, description: 'Build info' })
    version(): BuildInfo {
        return getBuildInfo();
    }

    @Public()
    @Get('api/health/live')
    @Header('Content-Security-Policy', API_JSON_CSP)
    @HealthCheck()
    @ApiOperation({
        summary: 'Liveness probe',
        description: 'Returns OK while the process is up. Cheap — checks no dependencies.',
    })
    @ApiResponse({ status: 200, description: 'API process is alive' })
    live(): Promise<HealthCheckResult> {
        return this.health.check([]);
    }

    @Public()
    @Get('api/health/ready')
    @Header('Content-Security-Policy', API_JSON_CSP)
    @HealthCheck()
    @ApiOperation({
        summary: 'Readiness probe',
        description:
            'Reports the status of every third-party dependency. Database (and Redis, if configured) are critical and return 503 when down; AI provider / Sentry / PostHog / Trigger.dev / Stripe / email / storage are reported informationally. Includes the build version.',
    })
    @ApiResponse({ status: 200, description: 'API is ready; details list per-dependency status' })
    @ApiResponse({ status: 503, description: 'A critical dependency is unavailable' })
    async ready(): Promise<HealthCheckResult & { version: BuildInfo }> {
        const checks: HealthIndicatorFunction[] = [
            () => this.db.pingCheck('database', { timeout: 3000 }),
        ];

        if (getRedisUrl()) {
            checks.push(() => this.redis.isHealthy('redis'));
        }

        for (const service of detectInformationalServices()) {
            checks.push(() => this.services.report(service));
        }

        const result = await this.health.check(checks);
        return { ...result, version: getBuildInfo() };
    }
}
