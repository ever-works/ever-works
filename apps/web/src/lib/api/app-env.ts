import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import type {
    AppEnvImportPreviewView,
    AppEnvListResponse,
    AppEnvPatchResponse,
    AppEnvRotateView,
} from './app-env.types';

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

    /** Lane aw-ops — `POST …/app-env/import-preview`: what a paste would change, stored nowhere. */
    previewImport: async (workId: string, dotenv: string): Promise<AppEnvImportPreviewView> => {
        return serverMutation<AppEnvImportPreviewView>({
            endpoint: `/works/${encodeURIComponent(workId)}/app-env/import-preview`,
            data: { import: { dotenv } },
            method: 'POST',
            wrapInData: false,
        });
    },

    /** Lane aw-ops — `PUT …/app-env` with `{ import: { dotenv } }` (plan §5): the import itself. */
    importDotenv: async (workId: string, dotenv: string): Promise<AppEnvPatchResponse> => {
        return serverMutation<AppEnvPatchResponse>({
            endpoint: `/works/${encodeURIComponent(workId)}/app-env`,
            data: { import: { dotenv } },
            method: 'PUT',
            wrapInData: false,
        });
    },

    /** Lane aw-ops — `POST …/app-env/:name/rotate` with the typed name. */
    rotate: async (
        workId: string,
        name: string,
        confirmName: string,
    ): Promise<AppEnvRotateView> => {
        return serverMutation<AppEnvRotateView>({
            endpoint: `/works/${encodeURIComponent(workId)}/app-env/${encodeURIComponent(name)}/rotate`,
            data: { confirmName },
            method: 'POST',
            wrapInData: false,
        });
    },
};
