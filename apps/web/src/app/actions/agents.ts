'use server';

import { revalidatePath } from 'next/cache';
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

/**
 * Agents/Skills/Tasks PR #1017 — Phase 5. Server actions that
 * thin-wrap the agents API client so client components can call
 * write paths without leaking the server-only `serverFetch`
 * helpers. Each mutation invalidates the relevant page caches.
 */

export async function createAgentAction(input: CreateAgentInput): Promise<Agent> {
    const created = await agentsAPI.create(input);
    revalidatePath('/agents');
    return created;
}

export async function updateAgentAction(id: string, input: UpdateAgentInput): Promise<Agent> {
    const updated = await agentsAPI.update(id, input);
    revalidatePath('/agents');
    revalidatePath(`/agents/${id}`);
    return updated;
}

export async function pauseAgentAction(id: string): Promise<Agent> {
    const agent = await agentsAPI.pause(id);
    revalidatePath(`/agents/${id}`);
    revalidatePath('/agents');
    return agent;
}

export async function resumeAgentAction(id: string): Promise<Agent> {
    const agent = await agentsAPI.resume(id);
    revalidatePath(`/agents/${id}`);
    revalidatePath('/agents');
    return agent;
}

export async function archiveAgentAction(id: string): Promise<{ archived?: true; deleted?: true }> {
    const res = await agentsAPI.archive(id);
    revalidatePath('/agents');
    return res;
}

export async function deleteAgentHardAction(
    id: string,
): Promise<{ archived?: true; deleted?: true }> {
    const res = await agentsAPI.deleteHard(id);
    revalidatePath('/agents');
    return res;
}

export async function writeAgentFileAction(
    id: string,
    name: AgentFileName,
    body: string,
    expectedHash?: string,
): Promise<{ newHash: string }> {
    const res = await agentsAPI.writeFile(id, name, body, expectedHash);
    revalidatePath(`/agents/${id}/instructions`);
    return res;
}

export async function exportAgentAction(id: string): Promise<AgentExportEnvelope> {
    return agentsAPI.exportOne(id);
}

export async function importAgentAction(
    envelope: AgentExportEnvelope,
    options: AgentImportOptions = {},
): Promise<AgentImportResult> {
    const res = await agentsAPI.importOne(envelope, options);
    revalidatePath('/agents');
    return res;
}
