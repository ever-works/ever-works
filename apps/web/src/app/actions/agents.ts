'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
    agentsAPI,
    type Agent,
    type AgentAssignCandidate,
    type AgentExportEnvelope,
    type AgentPickerOption,
    type AgentGuardrails,
    type AgentImportOptions,
    type AgentImportResult,
    type CreateAgentInput,
    type UpdateAgentInput,
    type AgentFileName,
    type ListRunSessionsQuery,
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

/**
 * Agent Dispatch Guardrails — replace the whole policy (PUT
 * semantics); pass `null` to clear back to the default
 * queue-everything posture.
 */
export async function updateAgentGuardrailsAction(
    id: string,
    guardrails: AgentGuardrails | null,
): Promise<Agent> {
    await ensureAuth();
    const updated = await agentsAPI.updateGuardrails(id, guardrails);
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
    // The archived tab gains a row on archive and loses one on hard
    // delete — both lists must be refetched, not just the catalog.
    revalidatePath('/agents/archived');
    return res;
}

export async function unarchiveAgentAction(id: string): Promise<Agent> {
    await ensureAuth();
    const agent = await agentsAPI.unarchive(id);
    revalidatePath('/agents');
    revalidatePath('/agents/archived');
    revalidatePath(`/agents/${id}`);
    return agent;
}

