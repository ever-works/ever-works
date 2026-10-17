import 'server-only';
import { ApiResponseError, serverFetch, serverMutation } from './server-api';
import type { RecordAggregate, RecordVisibilityView, VisibilityChoice } from '../record-visibility';

/**
 * Record visibility (EW-P1-3) — `/api/record-visibility`, the API behind the
 * visibility control on the task, goal, mission, idea and agent forms.
 */
export const recordVisibilityAPI = {
    /** `null` when the caller may not read the record (404). */
    async get(aggregate: RecordAggregate, id: string): Promise<RecordVisibilityView | null> {
        try {
            return await serverFetch<RecordVisibilityView>(
                `/record-visibility/${aggregate}/${id}`,
                { method: 'GET' },
            );
        } catch (err) {
            if (err instanceof ApiResponseError && err.statusCode === 404) return null;
            throw err;
        }
    },

    async set(
        aggregate: RecordAggregate,
        id: string,
        visibility: VisibilityChoice,
    ): Promise<RecordVisibilityView> {
        return serverMutation<RecordVisibilityView>({
            endpoint: `/record-visibility/${aggregate}/${id}`,
            data: { visibility },
            method: 'PUT',
            wrapInData: false,
        });
    },

    async setTeams(
        aggregate: RecordAggregate,
        id: string,
        teamIds: string[],
    ): Promise<RecordVisibilityView> {
        return serverMutation<RecordVisibilityView>({
            endpoint: `/record-visibility/${aggregate}/${id}/teams`,
            data: { teamIds },
            method: 'PUT',
            wrapInData: false,
        });
    },
};
