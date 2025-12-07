import { Injectable } from '@nestjs/common';
import { getSentryInstance } from '../sentry/sentry.config';
import * as Sentry from '@sentry/nestjs';

@Injectable()
export class SentryService {
    private sentry = getSentryInstance();

    /**
     * Get the Sentry logger instance
     * Use this to send structured logs to Sentry
     *
     * @example
     * ```typescript
     * this.sentryService.getLogger().info('User logged in', { userId: '123' });
     * this.sentryService.getLogger().error('Payment failed', { orderId: '456' });
     * ```
     */
    getLogger(): typeof Sentry.logger {
        return this.sentry.logger;
    }

    /**
     * Log a trace message
     */
    trace(message: string, context?: Record<string, any>) {
        this.sentry.logger.trace(message, context);
    }

    /**
     * Log a debug message
     */
    debug(message: string, context?: Record<string, any>) {
        this.sentry.logger.debug(message, context);
    }

    /**
     * Log an info message
     */
    info(message: string, context?: Record<string, any>) {
        this.sentry.logger.info(message, context);
    }

    /**
     * Log a warning message
     */
    warn(message: string, context?: Record<string, any>) {
        this.sentry.logger.warn(message, context);
    }

    /**
     * Log an error message
     */
    error(message: string, context?: Record<string, any>) {
        this.sentry.logger.error(message, context);
    }

    /**
     * Log a fatal message
     */
    fatal(message: string, context?: Record<string, any>) {
        this.sentry.logger.fatal(message, context);
    }

    /**
     * Capture an exception
     */
    captureException(exception: any, context?: any) {
        return this.sentry.captureException(exception, context);
    }

    /**
     * Capture a message
     */
    captureMessage(message: string, level?: any) {
        return this.sentry.captureMessage(message, level);
    }

    /**
     * Set user context
     */
    setUser(user: { id?: string; email?: string; username?: string; [key: string]: any }) {
        this.sentry.setUser(user);
    }

    /**
     * Set additional context
     */
    setContext(name: string, context: Record<string, any>) {
        this.sentry.setContext(name, context);
    }

    /**
     * Set a tag
     */
    setTag(key: string, value: string) {
        this.sentry.setTag(key, value);
    }

    /**
     * Set multiple tags
     */
    setTags(tags: Record<string, string>) {
        this.sentry.setTags(tags);
    }

    /**
     * Check if Sentry is initialized
     */
    isInitialized(): boolean {
        // Check if DSN is configured, which indicates Sentry is initialized
        return !!process.env.SENTRY_DSN;
    }
}
