import {
    ArgumentsHost,
    CallHandler,
    Catch,
    ExceptionFilter,
    ExecutionContext,
    HttpException,
    HttpStatus,
    Injectable,
    Logger,
    NestInterceptor,
    NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { SHARED_VIEW_LIMITS, SHARED_VIEW_NOT_ACTIVE } from '@ever-works/contracts/api';
import { redactSecretValue } from '@ever-works/monitoring';
import { readBearerSession, sessionThrottleBucket } from './shared-view-session.service';

/**
 * Shared view — the HTTP posture of every public share-link response.
 *
 * Three pieces, one file, so the posture cannot be applied halfway:
 *   - the security headers, set by an interceptor on success and by the
 *     exception filter on every refusal (a guard or throttle refusal never
 *     reaches an interceptor);
 *   - the exception filter, which makes every refusal cause the SAME bytes;
 *   - the throttle buckets: per token (or per view) and per client.
 */

/** Set on a request once the resolved view allows crawlers; the robots header is then omitted. */
export const SHARED_VIEW_INDEXABLE_KEY = 'sharedViewIndexable';

export const SHARED_VIEW_ROBOTS_DIRECTIVE = 'noindex, nofollow, noarchive, nosnippet';

interface HeaderResponse {
    setHeader(name: string, value: string | number): unknown;
    removeHeader(name: string): unknown;
}

/** No shared cache, no referrer, no sniffing, and crawlers blocked unless the view says otherwise. */
export function applySharedViewHeaders(response: HeaderResponse, indexable: boolean): void {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (indexable) {
        response.removeHeader('X-Robots-Tag');
    } else {
        response.setHeader('X-Robots-Tag', SHARED_VIEW_ROBOTS_DIRECTIVE);
    }
}

@Injectable()
export class SharedViewPublicHeadersInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
        const http = context.switchToHttp();
        const request = http.getRequest<Record<string, unknown>>();
        const response = http.getResponse<HeaderResponse>();
        applySharedViewHeaders(response, false);
        return next
            .handle()
            .pipe(
                tap(() =>
                    applySharedViewHeaders(response, request[SHARED_VIEW_INDEXABLE_KEY] === true),
                ),
            );
    }
}

/** The one body every "not active" refusal carries, whatever its cause. */
export const SHARED_VIEW_NOT_ACTIVE_BODY = Object.freeze({
    statusCode: HttpStatus.NOT_FOUND,
    message: SHARED_VIEW_NOT_ACTIVE,
    error: 'Not Found',
});

export const SHARED_VIEW_THROTTLED_BODY = Object.freeze({
    statusCode: HttpStatus.TOO_MANY_REQUESTS,
    message: 'shared_view_throttled',
    error: 'Too Many Requests',
});

interface JsonResponse extends HeaderResponse {
    status(code: number): JsonResponse;
    json(body: unknown): unknown;
    headersSent?: boolean;
}

/**
 * Every refusal from a public share-link route:
 *   - any 404 → the identical not-active body, so unknown, regenerated-away,
 *     paused and deleted links (and every stale view session) are
 *     indistinguishable;
 *   - a throttle → 429 with `Retry-After: 60`;
 *   - any other HTTP error → its own status and body;
 *   - anything else → a generic 500 with no message, logged by the error's
 *     class name only.
 * The security headers are applied to all of them.
 */
@Catch()
export class SharedViewPublicExceptionFilter implements ExceptionFilter {
    private readonly logger = new Logger('SharedViewPublic');

    catch(exception: unknown, host: ArgumentsHost): void {
        const response = host.switchToHttp().getResponse<JsonResponse>();
        if (response.headersSent) return;
        applySharedViewHeaders(response, false);

        if (exception instanceof HttpException) {
            const status = exception.getStatus();
            if (status === HttpStatus.NOT_FOUND || exception instanceof NotFoundException) {
                response.status(HttpStatus.NOT_FOUND).json(SHARED_VIEW_NOT_ACTIVE_BODY);
                return;
            }
            if (status === HttpStatus.TOO_MANY_REQUESTS) {
                response.setHeader('Retry-After', SHARED_VIEW_LIMITS.retryAfterSeconds);
                response.status(HttpStatus.TOO_MANY_REQUESTS).json(SHARED_VIEW_THROTTLED_BODY);
                return;
            }
            response.status(status).json(exception.getResponse());
            return;
        }

        // Only the error's class name is logged: a message can carry request
        // input, and nothing a visitor sent belongs in a log line.
        const name =
            exception instanceof Error ? redactSecretValue(exception.name) : typeof exception;
        this.logger.error(`Shared view public request failed: ${name}`);
        response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
            statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
            message: 'Internal server error',
        });
    }
}

// ── Throttle buckets ────────────────────────────────────────────────

type ThrottledRequest = {
    body?: { token?: unknown } | null;
    headers?: Record<string, unknown>;
    ip?: unknown;
    ips?: unknown;
    socket?: { remoteAddress?: unknown };
};

function firstString(...values: unknown[]): string | null {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    }
    return null;
}

/** Per token: `sha256` of the presented token, so the bucket key never holds the token itself. */
export function sharedViewTokenTracker(request: ThrottledRequest): string {
    const token = request.body?.token;
    if (typeof token !== 'string' || token.length === 0) return 'token:none';
    return `token:${createHash('sha256').update(token.slice(0, 256)).digest('hex')}`;
}

/** Per view: the Shared view a presented session names. */
export function sharedViewSessionTracker(request: ThrottledRequest): string {
    return sessionThrottleBucket(readBearerSession(request.headers?.authorization));
}

/**
 * Per client: the same client identity the platform throttler uses (the
 * proxy-resolved IP, or the per-worker end-to-end key outside production).
 */
export function sharedViewClientTracker(request: ThrottledRequest): string {
    if (process.env.NODE_ENV !== 'production') {
        const e2eKey = firstString(request.headers?.['x-e2e-throttle-key']);
        if (e2eKey) return `e2e:${e2eKey}`;
    }
    const proxied = Array.isArray(request.ips) ? request.ips[0] : null;
    const ip = firstString(request.ip, proxied, request.socket?.remoteAddress);
    return `ip:${ip ?? 'unknown'}`;
}

/**
 * One bucket per tracker across EVERY public share-link route, rather than the
 * throttler's default of one bucket per handler — so "600 per hour per
 * client" is 600 across the exchange and the reads together.
 */
export function sharedViewThrottleKey(
    _context: ExecutionContext,
    tracker: string,
    throttlerName: string,
): string {
    return createHash('sha256')
        .update(`shared-view-public:${throttlerName}:${tracker}`)
        .digest('hex');
}
