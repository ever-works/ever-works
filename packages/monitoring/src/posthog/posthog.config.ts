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

export const trackEvent = (
    distinctId: string,
    event: string,
    properties?: Record<string, any>,
    groups?: Record<string, string | number>,
) => {
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
