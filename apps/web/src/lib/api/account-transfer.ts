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

	pushToGitHub: async (data: { includeSecrets?: boolean } = {}) =>
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
