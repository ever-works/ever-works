import { Logger } from '@nestjs/common';
import { LoggerService, LogLevel } from '@nestjs/common';
import { logger as triggerLogger } from '@trigger.dev/sdk';

/**
 * TriggerLogger - A custom NestJS LoggerService that forwards logs to trigger.dev's logger.
 *
 * When running inside a trigger.dev task, NestJS's default logger outputs to stdout/stderr,
 * but these logs don't appear in the trigger.dev dashboard. This adapter forwards all logs
 * to trigger.dev's structured logger, making them visible in the run log.
 *
 * @see https://trigger.dev/docs/logging
 */
export class TriggerLogger implements LoggerService {
    private context?: string;
    private nestjsLogger: Logger;

    constructor(context?: string) {
        this.context = context;
        this.nestjsLogger = new Logger(context);
    }

    setContext(context: string) {
        this.context = context;
    }

    private formatMessage(message: unknown, context?: string): string {
        const ctx = context || this.context;
        const prefix = ctx ? `[${ctx}] ` : '';
        return `${prefix}${String(message)}`;
    }

    private extractOptionalParams(optionalParams: unknown[]): {
        context?: string;
        data: Record<string, unknown>;
    } {
        let context: string | undefined;
        const data: Record<string, unknown> = {};

        for (const param of optionalParams) {
            if (typeof param === 'string') {
                context = param;
            } else if (param instanceof Error) {
                data.error = param.message;
                data.stack = param.stack;
            } else if (typeof param === 'object' && param !== null) {
                Object.assign(data, param);
            }
        }

        return { context, data };
    }

    log(message: unknown, ...optionalParams: unknown[]): void {
        const { context, data } = this.extractOptionalParams(optionalParams);
        const formattedMessage = this.formatMessage(message, context);

        if (Object.keys(data).length > 0) {
            triggerLogger.log(formattedMessage, data);
        } else {
            triggerLogger.log(formattedMessage, {});
        }

        this.nestjsLogger.log(message, context);
    }

    error(message: unknown, ...optionalParams: unknown[]): void {
        const { context, data } = this.extractOptionalParams(optionalParams);
        const formattedMessage = this.formatMessage(message, context);

        if (Object.keys(data).length > 0) {
            triggerLogger.error(formattedMessage, data);
        } else {
            triggerLogger.error(formattedMessage, {});
        }

        this.nestjsLogger.error(message, context);
    }

    warn(message: unknown, ...optionalParams: unknown[]): void {
        const { context, data } = this.extractOptionalParams(optionalParams);
        const formattedMessage = this.formatMessage(message, context);

        if (Object.keys(data).length > 0) {
            triggerLogger.warn(formattedMessage, data);
        } else {
            triggerLogger.warn(formattedMessage, {});
        }

        this.nestjsLogger.warn(message, context);
    }

    debug?(message: unknown, ...optionalParams: unknown[]): void {
        const { context, data } = this.extractOptionalParams(optionalParams);
        const formattedMessage = this.formatMessage(message, context);

        if (Object.keys(data).length > 0) {
            triggerLogger.debug(formattedMessage, data);
        } else {
            triggerLogger.debug(formattedMessage, {});
        }

        this.nestjsLogger.debug?.(message, context);
    }

    verbose?(message: unknown, ...optionalParams: unknown[]): void {
        const { context, data } = this.extractOptionalParams(optionalParams);
        const formattedMessage = this.formatMessage(message, context);

        if (Object.keys(data).length > 0) {
            triggerLogger.debug(formattedMessage, { level: 'verbose', ...data });
        } else {
            triggerLogger.debug(formattedMessage, { level: 'verbose' });
        }

        this.nestjsLogger.verbose?.(message, context);
    }

    fatal?(message: unknown, ...optionalParams: unknown[]): void {
        const { context, data } = this.extractOptionalParams(optionalParams);
        const formattedMessage = this.formatMessage(message, context);

        if (Object.keys(data).length > 0) {
            triggerLogger.error(formattedMessage, { level: 'fatal', ...data });
        } else {
            triggerLogger.error(formattedMessage, { level: 'fatal' });
        }

        this.nestjsLogger.error(message, context);
    }

    setLogLevels?(_levels: LogLevel[]): void {
        // trigger.dev logger doesn't support setting log levels dynamically
        // All levels are always enabled in the dashboard
    }
}

export function createTriggerLogger(context?: string): TriggerLogger {
    return new TriggerLogger(context);
}
