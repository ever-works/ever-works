'use server';

import { onboardingAPI } from '@/lib/api/onboarding';
import type {
    ProvisionRosterAccepted,
    ProvisionRosterRequest,
    RosterBlueprintsResponse,
    RosterStateResponse,
} from '@/lib/api/onboarding';
import type { ActionResult } from '@/app/actions/plugins';

/**
 * AW-20 P1 — server actions behind the setup wizard's **Your agents**
 * step, the provisioning progress panel and the roster introduction.
 *
 * Thin `ActionResult` wrappers rather than thrown errors, matching
 * `actions/onboarding/state.ts`: Server Actions redact thrown messages in
 * production, and the panel has to be able to say WHICH thing failed —
 * "a roster is already being set up" is a different answer from "we could
 * not reach the server", and the user needs the difference.
 */

/** The proposed roster for this person, plus the lane catalogue. */
export async function getRosterBlueprints(): Promise<ActionResult<RosterBlueprintsResponse>> {
    try {
        const data = await onboardingAPI.getRosterBlueprints();
        return { success: true, data };
    } catch (error) {
        console.error('Failed to load the roster proposal:', error);
        return { success: false, error: 'Failed to load the roster proposal' };
    }
}

/** The current or last provisioning run, plus the agents holding a lane. */
export async function getRosterState(): Promise<ActionResult<RosterStateResponse>> {
    try {
        const data = await onboardingAPI.getRoster();
        return { success: true, data };
    } catch (error) {
        console.error('Failed to load the roster state:', error);
        return { success: false, error: 'Failed to load the roster state' };
    }
}

/**
 * Start provisioning. The API returns as soon as the run is recorded, so
 * this resolves in well under a second and the panel takes over polling.
 */
export async function provisionRoster(
    body: ProvisionRosterRequest,
): Promise<ActionResult<ProvisionRosterAccepted>> {
    try {
        const data = await onboardingAPI.provisionRoster(body);
        return { success: true, data };
    } catch (error) {
        console.error('Failed to start roster provisioning:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to set up your agents',
        };
    }
}

/** Record that this person read the introduction. Idempotent. */
export async function acknowledgeRoster(): Promise<ActionResult<RosterStateResponse>> {
    try {
        const data = await onboardingAPI.acknowledgeRoster();
        return { success: true, data };
    } catch (error) {
        console.error('Failed to acknowledge the roster introduction:', error);
        return { success: false, error: 'Failed to record that you read this' };
    }
}
