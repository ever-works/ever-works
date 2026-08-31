import { PostHog } from 'posthog-node';
import { PostHogConfig } from '../types';

let posthogClient: PostHog | null = null;

export const initPostHog = (config?: PostHogConfig) => {
    const apiKey = config?.apiKey || process.env.POSTHOG_API_KEY;
    const host = config?.host || process.env.POSTHOG_HOST || 'https://app.posthog.com';
    const flushAt = config?.flushAt || 20;
    const flushInterval = config?.flushInterval || 10000;

    if (apiKey) {
        posthogClient = new PostHog(apiKey, {
            host,
            flushAt,
            flushInterval,
        });
        return true;
    }

    return false;
};

export const getPostHogClient = (): PostHog | null => {
    return posthogClient;
};

/**
 * Master kill switch for ALL PostHog capture (events, `$log`, identify).
 *
 * Before this existed the only way to stop capture was to unset
 * `POSTHOG_API_KEY`, which also disabled feature flags and made the failure
 * mode "analytics silently gone" rather than a deliberate choice. An explicit
 * switch lets a non-production environment keep the client configured while
 * sending nothing — which is how `dev` and `stage` stop billing against the
 * shared project's event allowance.
 *
 * Defaults to ENABLED, so an unset variable never changes existing behaviour.
 * Anything in {false, 0, no, off} (case-insensitive) turns capture off.
 */
export const isCaptureEnabled = (): boolean => {
    const raw = process.env.POSTHOG_CAPTURE_ENABLED;
    if (raw === undefined || raw.trim() === '') return true;
    return !/^(false|0|no|off)$/i.test(raw.trim());
};

export const trackEvent = (
    distinctId: string,
    event: string,
    properties?: Record<string, any>,
    groups?: Record<string, string | number>,
) => {
    if (!isCaptureEnabled()) return;
    if (posthogClient) {
        posthogClient.capture({
            distinctId,
            event,
            properties: {
                ...properties,
                timestamp: new Date().toISOString(),
                source: 'api',
            },
            groups,
        });
    }
};

export const identifyUser = (distinctId: string, properties?: Record<string, any>) => {
    if (!isCaptureEnabled()) return;
    if (posthogClient) {
        posthogClient.identify({
            distinctId,
            properties: {
                ...properties,
                source: 'api',
            },
        });
    }
};

export const setUserProperties = (distinctId: string, properties: Record<string, any>) => {
    if (!isCaptureEnabled()) return;
    if (posthogClient) {
        posthogClient.identify({
            distinctId,
            properties: {
                ...properties,
                source: 'api',
            },
        });
    }
};

export const shutdownPostHog = async () => {
    if (posthogClient) {
        await posthogClient.shutdown();
        posthogClient = null;
    }
};
