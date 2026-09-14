import 'server-only';
import { toApiResult } from './api-result';
import { serverFetch, serverMutation } from './server-api';
import type {
    WorkflowListResult,
    WorkflowRow,
    WorkflowRunDetail,
    WorkflowRunRow,
    WorkflowRunStatus,
    WorkflowStatus,
} from './workflows.shared';

/**
 * Saved workflow graphs — server-side client over the EXISTING
 * `/api/workflows` routes. The catalogue adds no workflow backend of its own.
 */
export const workflowsAPI = {
    list(query: { status?: WorkflowStatus; limit?: number; offset?: number } = {}) {
        const params = new URLSearchParams();
        if (query.status) params.set('status', query.status);
        if (query.limit !== undefined) params.set('limit', String(query.limit));
        if (query.offset !== undefined) params.set('offset', String(query.offset));
        const qs = params.toString();
        return toApiResult(() =>
            serverFetch<WorkflowListResult<WorkflowRow>>(`/workflows${qs ? `?${qs}` : ''}`, {
                method: 'GET',
            }),
        );
    },

    get(id: string) {
        return toApiResult(() =>
            serverFetch<WorkflowRow>(`/workflows/${encodeURIComponent(id)}`, { method: 'GET' }),
        );
    },

    listRuns(id: string, query: { limit?: number; offset?: number } = {}) {
        const params = new URLSearchParams();
        if (query.limit !== undefined) params.set('limit', String(query.limit));
        if (query.offset !== undefined) params.set('offset', String(query.offset));
        const qs = params.toString();
        return toApiResult(() =>
            serverFetch<WorkflowListResult<WorkflowRunRow>>(
                `/workflows/${encodeURIComponent(id)}/runs${qs ? `?${qs}` : ''}`,
                { method: 'GET' },
            ),
        );
    },

    getRun(runId: string) {
        return toApiResult(() =>
            serverFetch<WorkflowRunDetail>(`/workflows/runs/${encodeURIComponent(runId)}`, {
                method: 'GET',
            }),
        );
    },

    run(id: string) {
        return toApiResult(() =>
            serverMutation<{ runId: string; status: WorkflowRunStatus }>({
                endpoint: `/workflows/${encodeURIComponent(id)}/run`,
                data: {},
                method: 'POST',
                wrapInData: false,
            }),
        );
    },

    setStatus(id: string, status: WorkflowStatus) {
        return toApiResult(() =>
            serverMutation<WorkflowRow>({
                endpoint: `/workflows/${encodeURIComponent(id)}`,
                data: { status },
                method: 'PATCH',
                wrapInData: false,
            }),
        );
    },
};
