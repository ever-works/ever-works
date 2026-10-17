import {
    BadRequestException,
    HttpException,
    HttpStatus,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
    ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
    ArrayMaxSize,
    IsArray,
    IsBoolean,
    IsEmail,
    IsIn,
    IsObject,
    IsOptional,
    IsString,
    IsUUID,
    MaxLength,
    ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { renderTemplate } from './templates/render';
import {
    TenantEmailAddressRepository,
    AgentEmailAssignmentRepository,
    EmailMessageRepository,
    AgentRepository,
    AgentInboxRepository,
} from '@ever-works/agent/database';
import type { TenantEmailAddress, EmailAddressDirection } from '@ever-works/agent/entities';
import {
    EmailFacadeService,
    EmailSenderNotVerifiedException,
    emailSenderVerificationRequired,
    replyHeadersFor,
} from '@ever-works/agent/facades';
import { MailService } from '../mail/mail.service';
import { EmailDraftService } from '@ever-works/agent/email';
import type { EmailSendOrigin } from '@ever-works/contracts';

/**
 * EW-711 #44 — how long an address-verification token stays valid after
 * issuance. A leaked confirmation link must not verify an address forever.
 */
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * EW-P4-3 — the least time between two confirmation emails for one address.
 * The address is the caller's to type, so without it the route would mail
 * anyone, repeatedly, from the platform.
 */
export const VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;

/** EW-P4-3 — where the confirmation link lands (a public web page, see apps/web). */
export const EMAIL_ADDRESS_VERIFY_PATH = '/email-address/verify';

/** EW-P4-3 — what `POST /api/email/addresses/:id/verify` answers. */
export interface TriggerVerificationResult {
    messageRef: string;
    /** `true` when a confirmation email went out now. */
    sent: boolean;
    /** `true` when the address was already verified (nothing sent). */
    alreadyVerified?: boolean;
    /** When the link just sent stops working (ISO 8601). */
    expiresAt?: string;
}

// Security: these request bodies are bound directly via `@Body()` in
// email.controller.ts. The global ValidationPipe (main.ts) runs with
// `whitelist + forbidNonWhitelisted + transform`, but it only enforces
// constraints on classes carrying class-validator metadata — a plain
// `interface` type is treated as having no whitelist, so every field
// (recipients, subject, raw HTML body, template slug/props) was passed
// through unvalidated. Declaring these as decorated classes makes the
// pipe strip unknown properties and reject malformed/oversized input
// from authenticated callers while leaving legitimate payloads intact.

export class CreateEmailAddressInput {
    @IsEmail()
    @MaxLength(320)
    readonly address!: string;

    @IsIn(['outbound', 'inbound', 'both'])
    readonly direction!: EmailAddressDirection;

    @IsString()
    @MaxLength(128)
    readonly pluginId!: string;

    @IsObject()
    readonly providerSettings!: Record<string, unknown>;

    @IsOptional()
    @IsBoolean()
    readonly defaultForReplies?: boolean;
}

export class UpdateEmailAddressInput {
    @IsOptional()
    @IsObject()
    readonly providerSettings?: Record<string, unknown>;

    @IsOptional()
    @IsBoolean()
    readonly defaultForReplies?: boolean;

    @IsOptional()
    @IsBoolean()
    readonly disabled?: boolean;
}

/** A React-Email template handle (rendered server-side via @ever-works/email-templates). */
export class EmailTemplateRef {
    @IsString()
    @MaxLength(128)
    readonly slug!: string;

    // Per-template props vary (discriminated by slug) and are consumed by
    // the React-Email renderer; validate the container without recursing
    // so legitimate template props are preserved verbatim.
    @IsObject()
    readonly props!: Record<string, unknown>;
}

export class SendMessageInput {
    @IsString()
    @MaxLength(256)
    readonly agentId!: string;

    @IsArray()
    @ArrayMaxSize(100)
    @IsEmail({}, { each: true })
    readonly to!: string[];

    @IsString()
    @MaxLength(998)
    readonly subject!: string;

    /** Plain-text body. Optional when `template` is supplied (rendered then). */
    @IsOptional()
    @IsString()
    @MaxLength(1_000_000)
    readonly bodyText?: string;

    @IsOptional()
    @IsArray()
    @ArrayMaxSize(100)
    @IsEmail({}, { each: true })
    readonly cc?: string[];

    @IsOptional()
    @IsString()
    @MaxLength(2_000_000)
    readonly bodyHtml?: string;

    /** Render a registered React-Email template into bodyHtml + text on send. */
    @IsOptional()
    @ValidateNested()
    @Type(() => EmailTemplateRef)
    readonly template?: EmailTemplateRef;

    /** Specific tenant address to send from; defaults to the agent's primary outbound. */
    @IsOptional()
    @IsString()
    @MaxLength(256)
    readonly fromAddressId?: string;

    /**
     * EW-P4-3 — reply in thread: the `email_messages.id` (one of the caller's
     * own messages) this message answers. Sets `In-Reply-To` / `References`
     * from it, so the recipient's mail client threads the reply.
     */
    @IsOptional()
    @IsUUID()
    readonly inReplyToMessageId?: string;
}

/**
 * AW-05 — how a send was asked for. SERVER-SET by the caller (the compose
 * route, the Agent tool adapter) and never part of the request body: an
 * `agent` send is subject to the Agent's approve-before-send mode.
 */
export interface SendMessageOptions {
    /** Default `human` — a person composing from the product. */
    readonly origin?: EmailSendOrigin;
    /** The Run that wrote the message, recorded on a held draft's approval. */
    readonly runId?: string;
}

export interface SendMessageResult {
    messageRef: string;
    provider?: string;
    providerMessageId: string;
    accepted: readonly string[];
    rejected: readonly { address: string; reason: string }[];
    /** AW-05 — `true` when the message was held as a draft for a person to approve. */
    held?: boolean;
    /** AW-05 — the held draft's `email_messages.id`. */
    messageId?: string;
    /** AW-05 — the held draft's mirrored approval, when the approvals queue was reachable. */
    approvalId?: string | null;
}

/**
 * EW-650 / EW-669 — Tenant email address CRUD + verification flow.
 * Per-user scoping enforced on every read/write.
 */
@Injectable()
export class EmailService {
    constructor(
        private readonly addresses: TenantEmailAddressRepository,
        private readonly assignments: AgentEmailAssignmentRepository,
        private readonly messages: EmailMessageRepository,
        private readonly emailFacade: EmailFacadeService,
        private readonly agents: AgentRepository,
        // AW-05 — the approve-before-send loop for Agent-originated mail.
        // @Optional() and appended LAST: absent, an Agent send still goes
        // through the facade's send-policy gate, which refuses a held
        // Agent's direct send rather than letting it out.
        @Optional() private readonly drafts?: EmailDraftService,
        // AW-05 — the Agent's inbox settings, read for the pinned sending
        // address. @Optional() and appended LAST: absent, the sending address
        // resolves exactly as before (explicit, then primary assignment).
        @Optional() private readonly inboxes?: AgentInboxRepository,
        // EW-P4-3 — platform mail delivers the address confirmation link.
        // @Optional() and appended LAST: absent, triggering a verification
        // answers 503 instead of pretending to send one.
        @Optional() private readonly mail?: MailService,
    ) {}

    private readonly logger = new Logger(EmailService.name);

    async listAddresses(
        userId: string,
        direction?: EmailAddressDirection,
        options: { includeDisabled?: boolean } = {},
    ): Promise<TenantEmailAddress[]> {
        // EW-P4-3 — the settings page lists disabled addresses too, so they
        // can be enabled again; every other caller keeps active ones only.
        if (options.includeDisabled) {
            return this.addresses.findAllByUser(userId, direction);
        }
        return this.addresses.findActiveByUser(userId, direction);
    }

    async createAddress(
        userId: string,
        input: CreateEmailAddressInput,
    ): Promise<TenantEmailAddress> {
        const verificationToken = randomBytes(24).toString('base64url');
        return this.addresses.save({
            userId,
            address: input.address,
            direction: input.direction,
            pluginId: input.pluginId,
            providerSettings: input.providerSettings,
            defaultForReplies: input.defaultForReplies ?? false,
            verified: false,
            verificationToken,
            // EW-711 #44: time-box the verification token so a leaked
            // confirmation link cannot verify the address indefinitely.
            verificationTokenExpiresAt: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS),
        } as TenantEmailAddress);
    }

    async updateAddress(
        userId: string,
        id: string,
        input: UpdateEmailAddressInput,
    ): Promise<TenantEmailAddress> {
        await this.findOwnedOrThrow(userId, id);
        const patch: Partial<TenantEmailAddress> = {};
        if (input.providerSettings) patch.providerSettings = input.providerSettings;
        if (typeof input.defaultForReplies === 'boolean')
            patch.defaultForReplies = input.defaultForReplies;
        if (typeof input.disabled === 'boolean')
            patch.disabledAt = input.disabled ? new Date() : null;
        await this.addresses.update(id, patch);
        return this.findOwnedOrThrow(userId, id);
    }

    async deleteAddress(userId: string, id: string): Promise<void> {
        await this.findOwnedOrThrow(userId, id);
        await this.addresses.delete(id, userId);
    }

    /**
     * EW-P4-3 — send the address a confirmation email. A fresh one-time token
     * (24 h) replaces any earlier one on the row and goes out in a link to the
     * public `/email-address/verify/<token>` page, which confirms it through
     * `GET /api/email/verify/:token` — proving whoever registered the address
     * can read its mail. Until then nothing can be SENT from it.
     *
     * Before EW-P4-3 this only asked the provider plugin for a token and threw
     * it away: no email went out, and `verified` was never checked anywhere.
     *
     * - Already verified: nothing is sent (`alreadyVerified: true`).
     * - Disabled: 400. Within a minute of the last link: 429.
     * - No platform mail wired: 503 (never a silent "sent").
     * The provider plugin's own `verifyAddress` still runs, best-effort, so a
     * provider that registers sender signatures keeps doing so.
     */
    async triggerVerification(userId: string, id: string): Promise<TriggerVerificationResult> {
        const row = await this.findOwnedOrThrow(userId, id);
        const messageRef = `verify-${row.id}-${Date.now()}`;
        if (row.verified) {
            return { messageRef, sent: false, alreadyVerified: true };
        }
        if (row.disabledAt) {
            throw new BadRequestException('This address is disabled. Enable it first.');
        }
        // Never a silent "sent": with no mail module, or a mailer that only
        // logs (MAILER_PROVIDER unset / `none`, or Resend without a key), the
        // link would never arrive.
        if (!this.mail || !this.mail.canDeliver()) {
            throw new ServiceUnavailableException(
                'Platform email is not configured, so the confirmation email cannot be sent.',
            );
        }

        // One email per cooldown, even for concurrent clicks: the send is
        // claimed with a compare-and-set on `verificationSentAt` (NULL = never
        // sent; the token `createAddress` mints is never mailed).
        const sentAt = new Date();
        const claimed = await this.addresses.claimVerificationSend(
            row.id,
            new Date(sentAt.getTime() - VERIFICATION_RESEND_COOLDOWN_MS),
            sentAt,
        );
        if (!claimed) {
            throw new HttpException(
                'A confirmation email was just sent to this address. Wait a minute before sending another.',
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }

        const verificationToken = randomBytes(24).toString('base64url');
        const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);
        await this.addresses.update(row.id, {
            verificationToken,
            verificationTokenExpiresAt: expiresAt,
        });
        try {
            await this.mail.sendNotificationEmail(
                row.address,
                row.address,
                {
                    title: 'Confirm this email address',
                    message:
                        `${row.address} was added as an email address for AI agents on your workspace. ` +
                        'Confirm it to let agents send from it. The link works for 24 hours. ' +
                        'If you did not expect this email, ignore it: nothing will be sent from this address.',
                    eventTitle: 'Email address confirmation',
                    actionUrl: `${EMAIL_ADDRESS_VERIFY_PATH}/${verificationToken}`,
                    actionLabel: 'Confirm this address',
                    settingsPath: '/settings/integrations/emails',
                },
                // A refused email must not read as sent (Resend answers errors
                // without throwing).
                { strict: true },
            );
        } catch (error) {
            // Nothing went out: put the row back exactly as it was — the
            // previous link (token + expiry) keeps working, and the cooldown is
            // given back so the owner can retry at once — and say why instead
            // of "sent".
            await this.addresses
                .update(row.id, {
                    verificationSentAt: row.verificationSentAt ?? null,
                    verificationToken: row.verificationToken ?? null,
                    verificationTokenExpiresAt: row.verificationTokenExpiresAt ?? null,
                })
                .catch(() => undefined);
            this.logger.warn(
                `Confirmation email for address ${row.id} was not sent: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            throw new ServiceUnavailableException(
                'The confirmation email could not be sent. Check the platform email settings and try again.',
            );
        }

        try {
            await this.emailFacade.verifyAddress(row.address, { userId, addressId: row.id });
        } catch (error) {
            this.logger.debug(
                `Provider-side verifyAddress for ${row.id} did not run: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        return { messageRef, sent: true, expiresAt: expiresAt.toISOString() };
    }

    async confirmVerification(token: string): Promise<{ verified: boolean }> {
        const row = await this.addresses.findByVerificationToken(token);
        if (!row) return { verified: false };
        // EW-711 #44: reject expired tokens (24h TTL stamped at issuance).
        // Rows pre-dating the expiry column have NULL and stay confirmable.
        if (row.verificationTokenExpiresAt && row.verificationTokenExpiresAt < new Date()) {
            return { verified: false };
        }
        await this.addresses.update(row.id, {
            verified: true,
            verificationToken: null,
            verificationTokenExpiresAt: null,
        });
        return { verified: true };
    }

    async listMessagesForAgent(
        userId: string,
        agentId: string,
        limit = 50,
        offset = 0,
    ): Promise<unknown[]> {
        return this.messages.findByUser(userId, {
            agentId,
            limit: Math.min(limit, 100),
            offset,
        });
    }

    /**
     * EW-680 / T32 — send an outbound message from one of the agent's
     * outbound addresses. Resolves the from-address (explicit
     * fromAddressId or the agent's primary outbound assignment), then
     * routes through EmailFacadeService.send (which persists the
     * email_messages row + records usage). Generates the idempotency
     * messageRef.
     */
    async sendMessage(
        userId: string,
        input: SendMessageInput,
        options: SendMessageOptions = {},
    ): Promise<SendMessageResult> {
        // EW-711 #16 (IDOR): the caller-supplied agentId is persisted on the
        // email_messages audit row and recorded against usage, so it MUST
        // belong to the calling user. Verify ownership before any address
        // resolution or provider send.
        const agent = await this.agents.findByIdAndUser(input.agentId, userId);
        if (!agent) throw new NotFoundException('Agent not found');

        let address: TenantEmailAddress | null = null;
        if (input.fromAddressId) {
            address = await this.addresses.findByIdForUser(input.fromAddressId, userId);
            if (!address) throw new NotFoundException('From address not found');
        } else {
            // AW-05 — the address pinned on the Agent's inbox settings is the
            // one a person chose for this Agent to send from, so it comes
            // before the primary assignment.
            address = await this.resolvePinnedAddress(userId, input.agentId);
        }
        if (!address && !input.fromAddressId) {
            const assignment = await this.assignments.findPrimaryOutboundForAgent(input.agentId);
            if (assignment) {
                // Codex P1 (PR #1085): scope the resolved address to the caller. Otherwise
                // an authenticated user who knows another user's agentId could send from
                // that user's outbound address.
                address = await this.addresses.findByIdForUser(assignment.emailAddressId, userId);
            }
        }
        if (!address) {
            throw new NotFoundException('Agent has no outbound email address assigned');
        }
        // EW-P4-3 — refuse up front (before a draft is held) when the sending
        // address was never verified; the facade enforces the same rule.
        if (!address.verified && emailSenderVerificationRequired()) {
            throw new EmailSenderNotVerifiedException(address.address);
        }

        // Render a React-Email template (server-side) into HTML + text
        // when supplied; otherwise use the caller-provided bodies.
        let bodyText = input.bodyText ?? '';
        let bodyHtml = input.bodyHtml;
        if (input.template) {
            const rendered = await renderTemplate(input.template.slug, input.template.props);
            bodyText = rendered.text;
            bodyHtml = rendered.html;
        }
        if (!bodyText && !bodyHtml) {
            throw new BadRequestException('Email requires bodyText, bodyHtml, or a template');
        }

        const messageRef = `compose-${input.agentId}-${Date.now()}`;
        const origin: EmailSendOrigin = options.origin ?? 'human';

        // EW-P4-3 — reply in thread. Owner-scoped: a message of another
        // account answers 404, exactly like a missing one.
        let headers: Record<string, string> | undefined;
        let replyTaskId: string | undefined;
        let replyConversationId: string | undefined;
        if (input.inReplyToMessageId) {
            const parent = await this.messages.findByIdAndUserId(input.inReplyToMessageId, userId);
            if (!parent) throw new NotFoundException('Message to reply to not found');
            const replyHeaders = replyHeadersFor(parent);
            headers = Object.keys(replyHeaders).length > 0 ? replyHeaders : undefined;
            // The reply belongs to the same Task, or the same conversation,
            // as the message it answers — so the next reply threads back there.
            replyTaskId = parent.taskId ?? undefined;
            replyConversationId = replyTaskId ? undefined : (parent.conversationId ?? undefined);
        }

        // AW-05 — an Agent's message goes through the draft loop, which
        // either sends it (inbox sends on its own) or holds it for a person.
        if (origin === 'agent' && this.drafts) {
            const outcome = await this.drafts.submit({
                userId,
                agentId: input.agentId,
                emailAddressId: address.id,
                pluginId: address.pluginId,
                from: address.address,
                to: input.to,
                cc: input.cc,
                subject: input.subject,
                bodyText,
                bodyHtml,
                messageRef,
                runId: options.runId,
                taskId: replyTaskId,
                conversationId: replyConversationId,
                headers,
            });
            if (outcome.held === false) {
                return { messageRef, ...outcome.result };
            }
            return {
                messageRef,
                providerMessageId: '',
                accepted: [],
                rejected: [],
                held: true,
                messageId: outcome.messageId,
                approvalId: outcome.approvalId,
            };
        }

        const result = await this.emailFacade.send(
            {
                from: address.address,
                to: input.to,
                cc: input.cc,
                subject: input.subject,
                bodyText,
                bodyHtml,
                messageRef,
                headers,
            },
            {
                userId,
                agentId: input.agentId,
                addressId: address.id,
                origin,
                taskId: replyTaskId,
                conversationId: replyConversationId,
            },
        );
        return { messageRef, ...result };
    }

    /**
     * EW-680 / T31 — fetch a single message, enforcing per-user
     * ownership (the repo's findById isn't user-scoped).
     */
    async getMessage(userId: string, id: string): Promise<unknown> {
        const row = await this.messages.findById(id);
        if (!row || row.userId !== userId) {
            throw new NotFoundException('Message not found');
        }
        return row;
    }

    /**
     * AW-05 — the sending address pinned on the Agent's inbox settings, when
     * it is still usable: owned by the caller, not disabled and able to send.
     * A pin that no longer resolves (the address was deleted — the FK sets
     * the pin to NULL — disabled, or turned receive-only) behaves like no pin,
     * so the Agent keeps sending through its primary assignment exactly as an
     * unpinned Agent does.
     */
    private async resolvePinnedAddress(
        userId: string,
        agentId: string,
    ): Promise<TenantEmailAddress | null> {
        if (!this.inboxes) return null;
        const inbox = await this.inboxes.findByAgentForUser(agentId, userId);
        if (!inbox?.emailAddressId) return null;
        const pinned = await this.addresses.findByIdForUser(inbox.emailAddressId, userId);
        if (!pinned || pinned.disabledAt || pinned.direction === 'inbound') return null;
        return pinned;
    }

    private async findOwnedOrThrow(userId: string, id: string): Promise<TenantEmailAddress> {
        const row = await this.addresses.findByIdForUser(id, userId);
        if (!row) throw new NotFoundException('Email address not found');
        return row;
    }
}
