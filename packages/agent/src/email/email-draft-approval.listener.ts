import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { AgentActionProposalDecidedEvent } from '../agent-approvals/agent-action-proposal-decided.event';
import { EMAIL_DRAFT_PROPOSAL_KIND, EmailDraftService } from './email-draft.service';

/**
 * Agent email (AW-05) — acts on a decision made in the approvals queue for
 * a held email draft: approved → the draft is released, rejected → it is
 * discarded.
 *
 * Idempotent by construction: `EmailDraftService` moves the message with a
 * compare-and-set on its status, so when the email surface decided first
 * (and mirrored that decision into the queue, which fires this event), the
 * second attempt finds the message no longer a draft and does nothing.
 *
 * Only a PERSON's decision releases mail. A guardrail auto-decision carries
 * no `decidedById` and is ignored here; the draft stays for a person to
 * approve from the email surface.
 *
 * Best-effort by contract: a failure is logged, never thrown back into the
 * request that recorded the decision.
 */
@Injectable()
export class EmailDraftApprovalListener {
    private readonly logger = new Logger(EmailDraftApprovalListener.name);

    constructor(private readonly drafts: EmailDraftService) {}

    @OnEvent(AgentActionProposalDecidedEvent.EVENT_NAME, { async: true })
    async handleProposalDecided(event: AgentActionProposalDecidedEvent): Promise<void> {
        if (event.actionType !== 'send_message') return;
        const payload = event.payload ?? {};
        if (payload.kind !== EMAIL_DRAFT_PROPOSAL_KIND) return;
        const messageId =
            typeof payload.emailMessageId === 'string' ? payload.emailMessageId : null;
        if (!messageId || event.decidedVia !== 'user' || !event.decidedById) return;

        try {
            if (event.status === 'approved') {
                await this.drafts.approve(event.userId, messageId, {
                    approvedById: event.decidedById,
                    viaDecision: true,
                });
            } else {
                await this.drafts.discard(event.userId, messageId, { viaDecision: true });
            }
        } catch (error) {
            this.logger.warn(
                `Email draft ${messageId} was not ${event.status === 'approved' ? 'released' : 'discarded'} from proposal ${event.proposalId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}
