import 'server-only';
import { ApiResponseError, serverFetch, serverMutation } from './server-api';

// Phase 1 PR A — three new statuses (`queued`/`building`/`failed`)
// surface in the API alongside the existing three.
export type WorkProposalStatus =
    | 'pending'
    | 'dismissed'
    | 'accepted'
    | 'queued'
    | 'building'
    | 'failed';
// Phase 1 PR A — two new sources (`user-manual`/`mission`).
export type WorkProposalSource =
    | 'auto-signup'
    | 'user-refresh'
    | 'discover'
    | 'scheduled'
    | 'user-manual'
    | 'mission';

// Phase 0 PR 0.8 — failure classifier kinds. Populated only when
// status === 'failed'; cleared when the user hits Retry.
export type IdeaFailureKind =
    | 'transient-network'
    | 'transient-rate-limit'
    | 'transient-upstream-5xx'
    | 'transient-plugin'
    | 'permanent-invalid-input'
    | 'permanent-unknown';

export interface WorkProposalsRefreshStatus {
    researching: boolean;
    canRefresh: boolean;
    refreshDisabledReason?: 'rate-limited';
}

export interface WorkProposal {
    id: string;
    title: string;
    description: string;
    slugSuggestion: string;
    suggestedCategories: Array<{ name: string; slug: string }>;
    suggestedFields: Array<{ name: string; type: string }>;
    recommendedPlugins: Array<{ pluginId: string; reason: string }>;
    generatedPrompt: string;
    reasoning: string;
    source: WorkProposalSource;
    status: WorkProposalStatus;
    acceptedWorkId?: string | null;
    // Phase 1 PR A — back-FK to the spawning Mission for `source=mission` Ideas.
    missionId?: string | null;
    // Phase 0 PR 0.8 / Phase 1 PR FF — failure metadata. NULL except
    // when status === 'failed'.
    failureMessage?: string | null;
    failureKind?: IdeaFailureKind | null;
    generatedAt: string;
}

export interface CreateIdeaInput {
    description: string;
    title?: string;
}

export interface BuildIdeaResponse {
    idea: WorkProposal;
    goalId: string;
}

// Raw wire shape of `POST /me/work-proposals/:id/{build,retry,rebuild}` —
// matches the API's `BuildWorkProposalResponseDto`. The client method
// flattens this into `BuildIdeaResponse` for callers.
interface BuildApiResponse {
    proposal: WorkProposal;
    goal: { id: string; instruction: string; status: string; dryRun: boolean; createdAt: string };
}

export const workProposalsAPI = {
    async get(id: string): Promise<WorkProposal | null> {
        try {
            return await serverFetch<WorkProposal>(`/me/work-proposals/${id}`, { method: 'GET' });
        } catch {
            return null;
        }
    },

    async list(
        statuses: WorkProposalStatus[] = ['pending'],
        opts: { missionId?: string } = {},
    ): Promise<WorkProposal[]> {
        const params = statuses.map((s) => `statuses=${encodeURIComponent(s)}`);
        // Phase 6 PR R — server-side `missionId` filter is already
        // wired through `WorkProposalRepository.findByUser` (Phase 1
        // PR A). The Mission detail page passes this so it gets
        // only the Ideas attached to its Mission, not the user's
        // entire catalog.
        if (opts.missionId) {
            params.push(`missionId=${encodeURIComponent(opts.missionId)}`);
        }
        return serverFetch<WorkProposal[]>(`/me/work-proposals?${params.join('&')}`, {
            method: 'GET',
        });
    },

    async status(): Promise<WorkProposalsRefreshStatus> {
        return serverFetch<WorkProposalsRefreshStatus>(`/me/work-proposals/status`, {
            method: 'GET',
        });
    },

    async refresh(): Promise<{ status: 'queued' | 'rate-limited'; error?: string }> {
        try {
            return await serverMutation<{ status: 'queued' | 'rate-limited'; error?: string }>({
                endpoint: '/me/work-proposals/refresh',
                data: {},
                method: 'POST',
                wrapInData: false,
            });
        } catch (err) {
            // The controller maps the service's `rate-limited` result to a 429
            // HTTP status, which serverMutation rejects with ApiResponseError.
            // Translate back to the structured shape so the UI's rate-limited
            // branch (hide the button, swap the empty subtitle) still fires.
            if (err instanceof ApiResponseError && err.statusCode === 429) {
                const details = err.details as { status?: string; error?: string } | undefined;
                return {
                    status: 'rate-limited',
                    error: details?.error ?? err.message,
                };
            }
            throw err;
        }
    },

    async dismiss(id: string): Promise<void> {
        await serverMutation<void>({
            endpoint: `/me/work-proposals/${id}/dismiss`,
            data: {},
            method: 'PATCH',
            wrapInData: false,
        });
    },

    async accept(id: string, workId: string): Promise<{ ok: boolean }> {
        return serverMutation<{ ok: boolean }>({
            endpoint: `/me/work-proposals/${id}/accept`,
            data: { workId },
            method: 'POST',
            wrapInData: false,
        });
    },

    // Phase 1 PR B — user-manual Idea create (`+ Add` button on the
    // dedicated /ideas page, Phase 5 PR N).
    async createUserManual(input: CreateIdeaInput): Promise<WorkProposal> {
        return serverMutation<WorkProposal>({
            endpoint: `/me/work-proposals`,
            data: input,
            method: 'POST',
            wrapInData: false,
        });
    },

    // Phase 1 PR B — queue an existing Idea for build (transitions
    // PENDING/FAILED → QUEUED + creates a WorkAgentGoal under the
    // hood). Returns the freshly-loaded Idea + the new goal id.
    //
    // The API DTO (`BuildWorkProposalResponseDto`) is the public
    // OpenAPI/MCP contract and uses `{ proposal, goal: { id, ... } }`;
    // the web client's internal `BuildIdeaResponse` flattens it to
    // `{ idea, goalId }` for ergonomics. We transform at the boundary
    // here (rather than reshaping the API) so external API consumers
    // and the existing OpenAPI/MCP whitelist entries stay untouched.
    // (Codex review on PR #1013.)
    async build(id: string): Promise<BuildIdeaResponse> {
        const raw = await serverMutation<BuildApiResponse>({
            endpoint: `/me/work-proposals/${id}/build`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
        return { idea: raw.proposal, goalId: raw.goal.id };
    },

    // Phase 7 PR U — per-Idea current-period spend + GLOBAL cap
    // status. Shape mirrors missionsAPI.getBudget exactly so the
    // shared BudgetSummaryCard can render either without
    // branching. Re-using the type from the missions client keeps
    // the wire contract single-sourced.
    async getBudget(id: string): Promise<OwnerBudgetSummary> {
        return serverFetch<OwnerBudgetSummary>(`/me/work-proposals/${id}/budget`, {
            method: 'GET',
        });
    },
};

// Phase 7 PR U — single-source the OwnerBudgetSummary type. Defined
// alongside the missions client (the first consumer) and re-exported
// here so the work-proposals client / its consumers can import from
// either location.
import type { OwnerBudgetSummary } from './missions';
export type { OwnerBudgetSummary };
