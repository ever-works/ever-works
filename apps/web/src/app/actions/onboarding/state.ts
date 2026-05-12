'use server';

import { onboardingAPI } from '@/lib/api/onboarding';
import type {
    OnboardingStatePatchRequest,
    OnboardingStateResponse,
} from '@ever-works/contracts/api';
import type { ActionResult } from '@/app/actions/plugins';

/** Read the server-persisted wizard state. */
export async function getOnboardingState(): Promise<ActionResult<OnboardingStateResponse>> {
    try {
        const data = await onboardingAPI.getState();
        return { success: true, data };
    } catch (error) {
        console.error('Failed to load onboarding state:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to load onboarding state',
        };
    }
}

/** Partial update to the server-persisted wizard state. */
export async function patchOnboardingState(
    patch: OnboardingStatePatchRequest,
): Promise<ActionResult<OnboardingStateResponse>> {
    try {
        const data = await onboardingAPI.patchState(patch);
        return { success: true, data };
    } catch (error) {
        console.error('Failed to update onboarding state:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to update onboarding state',
        };
    }
}

export async function completeOnboarding(): Promise<ActionResult<OnboardingStateResponse>> {
    try {
        const data = await onboardingAPI.markCompleted();
        return { success: true, data };
    } catch (error) {
        console.error('Failed to mark onboarding completed:', error);
        return { success: false, error: 'Failed to mark onboarding completed' };
    }
}

export async function dismissOnboarding(): Promise<ActionResult<OnboardingStateResponse>> {
    try {
        const data = await onboardingAPI.markDismissed();
        return { success: true, data };
    } catch (error) {
        console.error('Failed to dismiss onboarding:', error);
        return { success: false, error: 'Failed to dismiss onboarding' };
    }
}
