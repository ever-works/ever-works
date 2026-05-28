import { Logger, LoggerService } from '@nestjs/common';
import { getPostHogClient } from './posthog.config';
import { getSentryInstance } from '../sentry/sentry.config';

/**
 * Service that converts log emits to a string usable as a PostHog event property.
 */
const serializeMessage = (message: unknown): string => {
    if (message === undefined) return '';
    if (message === null) return 'null';
    if (typeof message === 'string') return message;
    if (message instanceof Error) return message.message;
    try {
        return JSON.stringify(message);
    } catch {
        // Fallback for cyclic structures and bigints.
        return String(message);
    }
};

const resolveEnv = (): string =>
    process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development';

type LogLevel = 'log' | 'warn' | 'error' | 'debug' | 'verbose';

/**
 * NestJS `LoggerService` that forwards every log emit to PostHog Logs as a
 * `$log` event while still writing to stdout via the default NestJS Logger
 * (so `kubectl logs` keeps working).
 *
 * - Fail-open: any PostHog / Sentry SDK error is swallowed; console output
 *   is always attempted.
 * - `error(message, trace, context?)` additionally forwards Error instances
 *   to Sentry via `captureException`. `SentryInterceptor` already catches
 *   in-request exceptions, so this only meaningfully fires for errors
 *   logged outside the request path (bootstrap, background jobs,
 *   event handlers). Do NOT pass request-path exceptions here — they will
 *   double-report.
 *
 * Wired into the API in `apps/api/src/main.ts` via `app.useLogger(...)`.
 */
export class PostHogLoggerService implements LoggerService {
    private readonly fallbackLogger: Logger;
    private readonly defaultContext?: string;
    private readonly distinctId: string;

    constructor(context?: string, distinctId: string = 'system') {
        this.defaultContext = context;
        this.distinctId = distinctId;
        this.fallbackLogger = new Logger(context ?? 'PostHogLogger');
    }

    log(message: unknown, context?: string): void {
        this.dispatch('log', message, undefined, context);
    }

    warn(message: unknown, context?: string): void {
        this.dispatch('warn', message, undefined, context);
    }

    /**
     * NestJS `LoggerService.error` is overloaded in practice: callers may pass
     * `(message)`, `(message, context)`, or `(message, trace, context)`. We
     * accept the widest shape so we never reject a legitimate call.
     */
    error(message: unknown, traceOrContext?: string, context?: string): void {
        // Disambiguate the 2-arg form: a value that doesn't look like a stack
        // trace is treated as a context label, matching NestJS' Logger.
        const looksLikeTrace =
            typeof traceOrContext === 'string' &&
            (traceOrContext.includes('\n') || traceOrContext.includes('    at '));
        const trace = looksLikeTrace ? traceOrContext : undefined;
        const ctx = looksLikeTrace ? context : (context ?? traceOrContext);
        this.dispatch('error', message, trace, ctx);
    }

    debug(message: unknown, context?: string): void {
        this.dispatch('debug', message, undefined, context);
    }

    verbose(message: unknown, context?: string): void {
        this.dispatch('verbose', message, undefined, context);
    }

    private dispatch(level: LogLevel, message: unknown, trace?: string, context?: string): void {
        const ctx = context ?? this.defaultContext;

        // 1) ALWAYS write to the console first so a PostHog/Sentry outage can
        //    never silently drop a log emit. `fallbackLogger` wraps NestJS'
        //    default ConsoleLogger.
        try {
            switch (level) {
                case 'log':
                    this.fallbackLogger.log(message as any, ctx);
                    break;
                case 'warn':
                    this.fallbackLogger.warn(message as any, ctx);
                    break;
                case 'error':
                    this.fallbackLogger.error(message as any, trace, ctx);
                    break;
                case 'debug':
                    this.fallbackLogger.debug(message as any, ctx);
                    break;
                case 'verbose':
                    this.fallbackLogger.verbose(message as any, ctx);
                    break;
            }
        } catch {
            // Last-resort console.
            // eslint-disable-next-line no-console
            console.error('[PostHogLoggerService] fallback logger threw', level, message);
        }

        // 2) Forward to PostHog Logs as a `$log` event. Swallow any error.
        try {
            const client = getPostHogClient();
            if (client) {
                const properties: Record<string, unknown> = {
                    level,
                    message: serializeMessage(message),
                    context: ctx,
                    service: 'ever-works-api',
                    env: resolveEnv()
                };
                if (message instanceof Error) {
                    properties.error_name = message.name;
                    properties.error_stack = message.stack;
                }
                if (trace) {
                    properties.trace = trace;
                }
                client.capture({
                    distinctId: this.distinctId,
                    event: '$log',
                    properties
                });
            }
        } catch {
            // Swallow — logs must never break the caller.
        }

        // 3) For Error-typed `error()` calls, additionally forward to Sentry's
        //    `captureException`. SentryInterceptor already covers exceptions
        //    that surface through the request path, so this only meaningfully
        //    fires for errors logged outside that path.
        if (level === 'error' && message instanceof Error) {
            try {
                const sentry = getSentryInstance();
                sentry?.captureException(message);
            } catch {
                // Swallow.
            }
        }
    }
}
