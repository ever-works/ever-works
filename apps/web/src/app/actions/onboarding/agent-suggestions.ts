'use server';

import { agentsAPI, type Agent, type AgentTemplateSummary } from '@/lib/api/agents';
import type { ActionResult } from '@/app/actions/plugins';

/**
 * Wave 11 — server actions behind the onboarding ProfileStep's
 * "suggested agents" block. Thin ActionResult wrappers (discriminated
 * unions, never thrown errors — Server Actions redact thrown messages
 * in prod) around the Wave 10 template endpoints:
 *
 *   GET  /api/agents/templates            → list the prebuilt catalog
 *   POST /api/agents/from-template/:slug  → create MY Agent from one
 *
 * Both are best-effort for onboarding: the step hides the block when
 * the list call fails, and surfaces a toast when a create fails. Auth
 * is enforced by the API tier (same posture as actions/onboarding/state.ts).
 */

/** List the prebuilt agent-template catalog for client-side role filtering. */
export async function listAgentTemplatesForOnboarding(): Promise<
    ActionResult<AgentTemplateSummary[]>
> {
    try {
        const res = await agentsAPI.listTemplates();
        return { success: true, data: res.data ?? [] };
    } catch (error) {
        console.error('Failed to list agent templates for onboarding:', error);
        return { success: false, error: 'Failed to load agent templates' };
    }
}

/** Create the caller's Agent from a prebuilt template (DRAFT + guardrails). */
export async function createAgentFromTemplateForOnboarding(
    slug: string,
): Promise<ActionResult<Agent>> {
    try {
        const created = await agentsAPI.createFromTemplate(slug);
        return { success: true, data: created };
    } catch (error) {
        console.error('Failed to create agent from template:', error);
        return { success: false, error: 'Failed to create the agent' };
    }
}
