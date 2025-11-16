export interface SentryConfig {
    dsn?: string;
    environment?: string;
    tracesSampleRate?: number;
    profilesSampleRate?: number;
    enableLogs?: boolean;
    beforeSend?: (event: any) => any | null;
    beforeSendTransaction?: (event: any) => any | null;
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
