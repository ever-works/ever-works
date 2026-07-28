import 'server-only';
import type {
    OnboardingSeedResponse,
    OnboardingSeedSuggestionsResponse,
} from '@ever-works/contracts/api';
import { serverFetch, serverMutation } from './server-api';

/**
 * A55 — web client for the SERVER-side onboarding starter seeding
 * (`apps/api/src/onboarding/onboarding-suggestions.controller.ts`).
 *
 * The wizard used to pull the whole agent catalog and do the role
 * matching in the browser, which covered 3 of the 14 roles the step
 * offers and knew nothing about skills. The matching now happens once,
 * server-side, for every role — this file just carries the answer.
 */

// No leading `/api` — `serverFetch`/`serverMutation` prepend `API_URL`,
// which `lib/constants.ts` already normalises to end in `/api`.
const BASE = '/onboarding/suggestions';

export const onboardingSuggestionsAPI = {
    /**
     * Resolve the starter kit for `roles`. Passing none lets the server
     * fall back to the roles already saved on the user's onboarding
     * state, so the client is never the authority on that answer.
     */
    suggest: async (roles: readonly string[] = []): Promise<OnboardingSeedSuggestionsResponse> => {
        const query = roles.length > 0 ? `?roles=${encodeURIComponent(roles.join(','))}` : '';
        return serverFetch<OnboardingSeedSuggestionsResponse>(`${BASE}${query}`);
    },

    /** Activate the starter agents for `roles`. Idempotent per template. */
    seed: async (roles: readonly string[] = []): Promise<OnboardingSeedResponse> => {
        return serverMutation<OnboardingSeedResponse>({
            endpoint: `${BASE}/seed`,
            data: { roles: [...roles] },
            method: 'POST',
            wrapInData: false,
        });
    },
};
