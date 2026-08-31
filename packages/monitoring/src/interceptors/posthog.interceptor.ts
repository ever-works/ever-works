import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { trackEvent } from '../posthog/posthog.config';

/**
 * Route prefixes that are MACHINE traffic, never product usage. Every one of
 * these is polled around the clock by infrastructure, so recording them as
 * analytics both bills per event and drowns the real signal.
 *
 * Measured on 2026-08-31 (PostHog project 144390): these paths accounted for
 * ~99% of ~110k events/day while genuine product events ran at 0-13/day.
 *   - `/api/health*`   — k8s liveness + readiness probes on every replica.
 *   - `/api/version`   — synthetic monitoring. `vmprobe-ever-works-{dev,stage,
 *     prod}` scrape it every 60s and VMAgent runs 3 replicas that each scrape
 *     independently: 5 URLs x 3 replicas = 15 hits/min. The events arrived
 *     with user agent `Blackbox Exporter/0.25.0` (43,188 in 2 days).
 *   - `/api/info`      — ops metadata, probed the same way.
 *   - `/internal/*`    — machine-to-machine calls. `/internal/trigger/remote/
 *     call` alone produced 33,180 events in 2 days (user agent `node`).
 *   - `/.well-known/*` — agent/protocol discovery, fetched by clients not users.
 *   - `/metrics`       — Prometheus scrape endpoint.
 *
 * Matching is EXACT-or-followed-by-`/` so a real product route that merely
 * shares a prefix (`/api/versions-of-my-doc`, `/api/healthcheck-foo`) is still
 * tracked. Extend at runtime with `POSTHOG_ANALYTICS_EXCLUDE_PATHS` (a
 * comma-separated prefix list) rather than editing this array for a one-off.
 */
const DEFAULT_EXCLUDED_PATH_PREFIXES: readonly string[] = [
    '/api/health',
    '/api/version',
    '/api/info',
    '/internal',
    '/.well-known',
    '/metrics',
];

/**
 * Opt-in restore of the per-endpoint `api_<method>_<path>` companion event.
 *
 * It used to fire on EVERY request alongside `api_request`, which was exact
 * 1:1 duplication: over 3 days `api_request` = 129,426 against 129,205 summed
 * per-endpoint events. Nothing analytical is lost by defaulting it off —
 * `api_request` already carries the same value in its `endpoint` property, and
 * keeping one event name avoids unbounded event-name cardinality in PostHog.
 */
const trackPerEndpointEvents = (): boolean =>
    /^(true|1|yes|on)$/i.test((process.env.POSTHOG_TRACK_PER_ENDPOINT_EVENTS ?? '').trim());

const extraExcludedPrefixes = (): string[] =>
    (process.env.POSTHOG_ANALYTICS_EXCLUDE_PATHS ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);

@Injectable()
export class PostHogInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        const request = context.switchToHttp().getRequest();
        const response = context.switchToHttp().getResponse();
        const { method, originalUrl, headers, body, user } = request;

        // Security: strip the query string (and fragment) before forwarding the URL to
        // PostHog. Query params frequently carry secrets (?token=, ?code=, ?reset_token=,
        // ?api_key=) that must not be persisted in third-party analytics.
        const endpointPath = this.getEndpointPath(originalUrl);

        // Do NOT record analytics for infrastructure traffic — health probes,
        // synthetic monitoring, internal machine-to-machine calls. These run around
        // the clock on every replica and bill per event while telling us nothing
        // about real product usage. See DEFAULT_EXCLUDED_PATH_PREFIXES for the list
        // and the measurements behind it.
        if (this.isExcludedPath(endpointPath)) {
            return next.handle();
        }

        const startTime = Date.now();

        return next.handle().pipe(
            tap(() => {
                const endTime = Date.now();
                const duration = endTime - startTime;
                const statusCode = response.statusCode;

                trackEvent(
                    user?.id || 'anonymous',
                    'api_request',
                    {
                        method,
                        endpoint: endpointPath,
                        statusCode,
                        duration,
                        userAgent: headers['user-agent'],
                        ip: request.ip || request.connection?.remoteAddress,
                        timestamp: new Date().toISOString(),
                    },
                    {
                        endpoint: endpointPath,
                    },
                );

                // Track specific endpoint usage. OFF by default: this duplicated
                // `api_request` 1:1 and doubled the event bill for no added signal
                // (the endpoint is already a property above). Re-enable with
                // POSTHOG_TRACK_PER_ENDPOINT_EVENTS=true if a dashboard needs
                // per-endpoint event NAMES rather than a breakdown by property.
                if (trackPerEndpointEvents()) {
                    trackEvent(
                        user?.id || 'anonymous',
                        `api_${method.toLowerCase()}_${this.getEndpointName(endpointPath)}`,
                        {
                            endpoint: endpointPath,
                            statusCode,
                            duration,
                            timestamp: new Date().toISOString(),
                        },
                    );
                }
            }),
        );
    }

    // Security: return only the URL pathname, dropping the query string and fragment so
    // that secrets embedded in query parameters never reach PostHog.
    private getEndpointPath(url: string): string {
        if (!url) return url;
        return url.split('?')[0].split('#')[0];
    }

    // Infrastructure endpoints we never want in analytics: health probes, synthetic
    // monitoring, internal machine calls, protocol discovery, metrics. Kept narrow —
    // a prefix matches only on an EXACT hit or when followed by `/` — so an unrelated
    // route like `/api/healthcheck-foo` or `/api/versions-of-my-doc` is NOT silently
    // dropped. Operators can add prefixes via POSTHOG_ANALYTICS_EXCLUDE_PATHS without
    // a code change.
    private isExcludedPath(path: string): boolean {
        if (!path) return false;
        const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
        return [...DEFAULT_EXCLUDED_PATH_PREFIXES, ...extraExcludedPrefixes()].some(
            (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
        );
    }

    private getEndpointName(url: string): string {
        // Convert URL to a readable endpoint name.
        // Security: collapse high-entropy path segments (long values, UUIDs, slugs,
        // emails, tokens) to ":id" and cap the overall length so attacker-controlled
        // path components cannot flood the PostHog event namespace with unbounded
        // unique event names or leak user identifiers into analytics dashboards.
        const slug = url
            .replace(/\/\d+/g, '/:id') // Replace numeric IDs with :id
            .split('/')
            .map((segment) => (this.isHighEntropySegment(segment) ? ':id' : segment))
            .join('/')
            .replace(/[^a-zA-Z0-9/]/g, '_') // Replace special chars with underscore
            .replace(/^\/+/, '') // Remove leading slashes
            .replace(/\/+/g, '_') // Replace slashes with underscores
            .toLowerCase();

        // Security: hard length cap to bound event-name cardinality.
        return slug.length > 200 ? slug.slice(0, 200) : slug;
    }

    // Security: treat segments that look like identifiers/PII rather than static route
    // names (overly long, contain "@", or carry digits) as opaque, so they collapse to
    // a single ":id" token instead of becoming distinct event names.
    private isHighEntropySegment(segment: string): boolean {
        if (!segment || segment === ':id') return false;
        return segment.length > 40 || segment.includes('@') || /\d/.test(segment);
    }
}
