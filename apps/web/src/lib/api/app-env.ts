import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import type { AppEnvListResponse, AppEnvPatchResponse } from './app-env.types';

/**
 * Server-only client for an App Work's Environment (lane aw-env-smtp, APW-07 T24). See
 * `./app-env.types` for the routes and refusals. No leading `/api`: `serverFetch` prepends `API_URL`,
 * which already ends in `/api`. Values go out exactly once, in the PUT body, and never come back.
 */
export const appEnvAPI = {
    /** `GET /api/works/:id/app-env` — the declared env with set / masked / secret / phase. */
    get: async (workId: string): Promise<AppEnvListResponse> => {
        return serverFetch<AppEnvListResponse>(`/works/${encodeURIComponent(workId)}/app-env`);
    },

    /** `PUT /api/works/:id/app-env` — a merge patch: a string sets the name, `null` removes it. */
    put: async (
        workId: string,
        values: Record<string, string | null>,
    ): Promise<AppEnvPatchResponse> => {
        return serverMutation<AppEnvPatchResponse>({
            endpoint: `/works/${encodeURIComponent(workId)}/app-env`,
            data: { values },
            method: 'PUT',
            wrapInData: false,
        });
    },
};
