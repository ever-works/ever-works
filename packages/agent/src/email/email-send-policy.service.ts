import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import {
    EMAIL_DAY_WINDOW_MS,
    EMAIL_INBOX_BURST_WINDOW_MS,
    EMAIL_INBOX_RECIPIENT_WINDOW_MS,
    EMAIL_MONTH_WINDOW_MS,
    EMAIL_SEND_CAP_LIMIT_KINDS,
    EMAIL_SEND_CAP_WINDOWS,
    AGENT_INBOX_MODES,
    computeEmailCapRetryAfterSeconds,
    distinctEmailRecipients,
    evaluateEmailSendCaps,
    normalizeEmailSendCapsOverride,
    resolveEmailSendCaps,
    type AgentInboxMode,
    type EmailCapMeterDto,
    type EmailSendCapField,
    type EmailSendCapSource,
    type EmailSendPolicyOverride,
    type EmailSendWindowUsage,
    type ResolvedEmailSendCaps,
} from '@ever-works/contracts';
import { config } from '../config';
import { Agent } from '../entities/agent.entity';
import { AgentActionProposal } from '../entities/agent-action-proposal.entity';
import type { AgentInbox } from '../entities/agent-inbox.entity';
import { Organization } from '../entities/organization.entity';
import { AgentInboxRepository } from '../database/repositories/agent-inbox.repository';
import {
    EmailMessageRepository,
    type EmailSendWindowFilter,
} from '../database/repositories/email-message.repository';
import { EmailApprovalRequiredException } from './email-approval-required.exception';
import { EmailSendCapExceededException } from './email-send-cap-exceeded.exception';
import type { EmailSendAttempt, EmailSendPolicyGate } from './email-send-policy.port';

/** The effective policy for one send: who decided the mode and every ceiling. */
export interface EffectiveEmailSendPolicy {
    enforced: boolean;
    mode: AgentInboxMode;
    modeSource: EmailSendCapSource;
    caps: ResolvedEmailSendCaps;
    sources: Record<EmailSendCapField, EmailSendCapSource>;
    inbox: AgentInbox | null;
    organizationId: string | null;
}

/**
 * Agent email (AW-05) — the approve-before-send gate and the send ceilings,
 * enforced where every send converges (`EmailFacadeService.send`).
 *
 * # What it decides, in order
 *
 * 1. **Approval.** A send an Agent originates is refused unless the Agent's
 *    effective mode is `auto-send`, or it is the release of a draft a person
 *    approved — read back from the message row (`status = 'sending'`,
 *    `approvedById` set, same Agent, same recipients and subject) and, when
 *    the draft is mirrored in the approvals queue, from that proposal's
 *    recorded decision. A flag passed by a caller is never trusted.
 * 2. **Ceilings.** Per message, per inbox (60 s, 5 min, 24 h) and per account
 *    (24 h, 30 d), rolling windows counted from `email_messages`. A person
 *    composing is subject to every one of them — there is no privileged
 *    bypass.
 *
 * # Where the numbers come from
 *
 * Platform defaults (operator env) < organization policy < the Agent's inbox
 * row, resolved by the pure `resolveEmailSendCaps`. `0` at any scope means
 * explicitly unrestricted, and `EMAIL_SEND_CAPS_ENFORCEMENT=off` restores the
 * pre-ceiling behaviour for a whole deployment. Counts are never read from
 * anything a model can write.
 *
 * # What "workspace" counts
 *
 * The owning account (`userId`) — the same ownership boundary the email
 * addresses, assignments and messages are scoped by. Organization policy is
 * found through the Agent's `organizationId`.
 */
@Injectable()
export class EmailSendPolicyService implements EmailSendPolicyGate {
    private readonly logger = new Logger(EmailSendPolicyService.name);

