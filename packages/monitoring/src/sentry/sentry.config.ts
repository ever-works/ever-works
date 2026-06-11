import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { SentryConfig } from '../types';

// Path-anchored auth-URL check: only treat URLs whose pathname starts with
// `/auth` as auth traffic, so unrelated paths like `/authentication` or a
// query string containing `/auth` are not accidentally scrubbed. Falls back
// to substring matching for non-URL strings, and null-guards undefined URLs
// (an event may have no request.url).
const isAuthUrl = (url?: string): boolean => {
    if (!url) {
        return false;
    }
    try {
        const { pathname } = new URL(url);
        // Match the `/auth` path segment exactly, or any sub-path under it
        // (`/auth/login`), but NOT siblings like `/authentication`.
        return pathname === '/auth' || pathname.startsWith('/auth/');
    } catch {
        return url.includes('/auth');
    }
};

export const createSentryConfig = (config?: SentryConfig): any => {
    const defaultConfig = {
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'development',
        tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
        profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
        enableLogs: true, // Enable Sentry Logs by default
        integrations: [nodeProfilingIntegration()],
        beforeSend(event: any) {
            if (isAuthUrl(event.request?.url)) {
                return null;
            }
            return event;
        },
        beforeSendTransaction(event: any) {
            if (isAuthUrl(event.request?.url)) {
                return null;
            }
            return event;
        },
    };

    return {
        ...defaultConfig,
        ...config,
    };
};

export const initSentry = (config?: SentryConfig) => {
    const sentryConfig = createSentryConfig(config);

    if (sentryConfig.dsn) {
        Sentry.init(sentryConfig);
        return true;
    }

    return false;
};

export const getSentryInstance = () => Sentry;
