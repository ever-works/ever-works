import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import type {
    OnboardingCatalogResponse,
    OnboardingStateResponse,
    OnboardingStatePatchRequest,
    RosterBlueprintSlug,
    RosterLaneKey,
    RosterProvisionRecord,
    RosterProvisionState,
} from '@ever-works/contracts/api';

/**
 * AW-20 P1 — wire shapes of the roster endpoints
 * (`apps/api/src/onboarding/onboarding-roster.controller.ts`).
 *
 * Declared here as interfaces rather than imported from the API's DTO
 * classes for the same reason `lib/api/agents.ts` declares its summaries:
 * the browser bundle must not pull `class-validator` decorators in.
 */
/**
 * The i18n leaves a lane resolves to under
 * `onboarding.rosterStep.lanes` / `.blurbs`. A literal union rather than
 * `string` because next-intl types its message keys: a lane whose label
 * key has no message is then a compile error here, not a runtime
 * `MISSING_MESSAGE` in front of a new user.
 */
export type RosterLaneLabelKey =
    | 'coordination'
    | 'research'
    | 'content'
    | 'outreach'
    | 'visibility'
    | 'social'
    | 'marketWatch';

export interface RosterLaneOption {
    readonly laneKey: RosterLaneKey;
    readonly labelKey: RosterLaneLabelKey;
    readonly templateSlug: string;
    readonly defaultName: string;
    readonly isCoordinator: boolean;
}

export interface RosterBlueprintsResponse {
    readonly blueprintSlug: RosterBlueprintSlug;
    readonly derivedFromRoles: boolean;
    readonly laneCap: number;
    readonly maxLanes: number;
    readonly nameMax: number;
    readonly proposal: readonly RosterLaneOption[];
    readonly catalog: readonly RosterLaneOption[];
    readonly canCreateAgents: boolean;
}

export interface RosterAgentSummary {
    readonly id: string;
    readonly name: string;
    readonly lane: string | null;
    readonly title: string | null;
    readonly reportsToAgentId: string | null;
    readonly reportsToName: string | null;
    readonly skills: readonly string[];
}

export interface RosterStateResponse {
    readonly state: RosterProvisionState;
    readonly provisioning: RosterProvisionRecord | null;
    readonly acknowledgedAt: string | null;
    readonly agents: readonly RosterAgentSummary[];
    readonly canCreateAgents: boolean;
}

export interface ProvisionRosterRequest {
    readonly blueprintSlug?: RosterBlueprintSlug;
    readonly lanes: ReadonlyArray<{ laneKey: RosterLaneKey; name: string }>;
}

export interface ProvisionRosterAccepted {
    readonly runId: string;
    readonly state: RosterProvisionState;
}

/** Server-side client for the v2 onboarding wizard's REST surface. */
export const onboardingAPI = {
    getState() {
        return serverFetch<OnboardingStateResponse>('/onboarding/state');
    },

    patchState(body: OnboardingStatePatchRequest) {
        return serverMutation<OnboardingStateResponse>({
            endpoint: '/onboarding/state',
            data: body,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    markCompleted() {
        return serverMutation<OnboardingStateResponse>({
            endpoint: '/onboarding/complete',
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    markDismissed() {
        return serverMutation<OnboardingStateResponse>({
            endpoint: '/onboarding/dismiss',
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    getCatalog() {
        return serverFetch<OnboardingCatalogResponse>('/onboarding/catalog');
    },

    // ── AW-20 P1 — the roster step ──────────────────────────────────

    /** What we propose for this person, plus the full lane catalogue. */
    getRosterBlueprints() {
        return serverFetch<RosterBlueprintsResponse>('/onboarding/roster/blueprints');
    },

    /** The current or last provisioning run, plus the lane-holding agents. */
    getRoster() {
        return serverFetch<RosterStateResponse>('/onboarding/roster');
    },

    /** Enqueue a run. Returns as soon as it is recorded; never blocks. */
    provisionRoster(body: ProvisionRosterRequest) {
        return serverMutation<ProvisionRosterAccepted>({
            endpoint: '/onboarding/roster/provision',
            data: { blueprintSlug: body.blueprintSlug, lanes: [...body.lanes] },
            method: 'POST',
            wrapInData: false,
        });
    },

    /** Record that the introduction was read. Idempotent. */
    acknowledgeRoster() {
        return serverMutation<RosterStateResponse>({
            endpoint: '/onboarding/roster/acknowledge',
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    track(event: string, properties?: Record<string, unknown>) {
        return serverMutation<void>({
            endpoint: '/onboarding/telemetry',
            data: { event, properties },
            method: 'POST',
            wrapInData: false,
        });
    },
};
