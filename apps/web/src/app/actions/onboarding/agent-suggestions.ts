'use server';

import { agentsAPI, type Agent, type AgentTemplateSummary } from '@/lib/api/agents';
import { onboardingSuggestionsAPI } from '@/lib/api/onboarding-suggestions';
import type {
    OnboardingSeedResponse,
    OnboardingSeedSuggestionsResponse,
} from '@ever-works/contracts/api';
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

/**
 * A55 — resolve the SERVER-side starter kit for `roles`.
 *
 * Supersedes the browser-side catalog filter the ProfileStep used: the
 * mapping covers every role in `ROLE_OPTIONS` (not the three that
 * happened to be tagged on a template) and returns skills as well as
 * agents. Best-effort, like the list call above — the block hides
 * itself rather than blocking the wizard on a suggestion.
 */
export async function getRoleSeedSuggestions(
    roles: readonly string[],
): Promise<ActionResult<OnboardingSeedSuggestionsResponse>> {
    try {
        const data = await onboardingSuggestionsAPI.suggest(roles);
        return { success: true, data };
    } catch (error) {
        console.error('Failed to resolve onboarding role suggestions:', error);
        return { success: false, error: 'Failed to load suggestions' };
    }
}

/**
 * A55 — create the whole starter kit server-side in one call.
 *
 * Idempotent per template: re-running the step reports the already
 * activated ones instead of creating duplicates, which the old
 * one-create-per-card client flow could not do.
 */
export async function seedRoleStarterAgents(
    roles: readonly string[],
): Promise<ActionResult<OnboardingSeedResponse>> {
    try {
        const data = await onboardingSuggestionsAPI.seed(roles);
        return { success: true, data };
    } catch (error) {
        console.error('Failed to seed onboarding starter agents:', error);
        return { success: false, error: 'Failed to set up your starter agents' };
    }
}