    constructor(
        private readonly inboxes: AgentInboxRepository,
        private readonly messages: EmailMessageRepository,
        @InjectRepository(Agent) private readonly agents: Repository<Agent>,
        @InjectRepository(Organization) private readonly organizations: Repository<Organization>,
        @InjectRepository(AgentActionProposal)
        private readonly proposals: Repository<AgentActionProposal>,
    ) {}

    /** Overridable clock — tests freeze it. */
    protected now(): Date {
        return new Date();
    }

    async assertSendAllowed(attempt: EmailSendAttempt): Promise<void> {
        const userId = attempt.userId;
        if (!userId) {
            // Unattributed platform mail: there is no owner to count against
            // and no Agent to gate. Unchanged from before the gate existed.
            return;
        }
        const agentId = attempt.agentId;
        const policy = await this.resolvePolicy(userId, agentId);

        if (attempt.origin === 'agent' && agentId) {
            if (attempt.draftMessageId) {
                await this.assertApprovedDraft(userId, agentId, attempt);
            } else if (policy.mode === 'draft-review') {
                throw new EmailApprovalRequiredException('awaiting-approval', agentId);
            }
        }

        if (!policy.enforced) return;

        const recipients = distinctEmailRecipients(attempt.to, attempt.cc, attempt.bcc);
        const now = this.now();
        const usage = await this.readUsage(userId, agentId, now);
        const refusal = evaluateEmailSendCaps(policy.caps, usage, recipients);
        if (!refusal) return;

        const retryAfterSeconds = await this.retryAfterSeconds(
            refusal.limitKind,
            refusal.cap,
            userId,
            agentId,
            now,
        );
        if (refusal.limitKind === 'inboxDaily' && policy.inbox && retryAfterSeconds > 0) {
            try {
                await this.inboxes.setCapPausedUntil(
                    policy.inbox.id,
                    new Date(now.getTime() + retryAfterSeconds * 1000),
                );
            } catch (error) {
                this.logger.warn(
                    `Could not record the cap pause for inbox ${policy.inbox.id}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
        throw new EmailSendCapExceededException({
            scope: refusal.scope,
            limitKind: refusal.limitKind,
            used: refusal.used,
            cap: refusal.cap,
            windowSeconds: Math.round(refusal.windowMs / 1000),
            retryAfterSeconds,
            ...(agentId ? { agentId } : {}),
        });
    }

    /**
     * The policy in force for an owner (and, optionally, one of their
     * Agents). An Agent id that does not belong to `userId` resolves as if
     * no Agent was named — nothing about a foreign Agent is ever read.
     */
    async resolvePolicy(userId: string, agentId?: string): Promise<EffectiveEmailSendPolicy> {
        const agent = agentId
            ? await this.agents.findOne({
                  where: { id: agentId, userId },
                  select: { id: true, userId: true, organizationId: true },
              })
            : null;
        const inbox = agent ? await this.inboxes.findByAgentForUser(agent.id, userId) : null;
        const organizationId = agent?.organizationId ?? null;
        const orgPolicy = organizationId ? await this.readOrganizationPolicy(organizationId) : null;

        const { caps, sources } = resolveEmailSendCaps({
            platform: config.email.sendCaps.getPlatformCaps(),
            organization: orgPolicy?.caps ?? null,
            inbox: inbox ? inboxCapsOverride(inbox) : null,
        });

        let mode: AgentInboxMode = config.email.getDefaultAgentMode();
        let modeSource: EmailSendCapSource = 'platform';
        if (orgPolicy?.defaultMode) {
            mode = orgPolicy.defaultMode;
            modeSource = 'organization';
        }
        if (inbox && AGENT_INBOX_MODES.includes(inbox.mode)) {
            mode = inbox.mode;
            modeSource = 'inbox';
        }

        return {
            enforced: config.email.sendCaps.isEnforced(),
            mode,
            modeSource,
            caps,
            sources,
            inbox,
            organizationId,
        };
    }

    /** A live reading of every ceiling for one of the owner's Agents. */
    async getMeter(userId: string, agentId: string): Promise<EmailCapMeterDto> {
        const policy = await this.resolvePolicy(userId, agentId);
        const now = this.now();
        const usage = await this.readUsage(userId, agentId, now);
        const recentRecipients = distinctEmailRecipients(usage.inboxRecentRecipients).length;
        const used: Record<(typeof EMAIL_SEND_CAP_LIMIT_KINDS)[number], number> = {
            recipientsPerMessage: 0,
            inboxBurst: usage.inboxBurstSends,
            inboxRecipients: recentRecipients,
            inboxDaily: usage.inboxDailySends,
            workspaceDaily: usage.workspaceDailySends,
            workspaceMonthly: usage.workspaceMonthlySends,
        };
        const pausedUntil =
            policy.inbox?.capPausedUntil && policy.inbox.capPausedUntil.getTime() > now.getTime()
                ? policy.inbox.capPausedUntil.toISOString()
                : null;
        return {
            agentId,
            enforced: policy.enforced,
            mode: policy.mode,
            modeSource: policy.modeSource,
            windows: EMAIL_SEND_CAP_LIMIT_KINDS.map((kind) => {
                const window = EMAIL_SEND_CAP_WINDOWS[kind];
                return {
                    kind,
                    scope: window.scope,
                    used: used[kind],
                    cap: policy.enforced ? policy.caps[window.field] : null,
                    windowSeconds: Math.round(window.windowMs / 1000),
                    source: policy.sources[window.field],
                };
            }),
            pausedUntil,
        };
    }

    async readOrganizationPolicy(organizationId: string): Promise<EmailSendPolicyOverride | null> {
        const org = await this.organizations.findOne({
            where: { id: organizationId },
            select: { id: true, emailSendPolicy: true },
        });
        return normalizeOrganizationPolicy(org?.emailSendPolicy ?? null);
    }

    /**
     * Replace the organization's policy with the merge of the stored one and
     * `patch` (field by field; `null` clears a field back to inherit). The
     * CALLER authorizes — this is reached only after an organization admin
     * check at the API edge.
     */
    async updateOrganizationPolicy(
        organizationId: string,
        patch: EmailSendPolicyOverride,
    ): Promise<EmailSendPolicyOverride | null> {
        const current = (await this.readOrganizationPolicy(organizationId)) ?? {};
        const next: EmailSendPolicyOverride = { ...current };
        if (patch.defaultMode !== undefined) {
            next.defaultMode = patch.defaultMode ?? null;
        }
        if (patch.caps !== undefined) {
            const caps = { ...(current.caps ?? {}) } as Record<string, number | null>;
            for (const [field, value] of Object.entries(patch.caps ?? {})) {
                caps[field] = value ?? null;
            }
            next.caps = caps;
        }
        const stored = normalizeOrganizationPolicy(next);
        await this.organizations.update({ id: organizationId }, { emailSendPolicy: stored });
        return stored;
    }

    private async assertApprovedDraft(
        userId: string,
        agentId: string,
        attempt: EmailSendAttempt,
    ): Promise<void> {
        const draftId = attempt.draftMessageId as string;
        const draft = await this.messages.findByIdAndUserId(draftId, userId);
        const refuse = () => new EmailApprovalRequiredException('draft-not-approved', agentId);
        if (
            !draft ||
            draft.direction !== 'outbound' ||
            draft.agentId !== agentId ||
            draft.status !== 'sending' ||
            !draft.approvedById
        ) {
            throw refuse();
        }
        // The released message must be the one that was approved — a caller
        // cannot borrow an approval for different recipients or a new subject.
        const approvedRecipients = distinctEmailRecipients(
            draft.toAddresses,
            draft.ccAddresses,
            draft.bccAddresses,
        ).sort();
        const sendingRecipients = distinctEmailRecipients(
            attempt.to,
            attempt.cc,
            attempt.bcc,
        ).sort();
        if (
            draft.subject !== attempt.subject ||
            approvedRecipients.join('\n') !== sendingRecipients.join('\n')
        ) {
            throw refuse();
        }
        if (draft.approvalId) {
            const proposal = await this.proposals.findOne({
                where: { id: draft.approvalId, userId },
                select: { id: true, status: true },
            });
            if (!proposal || proposal.status !== 'approved') {
                throw refuse();
            }
        }
    }

    private async readUsage(
        userId: string,
        agentId: string | undefined,
        now: Date,
    ): Promise<EmailSendWindowUsage> {
        const since = (windowMs: number) => new Date(now.getTime() - windowMs);
        const workspace: EmailSendWindowFilter = { userId };
        const [workspaceDailySends, workspaceMonthlySends] = await Promise.all([
            this.messages.countOutboundSentSince(workspace, since(EMAIL_DAY_WINDOW_MS)),
            this.messages.countOutboundSentSince(workspace, since(EMAIL_MONTH_WINDOW_MS)),
        ]);
        if (!agentId) {
            return {
                hasInbox: false,
                inboxBurstSends: 0,
                inboxDailySends: 0,
                inboxRecentRecipients: [],
                workspaceDailySends,
                workspaceMonthlySends,
            };
        }
        const inbox: EmailSendWindowFilter = { agentId };
        const [inboxBurstSends, inboxDailySends, inboxRecentRecipients] = await Promise.all([
            this.messages.countOutboundSentSince(inbox, since(EMAIL_INBOX_BURST_WINDOW_MS)),
            this.messages.countOutboundSentSince(inbox, since(EMAIL_DAY_WINDOW_MS)),
            this.messages.listOutboundRecipientsSince(
                agentId,
                since(EMAIL_INBOX_RECIPIENT_WINDOW_MS),
            ),
        ]);
        return {
            hasInbox: true,
            inboxBurstSends,
            inboxDailySends,
            inboxRecentRecipients,
            workspaceDailySends,
            workspaceMonthlySends,
        };
    }

    private async retryAfterSeconds(
        kind: (typeof EMAIL_SEND_CAP_LIMIT_KINDS)[number],
        cap: number,
        userId: string,
        agentId: string | undefined,
        now: Date,
    ): Promise<number> {
        const window = EMAIL_SEND_CAP_WINDOWS[kind];
        if (window.windowMs <= 0) return 0;
        const filter: EmailSendWindowFilter =
            window.scope === 'workspace' || !agentId ? { userId } : { agentId };
        try {
            const sentAt = await this.messages.listOutboundSentAtSince(
                filter,
                new Date(now.getTime() - window.windowMs),
            );
            return computeEmailCapRetryAfterSeconds(
                sentAt.map((value) => value.getTime()),
                cap,
                window.windowMs,
                now.getTime(),
            );
        } catch {
            // The refusal stands either way; only the "when" is unknown.
            return Math.round(window.windowMs / 1000);
        }
    }
}

function inboxCapsOverride(inbox: AgentInbox) {
    return {
        inboxDailySends: inbox.dailySendCap ?? null,
        inboxBurstSends: inbox.burstSendCap ?? null,
        inboxBurstRecipients: inbox.recipientBurstCap ?? null,
        recipientsPerMessage: inbox.recipientsPerMessageCap ?? null,
    };
}

/** Well-formed subset of a stored organization policy, or `null` when nothing is set. */
export function normalizeOrganizationPolicy(raw: unknown): EmailSendPolicyOverride | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const source = raw as Record<string, unknown>;
    const out: EmailSendPolicyOverride = {};
    if (
        typeof source.defaultMode === 'string' &&
        AGENT_INBOX_MODES.includes(source.defaultMode as AgentInboxMode)
    ) {
        out.defaultMode = source.defaultMode as AgentInboxMode;
    }
    const caps = normalizeEmailSendCapsOverride(source.caps);
    if (Object.keys(caps).length > 0) out.caps = caps;
    return Object.keys(out).length > 0 ? out : null;
}
