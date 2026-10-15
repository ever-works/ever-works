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

// The API mounts its auth controller at `/api/auth` (this app has no global
// prefix; every controller carries `api/`), so match that as well as a bare
// `/auth`. Before 2026-10-15 only `/auth` was matched, so real auth traffic was
// never dropped.
const AUTH_PATH_PREFIXES = ['/auth', '/api/auth'];
const isAuthPathname = (pathname: string): boolean =>
    AUTH_PATH_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

// Path-anchored auth-URL check: only treat URLs whose pathname is an auth path
// (see AUTH_PATH_PREFIXES) as auth traffic, so unrelated paths like
// `/authentication` or a query string containing `/auth` are not accidentally
// scrubbed. Falls back to substring matching for non-URL strings, and
// null-guards undefined URLs (an event may have no request.url).
const isAuthUrl = (url?: string): boolean => {
    if (!url) {
        return false;
    }
    try {
        const { pathname } = new URL(url);
        // Match the auth path segment exactly, or any sub-path under it
        // (`/api/auth/login`), but NOT siblings like `/authentication`.
        return isAuthPathname(pathname);
    } catch {
        return url.includes('/auth');
    }
};

// The same rule for the path Sentry's HTTP integration hands to
// `ignoreIncomingRequests` (a path, possibly with a query string, never a full
// URL): `/api/auth`, `/auth` or anything under them, never `/authentication`,
// and never a query string that merely mentions `/auth`.
export const isAuthPath = (urlPath?: string): boolean => {
    if (!urlPath) {
        return false;
    }
    return isAuthPathname(urlPath.split(/[?#]/)[0]);
};

/**
 * Remove share tokens and view sessions from a streamed span (Sentry v11): its
 * name (`GET /share/<token>`) and every `url.*` / `http.*` string attribute.
 * Mutates and returns the span, as `beforeSendSpan` expects; it cannot drop it.
 */
export const redactSentrySpanUrls = (span: any): any => {
    if (!span || typeof span !== 'object') {
        return span;
    }
    if (typeof span.name === 'string') {
        span.name = redactSecretUrl(span.name);
    }
    if (span.attributes && typeof span.attributes === 'object') {
        for (const key of Object.keys(span.attributes)) {
            const value = span.attributes[key];
            if (typeof value === 'string' && (key.startsWith('url.') || key.startsWith('http.'))) {
                span.attributes[key] = redactSecretUrl(value);
            }
        }
    }
    return span;
};

// The privacy baseline Sentry v10 applied when `sendDefaultPii` was unset (which
// it is here). v11 replaced that option with `dataCollection` and, when it is
// left unset, now collects cookies, request/response bodies, user info,
// database queries and GenAI inputs/outputs by default. Keep the v10 baseline.
// Values are the ones the v11 migration guide gives for "keep the v10 default".
const SENSITIVE_KEY_DENYLIST = ['forwarded', '-ip', 'remote-', 'via', '-user'];
export const SENTRY_DATA_COLLECTION = {
    userInfo: false,
    cookies: false,
    httpHeaders: {
        request: { deny: SENSITIVE_KEY_DENYLIST },
        response: { deny: SENSITIVE_KEY_DENYLIST },
    },
    httpBodies: [],
    urlQueryParams: { deny: SENSITIVE_KEY_DENYLIST },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    graphQL: { document: false, variables: false },
};

export const createSentryConfig = (config?: SentryConfig): any => {
    // Pull out the fields resolved below so an explicit `undefined` in `rest`
    // cannot overwrite the computed value.
    const {
        profilesSampleRate,
        profileSessionSampleRate,
        beforeSendSpan: callerBeforeSendSpan,
        ...rest
    } = config ?? {};
    const defaultConfig = {
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'development',
        tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
        // v11 removed `profilesSampleRate`. The session rate plus the `trace`
        // lifecycle profile the sampled root spans, as the old option did. A
        // caller's legacy `profilesSampleRate` still sets the session rate.
        profileSessionSampleRate:
            profileSessionSampleRate ??
            profilesSampleRate ??
            (process.env.NODE_ENV === 'production' ? 0.1 : 1.0),
        profileLifecycle: 'trace' as const,
        // v11 removed `enableLogs`: logs are sent whenever `Sentry.logger.*` is
        // called (SentryService does), so there is nothing left to switch on.
        dataCollection: SENTRY_DATA_COLLECTION,
        integrations: [
            nodeProfilingIntegration(),
            // v11 streams spans, so `beforeSendTransaction` no longer runs and
            // cannot drop `/auth` traffic. Skip those requests before a span
            // exists instead.
            Sentry.httpIntegration({
                ignoreIncomingRequests: (urlPath: string) => isAuthPath(urlPath),
            }),
        ],
        beforeSend(event: any) {
            if (isAuthUrl(event.request?.url)) {
                return null;
            }
            return redactSentryEventUrls(event);
        },
        // Streamed-span replacement for the redaction `beforeSendTransaction`
        // used to do on the transaction. A caller's own `beforeSendSpan` runs
        // first and cannot switch the redaction off.
        beforeSendSpan(span: any) {
            const result = callerBeforeSendSpan ? callerBeforeSendSpan(span) : span;
            return redactSentrySpanUrls(result ?? span);
        },
    };

    return {
        ...defaultConfig,
        ...rest,
    };
};

export const initSentry = (config?: SentryConfig) => {
    // The API calls initSentry() in main.ts and MonitoringModule calls it again
    // through SentryModule.forRoot(). Sentry v11 warns that a second init
    // replaces the active client without closing it, so state can mix. Keep
    // the first client.
    if (Sentry.getClient?.()) {
        return true;
    }
    const sentryConfig = createSentryConfig(config);

    if (sentryConfig.dsn) {
        Sentry.init(sentryConfig);
        return true;
    }

    return false;
};

export const getSentryInstance = () => Sentry;
