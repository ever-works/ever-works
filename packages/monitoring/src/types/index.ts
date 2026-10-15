export interface SentryConfig {
    dsn?: string;
    environment?: string;
    tracesSampleRate?: number;
    /** Sentry v11 profiling session sample rate (replaces `profilesSampleRate`). */
    profileSessionSampleRate?: number;
    /** @deprecated Removed in Sentry v11; mapped to `profileSessionSampleRate`. */
    profilesSampleRate?: number;
    /** @deprecated Removed in Sentry v11 (logs are sent whenever `Sentry.logger` is used); ignored by the SDK. */
    enableLogs?: boolean;
    beforeSend?: (event: any) => any | null;
    /** @deprecated No-op in Sentry v11 (span streaming); use `beforeSendSpan`. */
    beforeSendTransaction?: (event: any) => any | null;
    beforeSendSpan?: (span: any) => any;
}

export interface PostHogConfig {
    apiKey?: string;
    host?: string;
    flushAt?: number;
    flushInterval?: number;
}

export interface MonitoringConfig {
    sentry?: SentryConfig;
    posthog?: PostHogConfig;
}

export interface AnalyticsEvent {
    distinctId: string;
    event: string;
    properties?: Record<string, any>;
    groups?: Record<string, string | number>;
}

export interface UserProperties {
    distinctId: string;
    properties: Record<string, any>;
}

export interface ApiUsageEvent {
    distinctId: string;
    endpoint: string;
    method: string;
    statusCode: number;
    duration: number;
}

export interface AuthEvent {
    distinctId: string;
    event: 'login' | 'logout' | 'register' | 'password_reset';
    properties?: Record<string, any>;
}

export interface BusinessEvent {
    distinctId: string;
    event: string;
    properties?: Record<string, any>;
}
