import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { trackEvent } from '../posthog/posthog.config';

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

                // Track specific endpoint usage
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
            }),
        );
    }

    // Security: return only the URL pathname, dropping the query string and fragment so
    // that secrets embedded in query parameters never reach PostHog.
    private getEndpointPath(url: string): string {
        if (!url) return url;
        return url.split('?')[0].split('#')[0];
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
