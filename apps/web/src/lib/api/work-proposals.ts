import 'server-only';
import { ApiResponseError, serverFetch, serverMutation } from './server-api';

export type WorkProposalStatus = 'pending' | 'dismissed' | 'accepted';
export type WorkProposalSource = 'auto-signup' | 'user-refresh' | 'discover' | 'scheduled';

export interface WorkProposalsRefreshStatus {
    researching: boolean;
    canRefresh: boolean;
    refreshDisabledReason?: 'rate-limited' | 'at-limit';
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
    generatedAt: string;
}

export const workProposalsAPI = {
    async get(id: string): Promise<WorkProposal | null> {
        try {
            return await serverFetch<WorkProposal>(`/me/work-proposals/${id}`, { method: 'GET' });
        } catch {
            return null;
        }
    },

    async list(statuses: WorkProposalStatus[] = ['pending']): Promise<WorkProposal[]> {
        const params = statuses.map((s) => `statuses=${encodeURIComponent(s)}`).join('&');
        return serverFetch<WorkProposal[]>(`/me/work-proposals?${params}`, {
            method: 'GET',
        });
    },

    async status(): Promise<WorkProposalsRefreshStatus> {
        return serverFetch<WorkProposalsRefreshStatus>(`/me/work-proposals/status`, {
            method: 'GET',
        });
    },

    async refresh(): Promise<{ status: 'queued' | 'rate-limited' | 'at-limit'; error?: string }> {
        try {
            return await serverMutation<{
                status: 'queued' | 'rate-limited' | 'at-limit';
                error?: string;
            }>({
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
};
