import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
} from '@ever-works/agent/database';
import type { TenantEmailAddress, EmailAddressDirection } from '@ever-works/agent/entities';
import { EmailFacadeService } from '@ever-works/agent/facades';

/**
 * EW-711 #44 — how long an address-verification token stays valid after
 * issuance. A leaked confirmation link must not verify an address forever.
 */
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

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
    ) {}

    async listAddresses(
        userId: string,
        direction?: EmailAddressDirection,
    ): Promise<TenantEmailAddress[]> {
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
     * Trigger the provider's verification flow. Persists the token on the
     * row so `GET /api/email/verify/:tokenId` can confirm it later.
     */
    async triggerVerification(userId: string, id: string): Promise<{ messageRef: string }> {
        const row = await this.findOwnedOrThrow(userId, id);
        const messageRef = `verify-${row.id}-${Date.now()}`;
        await this.emailFacade.verifyAddress(row.address, { userId, addressId: row.id });
        return { messageRef };
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
    async sendMessage(userId: string, input: SendMessageInput) {
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
        const result = await this.emailFacade.send(
            {
                from: address.address,
                to: input.to,
                cc: input.cc,
                subject: input.subject,
                bodyText,
                bodyHtml,
                messageRef,
            },
            { userId, agentId: input.agentId, addressId: address.id },
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

    private async findOwnedOrThrow(userId: string, id: string): Promise<TenantEmailAddress> {
        const row = await this.addresses.findByIdForUser(id, userId);
        if (!row) throw new NotFoundException('Email address not found');
        return row;
    }
}
