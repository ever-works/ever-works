'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { AgentCapabilitiesPayload } from '@ever-works/contracts';
import { agentsAPI, type Agent } from '@/lib/api/agents';
import { toolGrantsAPI } from '@/lib/api/tool-grants';
import { skillsAPI, type Skill, type SkillBinding } from '@/lib/api/skills';
import { getAuthFromCookie } from '@/lib/auth';
import { ROUTES } from '@/lib/constants';

/**
 * Agent Capabilities tab — server actions.
 *
 * Thin wraps over the composed capabilities read plus the EXISTING write
 * endpoints (tool-grants PUT/DELETE, agents PATCH, skill bindings) so the
 * `'use client'` AgentCapabilitiesClient never imports a `server-only`
 * module. Same defense-in-depth auth posture as `actions/agents.ts`:
 * the API tier is the final guard, but every action re-verifies the
 * session cookie first.
 *
 * Grant mutations return the FRESH composed payload rather than the raw
 * grant row: the interesting result of a toggle is the re-resolved chain
 * (a parent layer may still deny), and one round-trip keeps the client
 * from re-deriving policy it does not own.
 */

async function ensureAuth() {
    const user = await getAuthFromCookie();
    if (!user) {
        redirect(ROUTES.AUTH_LOGIN);
    }
    return user;
}

export async function getAgentCapabilitiesAction(
    agentId: string,
): Promise<AgentCapabilitiesPayload> {
    await ensureAuth();
    return agentsAPI.getCapabilities(agentId);
}

/**
 * Replace the AGENT-scope grant row with the given lists (PUT semantics —
 * the row is replaced, so callers always send the full desired lists).
 */
export async function setAgentToolGrantAction(
    agentId: string,
    grant: { allow?: string[]; deny?: string[]; note?: string },
): Promise<AgentCapabilitiesPayload> {
    await ensureAuth();
    await toolGrantsAPI.upsert({ scopeType: 'agent', scopeId: agentId, ...grant });
    revalidatePath(`/agents/${agentId}/capabilities`);
    return agentsAPI.getCapabilities(agentId);
}

/**
 * Delete the agent-scope grant row — the Agent reverts to inheriting.
 *
 * `DELETE /api/tool-grants/:id` is scoped by `{ id, userId }` only, so it
 * would happily drop ANOTHER Agent's row inside the same account if the id
 * on the wire did not belong to `agentId`. This surface is per-Agent, so
 * bind the two together first: the composed read already returns the one
 * row that is agent-scoped to `agentId`, and only that id may be deleted.
 */
export async function resetAgentToolGrantAction(
    agentId: string,
    grantRowId: string,
): Promise<AgentCapabilitiesPayload> {
    await ensureAuth();
    const current = await agentsAPI.getCapabilities(agentId);
    if (current.agentGrantRow?.id !== grantRowId) {
        throw new Error('That tool-grant row does not belong to this agent.');
    }
    await toolGrantsAPI.remove(grantRowId);
    revalidatePath(`/agents/${agentId}/capabilities`);
    return agentsAPI.getCapabilities(agentId);
}

/**
 * Save the init script (rides `PATCH /api/agents/:id`). Expected
 * rejections (16 KB cap, secret scan) come back as data — Next.js
 * redacts Server Action error messages in production builds, so the
 * API's real message must be captured HERE (mirrors
 * `writeAgentFileAction`).
 */
export type SaveInitScriptResult = { ok: true; agent: Agent } | { ok: false; message: string };

export async function updateAgentInitScriptAction(
    agentId: string,
    initScript: string | null,
): Promise<SaveInitScriptResult> {
    await ensureAuth();
    try {
        const agent = await agentsAPI.update(agentId, { initScript });
        revalidatePath(`/agents/${agentId}/capabilities`);
        return { ok: true, agent };
    } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Attach an already-installed Skill to this Agent (agent-scope binding).
 */
export async function bindSkillToAgentAction(
    agentId: string,
    skillId: string,
): Promise<SkillBinding> {
    await ensureAuth();
    const binding = await skillsAPI.createBinding(skillId, {
        targetType: 'agent',
        targetId: agentId,
    });
    revalidatePath(`/agents/${agentId}/capabilities`);
    revalidatePath(`/agents/${agentId}/skills`);
    return binding;
}

/**
 * Catalog shortcut — install a catalog Skill into the caller's tenant
 * scope, then bind it to this Agent, in one action.
 */
export async function installAndBindSkillAction(
    agentId: string,
    catalogSlug: string,
): Promise<{ skill: Skill; binding: SkillBinding }> {
    const user = await ensureAuth();
    const skill = await skillsAPI.install({
        slug: catalogSlug,
        ownerType: 'tenant',
        ownerId: user.id,
    });
    const binding = await skillsAPI.createBinding(skill.id, {
        targetType: 'agent',
        targetId: agentId,
    });
    revalidatePath(`/agents/${agentId}/capabilities`);
    revalidatePath(`/agents/${agentId}/skills`);
    revalidatePath('/skills');
    return { skill, binding };
}

/**
 * Unbind (delete the agent-scope binding row).
 *
 * Same guard as `resetAgentToolGrantAction`: `DELETE /api/skill-bindings/:id`
 * is scoped by `{ id, userId }` only, so an id belonging to a sibling Agent —
 * or to an INHERITED binding owned by a parent scope, which this page renders
 * read-only — would delete just as happily. Require that the binding is
 * listed for `agentId` AND is itself agent-scoped before removing it.
 */
export async function unbindSkillFromAgentAction(
    agentId: string,
    bindingId: string,
): Promise<{ deleted: true }> {
    await ensureAuth();
    const bound = await agentsAPI.listSkills(agentId);
    const owned = bound.data.some(
        (entry) => entry.bindingId === bindingId && entry.targetType === 'agent',
    );
    if (!owned) {
        throw new Error('That skill binding is not owned by this agent.');
    }
    const res = await skillsAPI.deleteBinding(bindingId);
    revalidatePath(`/agents/${agentId}/capabilities`);
    revalidatePath(`/agents/${agentId}/skills`);
    return res;
}
