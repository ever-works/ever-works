'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
    repoConnectionsAPI,
    type RepoConnectionEnvFileDto,
    type SaveRepoConnectionInput,
} from '@/lib/api/repo-connections';
import { ROUTES } from '@/lib/constants';
import { getAuthFromCookie } from '@/lib/auth';

// Repository registry (Feature G) — server actions behind
// Settings → Repositories and the agent settings "Repositories" card.

async function ensureAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
    return user;
}

type ActionResult<T> =
    | { success: true; data: T; error: null }
    | { success: false; data: null; error: string };

async function run<T>(fn: () => Promise<T>, fallback: string): Promise<ActionResult<T>> {
    await ensureAuth();
    try {
        const data = await fn();
        return { success: true as const, data, error: null };
    } catch (error) {
        return {
            success: false as const,
            data: null,
            error: error instanceof Error ? error.message : fallback,
        };
    }
}

function revalidateRepoSettings() {
    revalidatePath(ROUTES.DASHBOARD_SETTINGS_REPOSITORIES);
}

export async function createRepoConnection(input: SaveRepoConnectionInput) {
    const result = await run(() => repoConnectionsAPI.create(input), 'Failed to create repository');
    if (result.success) revalidateRepoSettings();
    return result;
}

export async function updateRepoConnection(id: string, input: Partial<SaveRepoConnectionInput>) {
    const result = await run(
        () => repoConnectionsAPI.update(id, input),
        'Failed to update repository',
    );
    if (result.success) revalidateRepoSettings();
    return result;
}

export async function deleteRepoConnection(id: string) {
    const result = await run(() => repoConnectionsAPI.remove(id), 'Failed to delete repository');
    if (result.success) revalidateRepoSettings();
    return result;
}

export async function revealRepoConnectionEnvFiles(id: string) {
    return run(() => repoConnectionsAPI.getEnvFiles(id), 'Failed to load env files');
}

export async function saveRepoConnectionEnvFiles(id: string, files: RepoConnectionEnvFileDto[]) {
    const result = await run(
        () => repoConnectionsAPI.setEnvFiles(id, files),
        'Failed to save env files',
    );
    if (result.success) revalidateRepoSettings();
    return result;
}

export async function importRepoConnectionFromGithubApp(installationRepoId: string) {
    const result = await run(
        () => repoConnectionsAPI.importFromGithubApp(installationRepoId),
        'Failed to import repository',
    );
    if (result.success) revalidateRepoSettings();
    return result;
}

export async function setAgentRepoAttachment(
    agentId: string,
    repoConnectionId: string,
    enabled: boolean,
) {
    return run(
        () => repoConnectionsAPI.setAgentAttachment(agentId, repoConnectionId, enabled),
        'Failed to update repository attachment',
    );
}

export async function removeAgentRepoAttachment(agentId: string, repoConnectionId: string) {
    return run(
        () => repoConnectionsAPI.removeAgentAttachment(agentId, repoConnectionId),
        'Failed to detach repository',
    );
}

/**
 * The owner's repository connections, for pickers (the "Also work in"
 * list on a Task). Read-only; the registry page keeps its own listing.
 */
export async function listRepoConnections() {
    const user = await getAuthFromCookie();
    if (!user) redirect(ROUTES.AUTH_LOGIN);
    return repoConnectionsAPI.list();
}
