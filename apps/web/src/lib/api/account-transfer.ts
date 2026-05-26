import 'server-only';
import { serverFetch, serverMutation } from './server-api';
import type {
    AccountExportPayload,
    ImportPreview,
    ConflictResolution,
    ImportResult,
    SyncStatus,
} from './account-transfer.types';

export type { AccountExportPayload, ImportPreview, ConflictResolution, ImportResult, SyncStatus };

export const accountTransferAPI = {
    // Import
    previewImport: async (payload: AccountExportPayload) =>
        serverMutation<ImportPreview>({
            endpoint: '/account/import/preview',
            data: payload,
            method: 'POST',
            wrapInData: false,
        }),

    applyImport: async (payload: AccountExportPayload, resolutions: ConflictResolution[]) =>
        serverMutation<ImportResult>({
            endpoint: '/account/import/apply',
            data: { payload, resolutions },
            method: 'POST',
            wrapInData: false,
        }),

    // GitHub Sync
    getSyncStatus: async () => serverFetch<SyncStatus>('/account/sync/status'),

    configureSyncRepo: async (data: { repoFullName?: string; createNew?: boolean }) =>
        serverMutation<SyncStatus>({
            endpoint: '/account/sync/configure',
            data,
            method: 'POST',
            wrapInData: false,
        }),

    // PASS-5 review fix: widen the client signature to match the
    // server-side controller (post-tick-45) so future callers writing
    // object literals with v2 toggles don't hit a TS excess-property
    // error.
    pushToGitHub: async (
        data: {
            includeSecrets?: boolean;
            includeAgents?: boolean;
            includeSkills?: boolean;
            includeTasks?: boolean;
            includeTaskChat?: boolean;
        } = {},
    ) =>
        serverMutation<{ status: string }>({
            endpoint: '/account/sync/push',
            data,
            method: 'POST',
            wrapInData: false,
        }),

    pullFromGitHub: async () =>
        serverMutation<ImportPreview>({
            endpoint: '/account/sync/pull',
            data: {},
            method: 'POST',
            wrapInData: false,
        }),

    applyPull: async (resolutions: ConflictResolution[]) =>
        serverMutation<ImportResult>({
            endpoint: '/account/sync/pull/apply',
            data: { resolutions },
            method: 'POST',
            wrapInData: false,
        }),

    removeSyncConfig: async () =>
        serverMutation<{ status: string }>({
            endpoint: '/account/sync',
            data: {},
            method: 'DELETE',
            wrapInData: false,
        }),
};
