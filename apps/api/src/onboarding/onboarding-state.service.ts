import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { UserRepository } from '@ever-works/agent/database';
import {
    ONBOARDING_DEFAULT_STATE,
    type OnboardingStateResponse,
    type OnboardingStatePatchRequest,
    type OnboardingWizardStateV2,
} from '@ever-works/contracts/api';

/**
 * Owns reads + writes for the v2 onboarding wizard's server-side state.
 *
 * State lives on `users.onboarding_state` (TypeORM `simple-json`) plus two
 * timestamp columns (`onboardingCompletedAt`, `onboardingDismissedAt`). All
 * three default to NULL — `getState` synthesises the version-2 default
 * payload until the user makes their first choice.
 */
@Injectable()
export class OnboardingStateService {
    private readonly logger = new Logger(OnboardingStateService.name);

    constructor(private readonly userRepository: UserRepository) {}

    async getState(userId: string): Promise<OnboardingStateResponse> {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException(`User ${userId} not found`);
        }
        return {
            completedAt: user.onboardingCompletedAt
                ? user.onboardingCompletedAt.toISOString()
                : null,
            dismissedAt: user.onboardingDismissedAt
                ? user.onboardingDismissedAt.toISOString()
                : null,
            state: normaliseState(user.onboardingState),
        };
    }

    async patchState(
        userId: string,
        patch: OnboardingStatePatchRequest,
    ): Promise<OnboardingStateResponse> {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException(`User ${userId} not found`);
        }

        const current = normaliseState(user.onboardingState);
        const next = mergeState(current, patch.state ?? {});

        // Idempotent: skip the write if nothing actually changed.
        if (deepEqual(current, next)) {
            return {
                completedAt: user.onboardingCompletedAt
                    ? user.onboardingCompletedAt.toISOString()
                    : null,
                dismissedAt: user.onboardingDismissedAt
                    ? user.onboardingDismissedAt.toISOString()
                    : null,
                state: current,
            };
        }

        const updated = await this.userRepository.update(userId, {
            onboardingState: next,
        });

        return {
            completedAt: updated?.onboardingCompletedAt
                ? updated.onboardingCompletedAt.toISOString()
                : null,
            dismissedAt: updated?.onboardingDismissedAt
                ? updated.onboardingDismissedAt.toISOString()
                : null,
            state: next,
        };
    }

    async markCompleted(userId: string): Promise<OnboardingStateResponse> {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException(`User ${userId} not found`);
        }

        // Idempotent: if already marked, return the existing payload.
        if (user.onboardingCompletedAt) {
            return this.getState(userId);
        }

        const now = new Date();
        const updated = await this.userRepository.update(userId, {
            onboardingCompletedAt: now,
        });

        this.logger.log(`Onboarding completed for user ${userId}`);

        return {
            completedAt: now.toISOString(),
            dismissedAt: updated?.onboardingDismissedAt
                ? updated.onboardingDismissedAt.toISOString()
                : null,
            state: normaliseState(updated?.onboardingState),
        };
    }

    async markDismissed(userId: string): Promise<OnboardingStateResponse> {
        const user = await this.userRepository.findById(userId);
        if (!user) {
            throw new NotFoundException(`User ${userId} not found`);
        }

        if (user.onboardingDismissedAt) {
            return this.getState(userId);
        }

        const now = new Date();
        const updated = await this.userRepository.update(userId, {
            onboardingDismissedAt: now,
        });

        return {
            completedAt: updated?.onboardingCompletedAt
                ? updated.onboardingCompletedAt.toISOString()
                : null,
            dismissedAt: now.toISOString(),
            state: normaliseState(updated?.onboardingState),
        };
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Coerce a possibly-null / legacy payload into a complete v2 state. */
function normaliseState(raw: OnboardingWizardStateV2 | null | undefined): OnboardingWizardStateV2 {
    if (!raw) return { ...ONBOARDING_DEFAULT_STATE };

    return {
        version: 2,
        lastStep: typeof raw.lastStep === 'number' && raw.lastStep >= 0 ? raw.lastStep : 0,
        ai: { choice: raw.ai?.choice ?? ONBOARDING_DEFAULT_STATE.ai.choice },
        storage: { choice: raw.storage?.choice ?? ONBOARDING_DEFAULT_STATE.storage.choice },
        deploy: { choice: raw.deploy?.choice ?? ONBOARDING_DEFAULT_STATE.deploy.choice },
        skippedSteps: Array.isArray(raw.skippedSteps) ? [...raw.skippedSteps] : [],
        pluginsReviewed: raw.pluginsReviewed === true,
    };
}

function mergeState(
    current: OnboardingWizardStateV2,
    patch: NonNullable<OnboardingStatePatchRequest['state']>,
): OnboardingWizardStateV2 {
    return {
        version: 2,
        lastStep: typeof patch.lastStep === 'number' ? patch.lastStep : current.lastStep,
        ai: { choice: patch.ai?.choice ?? current.ai.choice },
        storage: { choice: patch.storage?.choice ?? current.storage.choice },
        deploy: { choice: patch.deploy?.choice ?? current.deploy.choice },
        skippedSteps: Array.isArray(patch.skippedSteps)
            ? [...patch.skippedSteps]
            : [...current.skippedSteps],
        pluginsReviewed:
            typeof patch.pluginsReviewed === 'boolean'
                ? patch.pluginsReviewed
                : current.pluginsReviewed,
    };
}

function deepEqual(a: OnboardingWizardStateV2, b: OnboardingWizardStateV2): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

export const __test__ = { normaliseState, mergeState };
