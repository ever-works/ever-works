'use server';

import { z } from 'zod';
import { accountTransferAPI } from '@/lib/api/account-transfer';
import type { AccountExportPayload, ConflictResolution } from '@/lib/api/account-transfer.types';
import { getAuthFromCookie } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { serverFetch } from '@/lib/api/server-api';

/**
 * M-08: defense-in-depth shape validation for Server Action args. The API
 * tier has its own DTO check, but a malformed shape at this boundary
 * (oversized payload, wrong type) should fail fast in the web tier rather
 * than be proxied verbatim and trigger an opaque 400/500 from the API.
 *
 * The schemas are deliberately permissive on the deep shape (the export
 * payload is large and varied) but enforce length / count caps that bound
 * memory + RPC body size before the upstream call.
 */
const accountExportPayloadSchema = z
    .object({
        // Top-level fields the API tier requires
        version: z.union([z.string().max(64), z.number()]).optional(),
        user: z.unknown().optional(),
    })
    .catchall(z.unknown());

const conflictResolutionSchema = z.unknown(); // ConflictResolution shape is server-owned; cap by array length below.

const repoFullNameSchema = z
    .string()
    .min(3)
    .max(140)
    // M-04 mirror: owner/repo, GitHub-legal chars only.
    .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);

const configureSyncSchema = z.object({
    repoFullName: repoFullNameSchema.optional(),
    createNew: z.boolean().optional(),
});

function returnBadRequest(message: string) {
    return { success: false as const, data: null, error: message };
}

function ensureAuth() {
    return getAuthFromCookie().then((user) => {
        if (!user) redirect(ROUTES.AUTH_LOGIN);
        return user;
    });
}

export interface ExportToggles {
    includeSecrets?: boolean;
    /**
     * Phase 19.6 — per-feature v2 tail toggles. Default false so an
     * absent flag yields a v1-compatible payload.
     */
    includeAgents?: boolean;
    includeSkills?: boolean;
    includeTasks?: boolean;
    includeTaskChat?: boolean;
}

export async function exportAccountData(
    includeSecretsOrToggles: boolean | ExportToggles,
) {
    await ensureAuth();
    // Back-compat — `exportAccountData(true)` keeps working for the
    // pre-Phase-19.6 caller signature; `exportAccountData({...})` is
    // the new shape used by /settings/import-export.
    const opts: ExportToggles =
        typeof includeSecretsOrToggles === 'boolean'
            ? { includeSecrets: includeSecretsOrToggles }
            : includeSecretsOrToggles;
    const params = new URLSearchParams();
    if (opts.includeSecrets) params.set('includeSecrets', 'true');
    if (opts.includeAgents) params.set('includeAgents', 'true');
    if (opts.includeSkills) params.set('includeSkills', 'true');
    if (opts.includeTasks) params.set('includeTasks', 'true');
    if (opts.includeTaskChat && opts.includeTasks) params.set('includeTaskChat', 'true');
    try {
        const data = await serverFetch<AccountExportPayload>(
            `/account/export?${params.toString()}`,
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
    const parsed = accountExportPayloadSchema.safeParse(payload);
    if (!parsed.success) {
        return returnBadRequest('Invalid import payload shape');
    }
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
    const parsedPayload = accountExportPayloadSchema.safeParse(payload);
    if (!parsedPayload.success) {
        return returnBadRequest('Invalid import payload shape');
    }
    const parsedResolutions = z.array(conflictResolutionSchema).max(10_000).safeParse(resolutions);
    if (!parsedResolutions.success) {
        return returnBadRequest('Invalid resolutions array (too large or wrong shape)');
    }
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
    const parsed = configureSyncSchema.safeParse(config);
    if (!parsed.success) {
        return returnBadRequest('Invalid sync config (bad repoFullName format)');
    }
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

// PASS-4 review fix (HIGH): widen the action signature with the v2-tail
// toggles. Without this no UI surface could ever push Tasks via GitHub
// sync — the toggles silently defaulted in GitHubSyncService.
export async function pushToGitHub(
    options: {
        includeSecrets?: boolean;
        includeAgents?: boolean;
        includeSkills?: boolean;
        includeTasks?: boolean;
        includeTaskChat?: boolean;
    } = {},
) {
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
