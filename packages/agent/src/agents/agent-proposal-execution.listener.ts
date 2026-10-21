import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AgentActionProposalDecidedEvent } from '../agent-approvals/agent-action-proposal-decided.event';
import { AgentEscalationService } from './agent-escalation.service';
// Leaf token file — no runtime graph (see inbox-producer.port.ts).
import { INBOX_PRODUCER, type InboxProducer } from '../inbox/inbox-producer.port';
import { AGENT_FILE_NAMES, AgentFileService, type AgentFileName } from './agent-file.service';
import {
    AGENT_ESCALATION_RESOLUTION_PROPOSAL_KIND,
    AGENT_FILE_EDIT_PROPOSAL_KIND,
} from './agent-proposal-kinds';

/**
 * Prompt-injection hardening — the two Agent actions that used to take
 * effect the moment a model asked, and now wait for the owner:
 *
 *  - **`resolve_escalation`** — closing one of the owner's escalations (a
 *    human gate). The chat tool files a proposal instead of resolving; an
 *    approval here resolves the escalation as AGENT-authored, which closes it
 *    but never steers or resumes the run that was waiting on it.
 *  - **`editAgentFile`** — rewriting the Agent's own SOUL.md / AGENTS.md /
 *    HEARTBEAT.md / TOOLS.md / agent.yml, which every later run re-injects as
 *    trusted identity. The chat tool files the full proposed body; an approval
 *    here writes exactly that body, guarded by the content hash the Agent saw,
 *    so a file the owner changed in the meantime is not silently overwritten.
 *
 * Both reuse the Agent Action Approval Queue (`actionType: 'other'`, a
 * platform-written `kind` in the payload, `humanDecisionRequired`) — the same
 * pattern held email drafts use — so no new table, route or migration exists
 * for either.
 *
 * Only a PERSON's approval acts: a guardrail decision carries no
 * `decidedById` and is ignored, a rejection does nothing (the proposal row is
 * the record). Best-effort by contract, like every listener of this event: a
 * failure is logged, never thrown back into the request that decided — but an
 * APPROVED proposal that cannot be applied, for ANY reason (the service is not
 * wired, the payload is malformed, the state moved on), always files an Inbox
 * notice for the owner: an approval never fails silently.
 */
export { AGENT_ESCALATION_RESOLUTION_PROPOSAL_KIND, AGENT_FILE_EDIT_PROPOSAL_KIND };

@Injectable()
export class AgentProposalExecutionListener {
    private readonly logger = new Logger(AgentProposalExecutionListener.name);

    constructor(
        @Optional() private readonly escalations?: AgentEscalationService,
        @Optional() private readonly files?: AgentFileService,
        // Tells the owner when an APPROVED proposal could not be applied (the
        // file changed since the agent proposed it, the escalation was already
        // closed…), so an approval never fails silently. @Optional(), appended.
        @Optional() @Inject(INBOX_PRODUCER) private readonly inbox?: InboxProducer,
    ) {}

    @OnEvent(AgentActionProposalDecidedEvent.EVENT_NAME, { async: true })
    async handleProposalDecided(event: AgentActionProposalDecidedEvent): Promise<void> {
        if (event.actionType !== 'other') return;
        if (event.status !== 'approved') return;
        if (event.decidedVia !== 'user' || !event.decidedById) return;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        try {
            if (payload.kind === AGENT_ESCALATION_RESOLUTION_PROPOSAL_KIND) {
                await this.resolveEscalation(event, payload);
            } else if (payload.kind === AGENT_FILE_EDIT_PROPOSAL_KIND) {
                await this.applyFileEdit(event, payload);
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            this.logger.warn(
                `Approved proposal ${event.proposalId} (${String(payload.kind)}) could not be applied: ${reason}`,
            );
            await this.noticeNotApplied(event, payload, reason);
        }
    }

    /** Best-effort Inbox notice: the owner approved something that did not happen. */
    private async noticeNotApplied(
        event: AgentActionProposalDecidedEvent,
        payload: Record<string, unknown>,
        reason: string,
    ): Promise<void> {
        if (!this.inbox) return;
        const what =
            payload.kind === AGENT_FILE_EDIT_PROPOSAL_KIND
                ? `the edit to ${String(payload.fileName ?? 'an agent file')}`
                : `closing escalation ${String(payload.escalationId ?? '')}`;
        try {
            await this.inbox.notice(event.userId, {
                title: 'An approved agent change was NOT applied',
                body:
                    `You approved ${what}, but it could not be applied: ${reason.slice(0, 300)} ` +
                    'Nothing was changed. Review the current state and ask the agent again if it is still wanted.',
                agentId: event.agentId,
            });
        } catch (error) {
            this.logger.warn(
                `Not-applied notice for proposal ${event.proposalId} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    private async resolveEscalation(
        event: AgentActionProposalDecidedEvent,
        payload: Record<string, unknown>,
    ): Promise<void> {
        if (!this.escalations) {
            throw new Error('escalations are not available on this deployment.');
        }
        const escalationId = typeof payload.escalationId === 'string' ? payload.escalationId : '';
        if (!escalationId) throw new Error('the proposal names no escalation.');
        const note = typeof payload.note === 'string' ? payload.note : null;
        const resolved = await this.escalations.resolve(escalationId, event.userId, note, {
            resolvedBy: 'agent',
            agentId: event.agentId,
        });
        if (!resolved) {
            throw new Error('the escalation was already resolved or no longer exists.');
        }
    }

    private async applyFileEdit(
        event: AgentActionProposalDecidedEvent,
        payload: Record<string, unknown>,
    ): Promise<void> {
        if (!this.files) throw new Error('agent files are not available on this deployment.');
        const name = payload.fileName;
        if (typeof name !== 'string' || !AGENT_FILE_NAMES.includes(name as AgentFileName)) {
            throw new Error(`the proposal names no agent file (${AGENT_FILE_NAMES.join(', ')}).`);
        }
        if (typeof payload.body !== 'string') {
            throw new Error('the proposal carries no file body.');
        }
        // The platform always records the hash the Agent saw; without it the
        // write would be unguarded, so it is refused rather than applied blind.
        if (typeof payload.baseHash !== 'string') {
            throw new Error('the proposal carries no base content hash.');
        }
        await this.files.write({
            userId: event.userId,
            agentId: event.agentId,
            name: name as AgentFileName,
            body: payload.body,
            // The hash the Agent saw when it proposed: if the file changed
            // since (the owner edited it), the write refuses instead of
            // overwriting the newer content with a stale proposal.
            expectedHash: payload.baseHash,
            actor: 'agent',
            runId: typeof payload.runId === 'string' ? payload.runId : undefined,
        });
    }
}
