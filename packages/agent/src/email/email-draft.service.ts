import {
    ConflictException,
    ForbiddenException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import type { EmailSendResult } from '@ever-works/plugin';
import { EMAIL_MAX_FAILURE_REASON_CHARS } from '@ever-works/contracts';
import { AgentApprovalsService } from '../agent-approvals/agent-approvals.service';
import type { EmailMessage } from '../entities/email-message.entity';
import { EmailMessageRepository } from '../database/repositories/email-message.repository';
import { EmailFacadeService } from '../facades/email.facade';
import { EmailSendCapExceededException } from './email-send-cap-exceeded.exception';
import { EmailSendPolicyService } from './email-send-policy.service';

/** Proposal payload discriminator for a held email draft. */
export const EMAIL_DRAFT_PROPOSAL_KIND = 'email-draft' as const;

/** An Agent-written message, fully resolved by the caller (address, rendered body). */
export interface SubmitAgentEmailInput {
    userId: string;
    agentId: string;
    /** `tenant_email_addresses.id` the message is sent from. */
    emailAddressId: string;
    /** Provider plugin id of that address (recorded on the draft row). */
    pluginId: string;
    from: string;
    to: readonly string[];
    cc?: readonly string[];
    bcc?: readonly string[];
    subject: string;
    bodyText: string;
    bodyHtml?: string;
    messageRef: string;
    workId?: string;
    taskId?: string;
    runId?: string;
}

export type SubmitAgentEmailResult =
    | {
          held: true;
          reason: 'awaiting-approval';
          messageId: string;
          approvalId: string | null;
      }
    | { held: false; result: EmailSendResult };

export interface EmailDraftDecisionResult {
    message: EmailMessage;
    result?: EmailSendResult;
}

/**
 * Agent email (AW-05) — the approve-before-send loop.
 *
 * `submit` is where an Agent's outbound message is either sent (inbox mode
 * `auto-send`) or persisted as a `draft` and mirrored into the approvals
 * queue as a pending `send_message` proposal (`draft-review`), so it shows
 * up wherever a person makes decisions.
 *
 * `approve` / `discard` are the two ways out of `draft`. Both are
 * compare-and-set on the row's status, so two people (or the email surface
 * and the approvals queue) deciding at once produce exactly one send; the
 * loser is told who decided and when. The actual release goes through
 * `EmailFacadeService.send` with the draft id — where the send-policy gate
 * reads the approval back from the row before any provider is touched.
 *
 * A refused ceiling does not lose the message: the draft returns to `draft`
 * with the reason, ready to approve again once capacity returns. A provider
 * failure leaves it `failed` with the provider's reason.
 */
@Injectable()
export class EmailDraftService {
    private readonly logger = new Logger(EmailDraftService.name);

    constructor(
        private readonly messages: EmailMessageRepository,
        private readonly facade: EmailFacadeService,
        private readonly policy: EmailSendPolicyService,
        private readonly approvals: AgentApprovalsService,
    ) {}

    async submit(input: SubmitAgentEmailInput): Promise<SubmitAgentEmailResult> {
        const { mode } = await this.policy.resolvePolicy(input.userId, input.agentId);
        if (mode === 'auto-send') {
            const result = await this.facade.send(
                {
                    from: input.from,
                    to: [...input.to],
                    cc: input.cc ? [...input.cc] : undefined,
                    bcc: input.bcc ? [...input.bcc] : undefined,
                    subject: input.subject,
                    bodyText: input.bodyText,
                    bodyHtml: input.bodyHtml,
                    messageRef: input.messageRef,
                },
                {
                    userId: input.userId,
                    agentId: input.agentId,
                    workId: input.workId,
                    taskId: input.taskId,
                    addressId: input.emailAddressId,
                    origin: 'agent',
                },
            );
            return { held: false, result };
        }

        const draft = await this.messages.save({
            userId: input.userId,
            agentId: input.agentId,
            taskId: input.taskId ?? null,
            conversationId: null,
            emailAddressId: input.emailAddressId,
            direction: 'outbound',
            pluginId: input.pluginId,
            providerMessageId: null,
            from: input.from,
            toAddresses: [...input.to],
            ccAddresses: input.cc?.length ? [...input.cc] : null,
            bccAddresses: input.bcc?.length ? [...input.bcc] : null,
            subject: input.subject,
            bodyText: input.bodyText,
            bodyHtml: input.bodyHtml ?? null,
            metadata: null,
            messageRef: input.messageRef,
            sentAt: null,
            deliveryStatus: null,
            status: 'draft',
        } as Parameters<EmailMessageRepository['save']>[0]);

        let approvalId: string | null = null;
        try {
            const proposal = await this.approvals.createProposal(input.userId, {
                agentId: input.agentId,
                actionType: 'send_message',
                title: draftTitle(input.to, input.subject),
                runId: input.runId ?? null,
                payload: {
                    kind: EMAIL_DRAFT_PROPOSAL_KIND,
                    emailMessageId: draft.id,
                    recipientCount:
                        input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0),
                },
            });
            approvalId = proposal.id;
            await this.messages.transitionStatus(draft.id, ['draft'], 'draft', { approvalId });
            if (proposal.status === 'rejected') {
                // The Agent's own guardrails forbid this action type. Keep the
                // record, say why, send nothing.
                await this.messages.transitionStatus(draft.id, ['draft'], 'discarded', {
                    failureReason: "Blocked by this agent's guardrails.",
                });
                throw new ForbiddenException(
                    "This agent's guardrails do not allow it to send email.",
                );
            }
        } catch (error) {
            if (error instanceof ForbiddenException) throw error;
            // The draft is held either way; approving from the email surface
            // still works without the queue mirror.
            this.logger.warn(
                `Draft ${draft.id} could not be mirrored to the approvals queue: ${describe(error)}`,
            );
        }
        return { held: true, reason: 'awaiting-approval', messageId: draft.id, approvalId };
    }

    /**
     * Release a draft. `viaDecision` is set when the approvals queue already
     * recorded the decision (the listener path), so it is not decided twice.
     */
    async approve(
        userId: string,
        messageId: string,
        options: { approvedById?: string; viaDecision?: boolean } = {},
    ): Promise<EmailDraftDecisionResult> {
        const draft = await this.requireOwnedOutbound(userId, messageId);
        const approvedById = options.approvedById ?? userId;
        if (draft.status !== 'draft') throw alreadyDecided(draft);

        const moved = await this.messages.transitionStatus(messageId, ['draft'], 'sending', {
            approvedById,
            approvedAt: new Date(),
            failureReason: null,
        });
        if (moved === 0) {
            throw alreadyDecided(await this.requireOwnedOutbound(userId, messageId));
        }

        if (draft.approvalId && !options.viaDecision) {
            const stillAllowed = await this.recordDecision(userId, draft.approvalId, 'approved');
            if (!stillAllowed) {
                await this.messages.transitionStatus(messageId, ['sending'], 'discarded', {
                    failureReason: 'Rejected in the approvals queue.',
                });
                throw alreadyDecided(await this.requireOwnedOutbound(userId, messageId));
            }
        }

        try {
            const result = await this.facade.send(
                {
                    from: draft.from,
                    to: [...draft.toAddresses],
                    cc: draft.ccAddresses ? [...draft.ccAddresses] : undefined,
                    bcc: draft.bccAddresses ? [...draft.bccAddresses] : undefined,
                    subject: draft.subject,
                    bodyText: draft.bodyText,
                    bodyHtml: draft.bodyHtml ?? undefined,
                    messageRef: draft.messageRef ?? `draft-${draft.id}`,
                },
                {
                    userId,
                    agentId: draft.agentId ?? undefined,
                    taskId: draft.taskId ?? undefined,
                    addressId: draft.emailAddressId,
                    origin: 'agent',
                    draftMessageId: draft.id,
                },
            );
            return { message: await this.requireOwnedOutbound(userId, messageId), result };
        } catch (error) {
            const reason = describe(error).slice(0, EMAIL_MAX_FAILURE_REASON_CHARS);
            if (error instanceof EmailSendCapExceededException) {
                // Nothing lost: back to draft, approvable again once capacity returns.
                await this.messages.transitionStatus(messageId, ['sending'], 'draft', {
                    failureReason: reason,
                    approvedById: null,
                    approvedAt: null,
                });
            } else {
                await this.messages.transitionStatus(messageId, ['sending'], 'failed', {
                    failureReason: reason,
                });
            }
            throw error;
        }
    }

    async discard(
        userId: string,
        messageId: string,
        options: { viaDecision?: boolean } = {},
    ): Promise<EmailDraftDecisionResult> {
        const draft = await this.requireOwnedOutbound(userId, messageId);
        if (draft.status !== 'draft' && draft.status !== 'failed') throw alreadyDecided(draft);
        const moved = await this.messages.transitionStatus(
            messageId,
            ['draft', 'failed'],
            'discarded',
        );
        if (moved === 0) {
            throw alreadyDecided(await this.requireOwnedOutbound(userId, messageId));
        }
        if (draft.approvalId && !options.viaDecision) {
            await this.recordDecision(userId, draft.approvalId, 'rejected');
        }
        return { message: await this.requireOwnedOutbound(userId, messageId) };
    }

    /**
     * Mirror a decision made on the email surface into the approvals queue.
     * Returns `false` only when the queue already holds the OPPOSITE decision
     * for an approval (someone rejected it there first).
     */
    private async recordDecision(
        userId: string,
        approvalId: string,
        decision: 'approved' | 'rejected',
    ): Promise<boolean> {
        try {
            await this.approvals.decide(userId, approvalId, decision);
            return true;
        } catch (error) {
            if (error instanceof ConflictException) {
                try {
                    const current = await this.approvals.getOne(userId, approvalId);
                    return decision !== 'approved' || current.status !== 'rejected';
                } catch {
                    return true;
                }
            }
            if (error instanceof NotFoundException) return true;
            this.logger.warn(`Approval ${approvalId} could not be decided: ${describe(error)}`);
            return true;
        }
    }

    private async requireOwnedOutbound(userId: string, messageId: string): Promise<EmailMessage> {
        const row = await this.messages.findByIdAndUserId(messageId, userId);
        if (!row || row.direction !== 'outbound') {
            throw new NotFoundException('Message not found');
        }
        return row;
    }
}

function alreadyDecided(row: EmailMessage): ConflictException {
    return new ConflictException({
        statusCode: 409,
        error: 'EmailDraftAlreadyDecided',
        message:
            row.status === 'sent' || row.status === 'sending'
                ? 'This draft was already approved.'
                : `This message is ${row.status ?? 'no longer a draft'} and cannot be decided again.`,
        details: {
            status: row.status ?? null,
            approvedById: row.approvedById ?? null,
            approvedAt: row.approvedAt ? new Date(row.approvedAt).toISOString() : null,
        },
    });
}

function draftTitle(to: readonly string[], subject: string): string {
    const first = to[0] ?? '';
    const more = to.length > 1 ? ` (+${to.length - 1})` : '';
    return `Send email to ${first}${more}: ${subject}`.slice(0, 200);
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
