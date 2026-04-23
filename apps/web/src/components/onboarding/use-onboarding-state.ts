'use client';

import { ONBOARDING_STORAGE_KEY } from '@/lib/constants';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';

export interface OnboardingState {
    step: number;
    modalDismissed: boolean;
    headerDismissed: boolean;
}

const DEFAULT_ONBOARDING_STATE: OnboardingState = {
    step: 0,
    modalDismissed: false,
    headerDismissed: false,
};

function normalizeOnboardingState(value: unknown): OnboardingState {
    if (!value || typeof value !== 'object') {
        return DEFAULT_ONBOARDING_STATE;
    }

    const candidate = value as Partial<
        OnboardingState & {
            dismissed?: boolean;
        }
    >;

    const rawStep = Number(candidate.step);
    const step = Number.isFinite(rawStep) && rawStep >= 0 ? Math.floor(rawStep) : 0;
    const legacyDismissed = candidate.dismissed === true;

    return {
        step,
        modalDismissed: candidate.modalDismissed ?? legacyDismissed,
        headerDismissed: candidate.headerDismissed ?? false,
    };
}

export function useOnboardingState() {
    return useLocalStorage<OnboardingState>(ONBOARDING_STORAGE_KEY, DEFAULT_ONBOARDING_STATE, {
        serialize: JSON.stringify,
        deserialize: (raw) => {
            try {
                return normalizeOnboardingState(JSON.parse(raw));
            } catch {
                return DEFAULT_ONBOARDING_STATE;
            }
        },
        validate: (value) => Number.isInteger(value.step) && value.step >= 0,
    });
}
