'use server';

import { revalidatePath } from 'next/cache';
import {
    emailAddressesAPI,
    type AgentEmailAssignment,
    type AgentInboxSettingsInput,
} from '@/lib/api/email-addresses';
import {
    describeEmailSendRefusal,
    type AgentEmailSendPolicyView,
    type EmailSendRefusal,
} from '@/lib/agent-email-policy';

/**
 * Agent email (AW-05) — server actions for the per-Agent inbox page:
 * decide a held draft, change the Agent's sending policy, and assign the
 * addresses it uses.
 *
 * Every result is a discriminated value the client renders from its own
 * translations. Raw backend messages never cross this boundary (they can
 * carry provider details); a structured refusal (send limit, approval
 * required, already decided) is passed as data instead.
 */

export type InboxActionFailure =
    | { ok: false; error: 'refused'; refusal: EmailSendRefusal }
    | { ok: false; error: 'duplicate' | 'failed' };

export type DraftDecisionResult = { ok: true } | InboxActionFailure;

function failure(err: unknown, context: string): InboxActionFailure {
    const refusal = describeEmailSendRefusal(err);
    if (refusal) return { ok: false, error: 'refused', refusal };
    const status = (err as { statusCode?: number } | null)?.statusCode;
    if (status === 409) return { ok: false, error: 'duplicate' };
    console.error(`${context} failed:`, err);
    return { ok: false, error: 'failed' };
}

function revalidateInbox(agentId: string): void {
    revalidatePath(`/agents/${agentId}/inbox`);
}

export async function approveDraftAction(
    agentId: string,
    messageId: string,
): Promise<DraftDecisionResult> {
    try {
        await emailAddressesAPI.approveDraft(messageId);
        revalidateInbox(agentId);
        return { ok: true };
    } catch (err) {
        revalidateInbox(agentId);
        return failure(err, 'approveDraftAction');
    }
}

export async function discardDraftAction(
    agentId: string,
    messageId: string,
): Promise<DraftDecisionResult> {
    try {
        await emailAddressesAPI.discardDraft(messageId);
        revalidateInbox(agentId);
        return { ok: true };
    } catch (err) {
        return failure(err, 'discardDraftAction');
    }
}

export type SaveInboxSettingsResult =
    | { ok: true; policy: AgentEmailSendPolicyView }
    | InboxActionFailure;

export async function saveAgentInboxSettingsAction(
    agentId: string,
    input: AgentInboxSettingsInput,
): Promise<SaveInboxSettingsResult> {
    try {
        const { inbox, meter } = await emailAddressesAPI.updateAgentInbox(agentId, input);
        revalidateInbox(agentId);
        return { ok: true, policy: { inbox, meter } };
    } catch (err) {
        return failure(err, 'saveAgentInboxSettingsAction');
    }
}

export type AssignmentResult = { ok: true; assignment: AgentEmailAssignment } | InboxActionFailure;

export async function assignAgentAddressAction(
    agentId: string,
    input: { emailAddressId: string; direction: 'outbound' | 'inbound' },
): Promise<AssignmentResult> {
    try {
        const assignment = await emailAddressesAPI.createAgentAssignment(agentId, input);
        revalidateInbox(agentId);
        return { ok: true, assignment };
    } catch (err) {
        return failure(err, 'assignAgentAddressAction');
    }
}

export async function removeAgentAddressAction(
    agentId: string,
    assignmentId: string,
): Promise<{ ok: true } | InboxActionFailure> {
    try {
        await emailAddressesAPI.removeAgentAssignment(assignmentId);
        revalidateInbox(agentId);
        return { ok: true };
    } catch (err) {
        return failure(err, 'removeAgentAddressAction');
    }
}
