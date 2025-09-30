import * as Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { SentryConfig } from '../types';

export const createSentryConfig = (config?: SentryConfig): any => {
    const defaultConfig = {
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'development',
        tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
        profilesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
        integrations: [nodeProfilingIntegration()],
        beforeSend(event: any) {
            if (event.request?.url?.includes('/auth')) {
                return null;
            }
            return event;
        },
        beforeSendTransaction(event: any) {
            if (event.request?.url?.includes('/auth')) {
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
