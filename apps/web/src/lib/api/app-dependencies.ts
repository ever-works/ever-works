import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import type {
    AppDependenciesListResponse,
    AppDependencyKind,
    AppDependencyRetryResponse,
    AppDependencyWriteResponse,
} from './app-dependencies.types';

/**
 * Server-only client for an App Work's dependencies (lane aw-deps-api, APW-07 T25). See
 * `./app-dependencies.types` for the routes and refusals. No leading `/api`: `serverFetch` prepends
 * `API_URL`, which already ends in `/api`.
 */
const base = (workId: string) => `/works/${encodeURIComponent(workId)}/app-dependencies`;

export const appDependenciesAPI = {
    /** `GET /api/works/:id/app-dependencies` — every card, never a value. */
    list: async (workId: string): Promise<AppDependenciesListResponse> => {
        return serverFetch<AppDependenciesListResponse>(base(workId));
    },

    /** `POST …/:kind/provision` — the card's **Retry**. */
    retry: async (workId: string, kind: AppDependencyKind): Promise<AppDependencyRetryResponse> => {
        return serverMutation<AppDependencyRetryResponse>({
            endpoint: `${base(workId)}/${encodeURIComponent(kind)}/provision`,
            data: {},
            method: 'POST',
            wrapInData: false,
        });
    },

    /** `DELETE …/:kind` with `{ confirmSlug }` — **Delete data**. */
    deleteData: async (
        workId: string,
        kind: AppDependencyKind,
        confirmSlug: string,
    ): Promise<AppDependencyWriteResponse> => {
        return serverMutation<AppDependencyWriteResponse>({
            endpoint: `${base(workId)}/${encodeURIComponent(kind)}`,
            data: { confirmSlug },
            method: 'DELETE',
            wrapInData: false,
        });
    },
};
