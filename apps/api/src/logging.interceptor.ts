import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { config } from './config/constants';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
    private logger = new Logger('HTTP');

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        if (!config.debug()) {
            return next.handle();
        }

        const now = Date.now();
        const request = context.switchToHttp().getRequest();
        const { method, originalUrl } = request;

        // Health-check / probe endpoints are hit every few seconds by k8s
        // liveness/readiness probes + uptime monitors on every replica, around
        // the clock. We do NOT want their request/response lines in the logs —
        // they're forwarded to PostHog as `$log` events and drown out real
        // signal (and bill per event). We STILL log errors raised inside a
        // health endpoint though (the catchError branch below runs regardless):
        // a failing readiness probe is exactly the signal we want to keep.
        const isHealthProbe = this.isHealthProbePath(originalUrl);

        if (!isHealthProbe) {
            this.logger.log(`Incoming Request: ${method} ${originalUrl}`);
        }

        return next.handle().pipe(
            catchError((err) => {
                const response = err?.response || { statusCode: 500 };
                const { statusCode } = response;
                const delay = Date.now() - now;

                this.logger.error(
                    `Error Response: ${method} ${originalUrl} ${statusCode || 400} - ${delay}ms`,
                );

                return throwError(() => err);
            }),

            tap(() => {
                // Skip the success-response line for health/probe traffic. Errors
                // still go through the catchError branch above and are logged.
                if (isHealthProbe) {
                    return;
                }

                const response = context.switchToHttp().getResponse();
                const { statusCode } = response;
                const delay = Date.now() - now;

                this.logger.log(
                    `Outgoing Response: ${method} ${originalUrl} ${statusCode || 200} - ${delay}ms`,
                );
            }),
        );
    }

    // Match `/api/health` exactly plus the `/api/health/live` + `/api/health/ready`
    // probes under it. Query string / fragment are stripped first. Kept narrow
    // (exact match or `/api/health/` prefix) so an unrelated route like
    // `/api/healthcheck-foo` is still logged normally.
    private isHealthProbePath(url: string): boolean {
        if (!url) return false;
        const path = url.split('?')[0].split('#')[0];
        const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
        return normalized === '/api/health' || normalized.startsWith('/api/health/');
    }
}
