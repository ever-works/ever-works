import { Injectable } from '@nestjs/common';
import {
    trackEvent,
    identifyUser,
    setUserProperties,
    getPostHogClient,
} from '../posthog/posthog.config';
import {
    AnalyticsEvent,
    UserProperties,
    ApiUsageEvent,
    AuthEvent,
    BusinessEvent,
} from '../types';

@Injectable()
export class AnalyticsService {
    private posthog = getPostHogClient();

    /**
     * Track a custom event
     */
    track(
        distinctId: string,
        event: string,
        properties?: Record<string, any>,
        groups?: Record<string, string | number>,
    ) {
        trackEvent(distinctId, event, properties, groups);
    }

    /**
     * Track a custom event with AnalyticsEvent interface
     */
    trackEvent(event: AnalyticsEvent) {
        trackEvent(event.distinctId, event.event, event.properties, event.groups);
    }

    /**
     * Identify a user with properties
     */
    identify(distinctId: string, properties?: Record<string, any>) {
        identifyUser(distinctId, properties);
    }

    /**
     * Identify a user with UserProperties interface
     */
    identifyUser(userProps: UserProperties) {
        identifyUser(userProps.distinctId, userProps.properties);
    }

    /**
     * Set user properties
     */
    setUserProperties(distinctId: string, properties: Record<string, any>) {
        setUserProperties(distinctId, properties);
    }

    /**
     * Track API endpoint usage
     */
    trackApiUsage(
        distinctId: string,
        endpoint: string,
        method: string,
        statusCode: number,
        duration: number,
    ) {
        this.track(distinctId, 'api_usage', {
            endpoint,
            method,
            statusCode,
            duration,
            timestamp: new Date().toISOString(),
        });
    }

    /**
     * Track API usage with ApiUsageEvent interface
     */
    trackApiUsageEvent(event: ApiUsageEvent) {
        this.trackApiUsage(
            event.distinctId,
            event.endpoint,
            event.method,
            event.statusCode,
            event.duration,
        );
    }

    /**
     * Track authentication events
     */
    trackAuth(
        distinctId: string,
        event: 'login' | 'logout' | 'register' | 'password_reset',
        properties?: Record<string, any>,
    ) {
        this.track(distinctId, `auth_${event}`, {
            ...properties,
            timestamp: new Date().toISOString(),
        });
    }

    /**
     * Track authentication events with AuthEvent interface
     */
    trackAuthEvent(event: AuthEvent) {
        this.trackAuth(event.distinctId, event.event, event.properties);
    }

    /**
     * Track business events
     */
    trackBusinessEvent(distinctId: string, event: string, properties?: Record<string, any>) {
        this.track(distinctId, `business_${event}`, {
            ...properties,
            timestamp: new Date().toISOString(),
        });
    }

    /**
     * Track business events with BusinessEvent interface
     */
    trackBusinessEventEvent(event: BusinessEvent) {
        this.trackBusinessEvent(event.distinctId, event.event, event.properties);
    }

    /**
     * Check if PostHog is available
     */
    isAvailable(): boolean {
        return this.posthog !== null;
    }
}
