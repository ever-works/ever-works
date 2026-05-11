import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import type {
    OnboardingCatalogResponse,
    OnboardingStateResponse,
    OnboardingStatePatchRequest,
} from '@ever-works/contracts/api';

/** Server-side client for the v2 onboarding wizard's REST surface. */
export const onboardingAPI = {
    getState() {
        return serverFetch<OnboardingStateResponse>('/api/onboarding/state');
    },

    patchState(body: OnboardingStatePatchRequest) {
        return serverMutation<OnboardingStateResponse>({
            endpoint: '/api/onboarding/state',
            data: body,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    markCompleted() {
        return serverMutation<OnboardingStateResponse>({
            endpoint: '/api/onboarding/complete',
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    markDismissed() {
        return serverMutation<OnboardingStateResponse>({
            endpoint: '/api/onboarding/dismiss',
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    getCatalog() {
        return serverFetch<OnboardingCatalogResponse>('/api/onboarding/catalog');
    },

    track(event: string, properties?: Record<string, unknown>) {
        return serverMutation<void>({
            endpoint: '/api/onboarding/telemetry',
            data: { event, properties },
            method: 'POST',
            wrapInData: false,
        });
    },
};
