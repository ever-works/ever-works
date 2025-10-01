import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import * as Sentry from '@sentry/nestjs';

@Injectable()
export class SentryInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        const request = context.switchToHttp().getRequest();
        const { method, originalUrl, headers, body } = request;

        if (request.user) {
            Sentry.setUser({
                id: request.user.id,
                email: request.user.email,
                username: request.user.username,
            });
        }

        // Set request context
        Sentry.setContext('request', {
            method,
            url: originalUrl,
            headers: this.sanitizeHeaders(headers),
            body: this.sanitizeBody(body),
        });

        Sentry.setTag('transaction', `${method} ${originalUrl}`);

        return next.handle().pipe(
            catchError((error) => {
                Sentry.captureException(error, {
                    tags: {
                        endpoint: `${method} ${originalUrl}`,
                        statusCode: error.status || 500,
                    },
                    extra: {
                        requestBody: this.sanitizeBody(body),
                        userAgent: headers['user-agent'],
                    },
                });

                return throwError(() => error);
            }),
        );
    }

    private sanitizeHeaders(headers: any): any {
        const sanitized = { ...headers };
        delete sanitized.authorization;
        delete sanitized.cookie;
        return sanitized;
    }

    private sanitizeBody(body: any): any {
        if (!body) return body;

        const sanitized = { ...body };
        delete sanitized.password;
        delete sanitized.token;
        delete sanitized.secret;
        return sanitized;
    }
}
