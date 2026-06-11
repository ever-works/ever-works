'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
    agentsAPI,
    type Agent,
    type AgentExportEnvelope,
    type AgentImportOptions,
    type AgentImportResult,
    type CreateAgentInput,
    type UpdateAgentInput,
    type AgentFileName,
} from '@/lib/api/agents';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 5. Server actions that
 * thin-wrap the agents API client so client components can call
 * write paths without leaking the server-only `serverFetch`
 * helpers. Each mutation invalidates the relevant page caches.
 */

// Security (authn): defense-in-depth auth guard for every agent
// Server Action — mirrors `ensureAuth()` in account-transfer.ts and the
// inline cookie check in api-keys.ts. The API tier is the final guard,
// but re-verifying identity at the web-action boundary closes the
// layered-defense gap so a confused-deputy / CSRF-style POST to a
// Server Action endpoint can't reach `agentsAPI.*` mutations without a
// valid session. `getAuthFromCookie` is React-`cache()`-wrapped, so the
// per-action call is deduplicated and cheap.
async function ensureAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
    return user;
}

export async function createAgentAction(input: CreateAgentInput): Promise<Agent> {
    await ensureAuth();
    const created = await agentsAPI.create(input);
    revalidatePath('/agents');
    return created;
}

export async function updateAgentAction(id: string, input: UpdateAgentInput): Promise<Agent> {
    await ensureAuth();
    const updated = await agentsAPI.update(id, input);
    revalidatePath('/agents');
    revalidatePath(`/agents/${id}`);
    return updated;
}

export async function pauseAgentAction(id: string): Promise<Agent> {
    await ensureAuth();
    const agent = await agentsAPI.pause(id);
    revalidatePath(`/agents/${id}`);
    revalidatePath('/agents');
    return agent;
}

export async function resumeAgentAction(id: string): Promise<Agent> {
    await ensureAuth();
    const agent = await agentsAPI.resume(id);
    revalidatePath(`/agents/${id}`);
    revalidatePath('/agents');
    return agent;
}

export async function archiveAgentAction(id: string): Promise<{ archived?: true; deleted?: true }> {
    await ensureAuth();
    const res = await agentsAPI.archive(id);
    revalidatePath('/agents');
    return res;
}

export async function deleteAgentHardAction(
    id: string,
): Promise<{ archived?: true; deleted?: true }> {
    await ensureAuth();
    const res = await agentsAPI.deleteHard(id);
    revalidatePath('/agents');
    return res;
}

/**
 * Discriminated result for the instruction-file autosave. EXPECTED
 * failures (parallel-edit etag conflict, validation rejects) are
 * returned as DATA, not thrown: Next.js redacts Server Action error
 * messages in production builds, so the editor's old
 * `/etag/i.test(err.message)` classification silently degraded every
 * conflict to the generic "Save failed" banner under `next start`
 * (it only ever worked in dev, where messages leak through). The
 * etag detection now happens HERE — server-side, where the API's
 * real message is still intact.
 */
export type WriteAgentFileResult =
    | { ok: true; newHash: string }
    | { ok: false; conflict: boolean; message: string };

export async function writeAgentFileAction(
    id: string,
    name: AgentFileName,
    body: string,
    expectedHash?: string,
): Promise<WriteAgentFileResult> {
    await ensureAuth();
    try {
        const res = await agentsAPI.writeFile(id, name, body, expectedHash);
        revalidatePath(`/agents/${id}/instructions`);
        return { ok: true, newHash: res.newHash };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, conflict: /etag/i.test(message), message };
    }
}

export async function exportAgentAction(id: string): Promise<AgentExportEnvelope> {
    await ensureAuth();
    return agentsAPI.exportOne(id);
}

export async function importAgentAction(
    envelope: AgentExportEnvelope,
    options: AgentImportOptions = {},
): Promise<AgentImportResult> {
    await ensureAuth();
    const res = await agentsAPI.importOne(envelope, options);
    revalidatePath('/agents');
    return res;
}

// FU-2 / FU-4 post-CI fix: client-side surfaces on `/agents/[id]/*`
// can't reach `agentsAPI` directly — it imports `'server-only'`. These
// thin actions wrap the runtime endpoints (listRuns / listSkills /
// getBudget / runNow / cancelRun) so the AgentActivityClient /
// AgentSkillsClient / AgentBudgetsClient client components stay clean.

export async function listAgentRunsAction(
    id: string,
    opts: { limit?: number; offset?: number } = {},
) {
    await ensureAuth();
    return agentsAPI.listRuns(id, opts);
}

export async function listAgentSkillsAction(id: string) {
    await ensureAuth();
    return agentsAPI.listSkills(id);
}

export async function getAgentBudgetAction(id: string) {
    await ensureAuth();
    return agentsAPI.getBudget(id);
}

export async function runAgentNowAction(id: string) {
    await ensureAuth();
    const res = await agentsAPI.runNow(id);
    revalidatePath(`/agents/${id}/activity`);
    return res;
}

export async function cancelAgentRunAction(id: string, runId: string) {
    await ensureAuth();
    const res = await agentsAPI.cancelRun(id, runId);
    revalidatePath(`/agents/${id}/activity`);
    return res;
}

// Attachment actions — used by the PromptComposer-driven flow on
// /new (Agent chip). Lets the caller wire uploads to an Agent once
// we have its id.

export async function attachUploadToAgentAction(agentId: string, uploadId: string) {
    await ensureAuth();
    const row = await agentsAPI.addAttachment(agentId, uploadId);
    revalidatePath(`/agents/${agentId}`);
    return row;
}

export async function detachAgentAttachmentAction(agentId: string, attachmentId: string) {
    await ensureAuth();
    const result = await agentsAPI.removeAttachment(agentId, attachmentId);
    revalidatePath(`/agents/${agentId}`);
    return result;
}
