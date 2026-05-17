'use server';

import { accountTransferAPI } from '@/lib/api/account-transfer';
import type { AccountExportPayload, ConflictResolution } from '@/lib/api/account-transfer.types';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { serverFetch } from '@/lib/api/server-api';

function ensureAuth() {
    return getAuthFromCookie().then((user) => {
        if (!user) redirect(ROUTES.AUTH_LOGIN);
        return user;
    });
}

export async function exportAccountData(includeSecrets: boolean) {
    await ensureAuth();
    try {
        const data = await serverFetch<AccountExportPayload>(
            `/account/export?includeSecrets=${includeSecrets}`,
        );
        return { success: true as const, data, error: null };
    } catch (error) {
        return {
            success: false as const,
            data: null,
            error: error instanceof Error ? error.message : 'Failed to export data',
        };
    }
}

export async function previewImport(payload: AccountExportPayload) {
    await ensureAuth();
    try {
        const data = await accountTransferAPI.previewImport(payload);
        return { success: true as const, data, error: null };
    } catch (error) {
        return {
            success: false as const,
            data: null,
            error: error instanceof Error ? error.message : 'Failed to preview import',
        };
    }
}

export async function applyImport(
    payload: AccountExportPayload,
    resolutions: ConflictResolution[],
) {
    await ensureAuth();
    try {
        const data = await accountTransferAPI.applyImport(payload, resolutions);
        return { success: true as const, data, error: null };
    } catch (error) {
        return {
            success: false as const,
            data: null,
            error: error instanceof Error ? error.message : 'Failed to apply import',
        };
    }
}

export async function getSyncStatus() {
    await ensureAuth();
    try {
        const data = await accountTransferAPI.getSyncStatus();
        return { success: true as const, data, error: null };
    } catch (error) {
        return {
            success: false as const,
            data: null,
            error: error instanceof Error ? error.message : 'Failed to get sync status',
        };
    }
}

export async function configureSyncRepo(config: { repoFullName?: string; createNew?: boolean }) {
    await ensureAuth();
    try {
        const data = await accountTransferAPI.configureSyncRepo(config);
        return { success: true as const, data, error: null };
    } catch (error) {
        return {
            success: false as const,
            data: null,
            error: error instanceof Error ? error.message : 'Failed to configure sync',
        };
    }
}

export async function pushToGitHub(options: { includeSecrets?: boolean } = {}) {
    await ensureAuth();
    try {
        await accountTransferAPI.pushToGitHub(options);
        return { success: true as const, error: null };
    } catch (error) {
        return {
            success: false as const,
            error: error instanceof Error ? error.message : 'Failed to push to GitHub',
        };
    }
}

export async function pullFromGitHub() {
    await ensureAuth();
    try {
        const data = await accountTransferAPI.pullFromGitHub();
        return { success: true as const, data, error: null };
    } catch (error) {
        return {
            success: false as const,
            data: null,
            error: error instanceof Error ? error.message : 'Failed to pull from GitHub',
        };
    }
}

export async function applyPull(resolutions: ConflictResolution[]) {
    await ensureAuth();
    try {
        const data = await accountTransferAPI.applyPull(resolutions);
        return { success: true as const, data, error: null };
    } catch (error) {
        return {
            success: false as const,
            data: null,
            error: error instanceof Error ? error.message : 'Failed to apply pull',
        };
    }
}

export async function removeSyncConfig() {
    await ensureAuth();
    try {
        await accountTransferAPI.removeSyncConfig();
        return { success: true as const, error: null };
    } catch (error) {
        return {
            success: false as const,
            error: error instanceof Error ? error.message : 'Failed to disconnect',
        };
    }
}