export async function deleteAgentHardAction(
    id: string,
): Promise<{ archived?: true; deleted?: true }> {
    await ensureAuth();
    const res = await agentsAPI.deleteHard(id);
    revalidatePath('/agents');
    revalidatePath('/agents/archived');
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

/**
 * Options for an Agent picker (the Task detail rail's "Agent" row).
 *
 * A projection, not the Agent DTO: only what a dropdown row renders
 * crosses the boundary. Archived Agents are dropped — they cannot pick up
 * work, so offering one would produce a Task that never runs. Read-only,
 * so no `revalidatePath`.
 */
export async function listAgentOptionsAction(limit = 100): Promise<AgentPickerOption[]> {
    await ensureAuth();
    const res = await agentsAPI.list({ limit: Math.min(100, limit) });
    return (res.data ?? [])
        .filter((agent) => agent.status !== 'archived')
        .map((agent) => ({
            id: agent.id,
            name: agent.name,
            slug: agent.slug,
            status: agent.status,
        }));
}

/** Bulk read matching the other Agent picker surfaces. */
const WORK_AGENT_CANDIDATE_LIMIT = 100;

/**
 * Candidates for the Work header's "Assign existing Agent" picker:
 * every Agent the caller owns that is not already on this Work.
 *
 * Scope is deliberately NOT filtered. Agents get created from wherever
 * the operator happened to be — most of them pinned to some Work — so
 * restricting the picker to tenant-scoped Agents hid nearly the whole
 * roster. What IS excluded: Agents already assigned here, Agents pinned
 * here by scope (they are on the Work already), and archived Agents,
 * dropped for the same reason the Task picker drops them — they can
 * never pick the work up.
 */
export async function listAssignableWorkAgentsAction(
    workId: string,
    search?: string,
): Promise<AgentAssignCandidate[]> {
    await ensureAuth();
    const trimmed = search?.trim();
    const [candidates, assigned] = await Promise.all([
        agentsAPI.list({
            limit: WORK_AGENT_CANDIDATE_LIMIT,
            ...(trimmed ? { search: trimmed } : {}),
        }),
        agentsAPI.list({ assignedWorkId: workId, limit: WORK_AGENT_CANDIDATE_LIMIT }),
    ]);
    const taken = new Set((assigned.data ?? []).map((agent) => agent.id));
    return (candidates.data ?? [])
        .filter(
            (agent) =>
                agent.status !== 'archived' &&
                !taken.has(agent.id) &&
                !(agent.scope === 'work' && agent.workId === workId),
        )
        .map((agent) => ({
            id: agent.id,
            name: agent.name,
            slug: agent.slug,
            title: agent.title,
            status: agent.status,
        }));
}

/**
 * Put an existing Agent on this Work / take it back off. Both are
 * idempotent server-side, so a double-click can't 409.
 */
export async function assignAgentToWorkAction(agentId: string, workId: string): Promise<Agent> {
    await ensureAuth();
    const agent = await agentsAPI.addTarget(agentId, { type: 'work', id: workId });
    revalidatePath(`/works/${workId}`, 'layout');
    revalidatePath(`/agents/${agentId}`);
    return agent;
}

export async function unassignAgentFromWorkAction(agentId: string, workId: string): Promise<Agent> {
    await ensureAuth();
    const agent = await agentsAPI.removeTarget(agentId, { type: 'work', id: workId });
    revalidatePath(`/works/${workId}`, 'layout');
    revalidatePath(`/agents/${agentId}`);
    return agent;
}

/**
 * Candidates for the Idea rail's "Assign existing Agent" picker — the
 * Idea mirror of `listAssignableWorkAgentsAction`, and deliberately the
 * same posture: scope is NOT filtered (Agents are created from wherever
 * the operator happened to be, so a scope filter hides most of the
 * roster), and what IS excluded is only what could never be a valid
 * pick — Agents already assigned to this Idea, Agents pinned here by
 * scope (they are on the Idea already), and archived Agents.
 */
export async function listAssignableIdeaAgentsAction(
    ideaId: string,
    search?: string,
): Promise<AgentAssignCandidate[]> {
    await ensureAuth();
    const trimmed = search?.trim();
    const [candidates, assigned] = await Promise.all([
        agentsAPI.list({
            limit: WORK_AGENT_CANDIDATE_LIMIT,
            ...(trimmed ? { search: trimmed } : {}),
        }),
        agentsAPI.list({ assignedIdeaId: ideaId, limit: WORK_AGENT_CANDIDATE_LIMIT }),
    ]);
    const taken = new Set((assigned.data ?? []).map((agent) => agent.id));
    return (candidates.data ?? [])
        .filter(
            (agent) =>
                agent.status !== 'archived' &&
                !taken.has(agent.id) &&
                !(agent.scope === 'idea' && agent.ideaId === ideaId),
        )
        .map((agent) => ({
            id: agent.id,
            name: agent.name,
            slug: agent.slug,
            title: agent.title,
            status: agent.status,
        }));
}

/**
 * Put an existing Agent on this Idea / take it back off. Both are
 * idempotent server-side, so a double-click can't 409.
 */
export async function assignAgentToIdeaAction(agentId: string, ideaId: string): Promise<Agent> {
    await ensureAuth();
    const agent = await agentsAPI.addTarget(agentId, { type: 'idea', id: ideaId });
    revalidatePath(`/ideas/${ideaId}`, 'layout');
    revalidatePath(`/agents/${agentId}`);
    return agent;
}

export async function unassignAgentFromIdeaAction(agentId: string, ideaId: string): Promise<Agent> {
    await ensureAuth();
    const agent = await agentsAPI.removeTarget(agentId, { type: 'idea', id: ideaId });
    revalidatePath(`/ideas/${ideaId}`, 'layout');
    revalidatePath(`/agents/${agentId}`);
    return agent;
}

export async function listAgentRunsAction(
    id: string,
    opts: { limit?: number; offset?: number } = {},
) {
    await ensureAuth();
    return agentsAPI.listRuns(id, opts);
}

export async function listAgentEventsAction(
    id: string,
    opts: { limit?: number; offset?: number } = {},
) {
    await ensureAuth();
    return agentsAPI.listEvents(id, opts);
}

export async function getAgentRunDetailAction(id: string, runId: string) {
    await ensureAuth();
    return agentsAPI.getRun(id, runId);
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

/**
 * Run steering (Wave 4 M5) — the three run controls behind the Task-detail
 * buttons. "Stop" stays `cancelAgentRunAction` above.
 *
 * Errors are deliberately NOT swallowed: the API answers 409 when the control
 * does not apply to the run's state ("already finished", "not resumable"), and
 * that is exactly what the caller must show the user.
 */
export async function steerAgentRunAction(id: string, runId: string, message: string) {
    await ensureAuth();
    const res = await agentsAPI.steerRun(id, runId, message);
    revalidatePath(`/agents/${id}/activity`);
    return res;
}

export async function interruptAgentRunAction(id: string, runId: string) {
    await ensureAuth();
    const res = await agentsAPI.interruptRun(id, runId);
    revalidatePath(`/agents/${id}/activity`);
    return res;
}

export async function resumeAgentRunAction(id: string, runId: string, message?: string | null) {
    await ensureAuth();
    const res = await agentsAPI.resumeRun(id, runId, message ?? null);
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

/**
 * Run orchestration (Wave 4 M4) — read-only refresh used by the Sessions
 * tab's polling hook. No revalidatePath on purpose — this is a poll, not
 * a mutation (same posture as `listTasksWithRunsAction`).
 */
export async function listRunSessionsAction(query: ListRunSessionsQuery = {}) {
    await ensureAuth();
    return agentsAPI.listSessions(query);
}

// ── Agent Collaborators — sub-agent delegation allow-list ──

/** Read-only refresh for the Collaborators tab (no revalidate — a poll). */
export async function listAgentCollaboratorsAction(agentId: string) {
    await ensureAuth();
    return agentsAPI.listCollaborators(agentId);
}

export async function setAgentCollaboratorAction(
    agentId: string,
    collaboratorAgentId: string,
    enabled: boolean,
) {
    await ensureAuth();
    const result = await agentsAPI.setCollaborator(agentId, collaboratorAgentId, enabled);
    revalidatePath(`/agents/${agentId}/collaborators`);
    return result;
}

export async function removeAgentCollaboratorAction(agentId: string, collaboratorAgentId: string) {
    await ensureAuth();
    const result = await agentsAPI.removeCollaborator(agentId, collaboratorAgentId);
    revalidatePath(`/agents/${agentId}/collaborators`);
    return result;
}

/**
 * Session detail (Feature K) — read used by the detail page's refresh
 * button, live-follow poll and timeline pagination. No revalidatePath —
 * a poll, not a mutation (same posture as `listRunSessionsAction`).
 */
export async function getRunSessionDetailAction(
    runId: string,
    query: { cursor?: string; limit?: number } = {},
) {
    await ensureAuth();
    return agentsAPI.getSessionDetail(runId, query);
}

// ── Agent Collaborators — sub-agent delegation allow-list ──

/** Read-only refresh for the Collaborators tab (no revalidate — a poll). */
export async function listAgentCollaboratorsAction(agentId: string) {
    await ensureAuth();
    return agentsAPI.listCollaborators(agentId);
}

export async function setAgentCollaboratorAction(
    agentId: string,
    collaboratorAgentId: string,
    enabled: boolean,
) {
    await ensureAuth();
    const result = await agentsAPI.setCollaborator(agentId, collaboratorAgentId, enabled);
    revalidatePath(`/agents/${agentId}/collaborators`);
    return result;
}

export async function removeAgentCollaboratorAction(agentId: string, collaboratorAgentId: string) {
    await ensureAuth();
    const result = await agentsAPI.removeCollaborator(agentId, collaboratorAgentId);
    revalidatePath(`/agents/${agentId}/collaborators`);
    return result;
}
