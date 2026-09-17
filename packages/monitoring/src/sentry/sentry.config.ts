import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { SentryConfig } from '../types';
import { redactSecretUrl } from '../redaction/secret-url';

/**
 * Remove share tokens and view sessions from everything an event records as
 * an address: the request URL, the transaction name and breadcrumb URLs.
 * Mutates and returns the event, as Sentry's hooks expect.
 */
export const redactSentryEventUrls = (event: any): any => {
    if (!event || typeof event !== 'object') {
        return event;
    }
    if (event.request && typeof event.request.url === 'string') {
        event.request.url = redactSecretUrl(event.request.url);
    }
    if (typeof event.transaction === 'string') {
        event.transaction = redactSecretUrl(event.transaction);
    }
    if (Array.isArray(event.breadcrumbs)) {
        for (const crumb of event.breadcrumbs) {
            if (crumb && crumb.data && typeof crumb.data.url === 'string') {
                crumb.data.url = redactSecretUrl(crumb.data.url);
            }
            if (crumb && typeof crumb.message === 'string') {
                crumb.message = redactSecretUrl(crumb.message);
            }
        }
    }
    return event;
};

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
            return redactSentryEventUrls(event);
        },
        beforeSendTransaction(event: any) {
            if (isAuthUrl(event.request?.url)) {
                return null;
            }
            return redactSentryEventUrls(event);
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
