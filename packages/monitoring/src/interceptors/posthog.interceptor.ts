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
                        endpoint: originalUrl,
                        statusCode,
                        duration,
                        userAgent: headers['user-agent'],
                        ip: request.ip || request.connection?.remoteAddress,
                        timestamp: new Date().toISOString(),
                    },
                    {
                        endpoint: originalUrl,
                    },
                );

                // Track specific endpoint usage
                trackEvent(
                    user?.id || 'anonymous',
                    `api_${method.toLowerCase()}_${this.getEndpointName(originalUrl)}`,
                    {
                        endpoint: originalUrl,
                        statusCode,
                        duration,
                        timestamp: new Date().toISOString(),
                    },
                );
            }),
        );
    }

    private getEndpointName(url: string): string {
        // Convert URL to a readable endpoint name
        return url
            .replace(/\/\d+/g, '/:id') // Replace numeric IDs with :id
            .replace(/[^a-zA-Z0-9/]/g, '_') // Replace special chars with underscore
            .replace(/^\/+/, '') // Remove leading slashes
            .replace(/\/+/g, '_') // Replace slashes with underscores
            .toLowerCase();
    }
}
