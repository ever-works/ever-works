import { Injectable, Logger, Optional } from '@nestjs/common';
import { PLUGIN_CAPABILITIES, type FacadeOptions, type IPlugin } from '@ever-works/plugin';
import {
    isEmailOutboundPlugin,
    isEmailInboundPlugin,
    type IEmailOutboundPlugin,
    type IEmailInboundPlugin,
    type EmailSendInput,
    type EmailSendResult,
    type EmailInboundMessage,
    type EmailOptions,
} from '@ever-works/plugin';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginSettingsService } from '../plugins/services/plugin-settings.service';
import { WorkPluginRepository } from '../plugins/repositories/work-plugin.repository';
import { TenantEmailAddressRepository } from '../database/repositories/tenant-email-address.repository';
import { AgentEmailAssignmentRepository } from '../database/repositories/agent-email-assignment.repository';
import { EmailMessageRepository } from '../database/repositories/email-message.repository';
import { PluginUsageService } from '../usage/plugin-usage.service';
import { PluginUsageCapability } from '@src/entities/plugin-usage-event.entity';
import { BaseFacadeService, FacadeError, NoProviderError } from './base.facade';

export class EmailFacadeError extends FacadeError {
    constructor(message: string, operation: string, provider?: string, cause?: Error) {
        super(message, operation, provider, cause);
        this.name = 'EmailFacadeError';
    }
}

/**
 * Optional template handle for outbound email. When provided, the
 * facade renders the React-Email template into `bodyHtml` + `bodyText`
 * before handing off to the provider plugin. See
 * [`docs/specs/features/email-providers/spec.md`](../../../../docs/specs/features/email-providers/spec.md) §11.1.
 */
export interface EmailFacadeTemplate<TProps = unknown> {
    readonly kind: 'react';
    readonly slug: string;
    readonly props: TProps;
}

export interface EmailFacadeSendInput extends Omit<EmailSendInput, 'bodyText' | 'bodyHtml'> {
    /** Either bodyText/bodyHtml directly, or `template` to render on send. */
    readonly bodyText?: string;
    readonly bodyHtml?: string;
    readonly template?: EmailFacadeTemplate;
}

export interface EmailFacadeSendOptions extends FacadeOptions {
    /** Specific tenant_email_addresses.id to send from. Else uses Agent default. */
    readonly addressId?: string;
}

/**
 * EmailFacadeService — single entry point for outbound email + inbound
 * webhook dispatch in the agent / api layers. Mirrors `AiFacadeService`
 * shape but for the EMAIL_OUTBOUND / EMAIL_INBOUND plugin capabilities.
 *
 * See [`docs/specs/features/email-providers/spec.md`](../../../../docs/specs/features/email-providers/spec.md) §3.4.
 *
 * Resolution priority for outbound send:
 * 1. Explicit `addressId` in EmailFacadeSendOptions.
 * 2. Agent's primary (lowest-priority) outbound assignment.
 * 3. First-enabled email-outbound provider for the user.
 *
 * Per-send side effects:
 * - Persists an `email_messages` row tagged with `agentId` + `taskId`.
 * - Emits a `PluginUsageEvent` with `capability='email'` for the spend rollup.
 */
@Injectable()
export class EmailFacadeService extends BaseFacadeService {
    protected readonly logger = new Logger(EmailFacadeService.name);
    protected readonly CAPABILITY = PLUGIN_CAPABILITIES.EMAIL_OUTBOUND;

    constructor(
        registry: PluginRegistryService,
        settingsService: PluginSettingsService,
        @Optional() workPluginRepository?: WorkPluginRepository,
        @Optional() private readonly emailAddresses?: TenantEmailAddressRepository,
        @Optional() private readonly agentAssignments?: AgentEmailAssignmentRepository,
        @Optional() private readonly emailMessages?: EmailMessageRepository,
        @Optional() private readonly pluginUsageService?: PluginUsageService,
    ) {
        super(registry, settingsService, workPluginRepository);
    }

    /**
     * Send an outbound email through the resolved provider plugin.
     *
     * Persists an `email_messages` row + emits `PluginUsageEvent`.
     */
    async send(
        input: EmailFacadeSendInput,
        options: EmailFacadeSendOptions,
    ): Promise<EmailSendResult> {
        const plugin = await this.resolveOutboundPlugin(options);
        const settings = await this.resolveSettings(plugin.id, options);

        const { bodyText, bodyHtml } = await this.renderBody(input);

        const wireInput: EmailSendInput = {
            from: input.from,
            fromName: input.fromName,
            to: input.to,
            cc: input.cc,
            bcc: input.bcc,
            subject: input.subject,
            bodyText,
            bodyHtml,
            replyTo: input.replyTo,
            attachments: input.attachments,
            metadata: input.metadata,
            messageRef: input.messageRef,
        };

        const emailOpts: EmailOptions = {
            userId: options.userId,
            workId: options.workId,
            agentId: options.agentId,
            taskId: options.taskId,
            settings,
        };

        const result = await plugin.sendEmail(wireInput, emailOpts);

        await this.persistOutboundMessage(input, wireInput, result, options);
        await this.recordUsage(plugin.id, 'sendEmail', options);

        return result;
    }

    /**
     * Trigger a verification email for a tenant-managed address.
     */
    async verifyAddress(
        address: string,
        options: EmailFacadeSendOptions,
    ): Promise<{ verificationToken: string; providerMessageId?: string }> {
        const plugin = await this.resolveOutboundPlugin(options);
        const settings = await this.resolveSettings(plugin.id, options);
        const verification = await plugin.verifyAddress(address, {
            userId: options.userId,
            workId: options.workId,
            agentId: options.agentId,
            taskId: options.taskId,
            settings,
        });
        return {
            verificationToken: verification.verificationToken,
            providerMessageId: verification.providerMessageId,
        };
    }

    /**
     * Dispatch an inbound webhook payload to the matching email-inbound
     * plugin. Called from `apps/api/src/email/email.controller.ts`.
     */
    async parseInbound(
        pluginId: string,
        rawBody: Buffer,
        headers: Readonly<Record<string, string>>,
        options?: FacadeOptions,
    ): Promise<EmailInboundMessage> {
        const plugin = this.getInboundPluginById(pluginId);

        // EW-670 follow-up — resolve the recipient address's OWNER before
        // verifying the signature. The inbound webhook controller can't
        // know the owning user up front (the recipient lives in the
        // payload), so without this the secret resolves at admin/env
        // scope only and a per-user `inboundWebhookSecret` is never
        // loaded — meaning a Postmark/Mailgun `if (!expected) return`
        // accept-all path silently skips verification for user-scoped
        // secrets. Map recipient → owning tenant address → userId, then
        // resolve settings (and therefore the secret) at that scope.
        // Best-effort and additive: when the caller already supplies a
        // userId, the plugin omits `extractInboundRecipients`, or no
        // owner matches, this falls back to the previous behaviour.
        const scope = await this.resolveInboundScope(plugin, rawBody, headers, options);

        const settings = await this.resolveSettings(pluginId, scope);
        const emailOpts: EmailOptions = {
            userId: scope.userId,
            workId: scope.workId,
            agentId: scope.agentId,
            taskId: scope.taskId,
            settings,
        };
        plugin.verifyWebhookSignature(rawBody, headers, emailOpts);
        return plugin.parseInboundWebhook(rawBody, headers, emailOpts);
    }

    /**
     * Best-effort: widen the inbound FacadeOptions with the owning user
     * resolved from the payload's recipient address, so signature
     * verification reads the owner's per-user secret. Never throws —
     * returns the original options on any failure.
     */
    private async resolveInboundScope(
        plugin: IEmailInboundPlugin,
        rawBody: Buffer,
        headers: Readonly<Record<string, string>>,
        options?: FacadeOptions,
    ): Promise<FacadeOptions> {
        const base: FacadeOptions = { ...options };
        if (base.userId || !plugin.extractInboundRecipients || !this.emailAddresses) {
            return base;
        }
        try {
            const recipients = plugin.extractInboundRecipients(rawBody, headers);
            for (const recipient of recipients) {
                if (!recipient) continue;
                const owner = await this.emailAddresses.findByAddress(recipient);
                // Only adopt the resolved owner when the matched address is
                // registered to THIS plugin — a mailbox can be registered by
                // multiple tenants/providers, so an address-only match could
                // otherwise attribute the verification scope to the wrong
                // owner (Codex/Greptile on PR #1115). When it doesn't match we
                // fall back to the base (admin/env) scope below.
                //
                // Note: widening the scope to the owner's userId never
                // *weakens* verification — `getSettings({ userId })` resolves
                // the admin→user hierarchy, so an admin-level
                // `inboundWebhookSecret` is still present (and enforced) at
                // owner scope; the user's own secret only layers on top.
                if (owner?.userId && owner.pluginId === plugin.id) {
                    return { ...base, userId: owner.userId };
                }
            }
        } catch (err) {
            this.logger.warn(
                `parseInbound: recipient-owner resolution failed, falling back to default scope — ${
                    (err as Error).message
                }`,
            );
        }
        return base;
    }

    /**
     * Resolve the outbound plugin to use for this call. Order:
     * 1. addressId override → the address's pluginId.
     * 2. Agent default assignment → that assignment's pluginId.
     * 3. First enabled email-outbound plugin for the user.
     */
    private async resolveOutboundPlugin(
        options: EmailFacadeSendOptions,
    ): Promise<IEmailOutboundPlugin> {
        if (options.addressId && this.emailAddresses) {
            const address = await this.emailAddresses.findById(options.addressId);
            if (address?.pluginId) {
                const plugin = this.getOutboundPluginByIdSafe(address.pluginId);
                if (plugin) return plugin;
            }
        }
        if (options.agentId && this.agentAssignments && this.emailAddresses) {
            // findByAgent returns assignments ordered by priority asc;
            // resolve each to its backing address to read the pluginId.
            const assignments = await this.agentAssignments.findByAgent(
                options.agentId,
                'outbound',
            );
            for (const assignment of assignments) {
                const address = await this.emailAddresses.findById(assignment.emailAddressId);
                if (address?.pluginId) {
                    const plugin = this.getOutboundPluginByIdSafe(address.pluginId);
                    if (plugin) return plugin;
                }
            }
        }
        const fallback = this.registry
            .getByCapability(this.CAPABILITY)
            .find((p) => p.state === 'loaded');
        if (!fallback || !isEmailOutboundPlugin(fallback.plugin)) {
            throw new NoProviderError(this.CAPABILITY);
        }
        return fallback.plugin;
    }

    private getOutboundPluginByIdSafe(pluginId: string): IEmailOutboundPlugin | undefined {
        const registered = this.registry
            .getByCapability(this.CAPABILITY)
            .find((p) => p.plugin.id === pluginId && p.state === 'loaded');
        if (!registered) return undefined;
        return isEmailOutboundPlugin(registered.plugin) ? registered.plugin : undefined;
    }

    private getInboundPluginById(pluginId: string): IEmailInboundPlugin {
        const registered = this.registry
            .getByCapability(PLUGIN_CAPABILITIES.EMAIL_INBOUND)
            .find((p) => p.plugin.id === pluginId && p.state === 'loaded');
        if (!registered || !isEmailInboundPlugin(registered.plugin)) {
            throw new EmailFacadeError(
                `Inbound email plugin not found or disabled: ${pluginId}`,
                'parseInbound',
                pluginId,
            );
        }
        return registered.plugin;
    }

    private async resolveSettings(
        pluginId: string,
        options?: Pick<FacadeOptions, 'userId' | 'workId'>,
    ): Promise<Record<string, unknown> | undefined> {
        if (!this.settingsService) return undefined;
        return this.settingsService.getSettings(pluginId, {
            userId: options?.userId,
            workId: options?.workId,
            includeSecrets: true,
        });
    }

    /**
     * Render React-Email template (server-side) into HTML + text fallback.
     * When `template` is not provided, returns the caller-supplied bodies
     * directly. Wire-level rendering lives in `apps/api/src/email/templates/render.ts`
     * (added in T16); this method delegates so the agent package stays
     * free of React peer-deps.
     */
    private async renderBody(
        input: EmailFacadeSendInput,
    ): Promise<{ bodyText: string; bodyHtml?: string }> {
        if (!input.template) {
            return {
                bodyText: input.bodyText ?? '',
                bodyHtml: input.bodyHtml,
            };
        }
        // TODO(EW-668 / T16): wire @react-email/render via a dynamic import
        // helper in the api layer so the agent package doesn't take a hard
        // React dep. For now, defer to caller-supplied bodies if provided.
        return {
            bodyText: input.bodyText ?? `[React-Email template: ${input.template.slug}]`,
            bodyHtml: input.bodyHtml,
        };
    }

    private async persistOutboundMessage(
        input: EmailFacadeSendInput,
        wire: EmailSendInput,
        result: EmailSendResult,
        options: EmailFacadeSendOptions,
    ): Promise<void> {
        if (!this.emailMessages || !options.userId || !options.addressId) return;
        await this.emailMessages.save({
            userId: options.userId,
            agentId: options.agentId ?? null,
            taskId: options.taskId ?? null,
            conversationId: null,
            emailAddressId: options.addressId,
            direction: 'outbound',
            pluginId: result.provider,
            providerMessageId: result.providerMessageId,
            from: wire.from,
            toAddresses: [...wire.to],
            ccAddresses: wire.cc ? [...wire.cc] : null,
            bccAddresses: wire.bcc ? [...wire.bcc] : null,
            subject: wire.subject,
            bodyText: wire.bodyText,
            bodyHtml: wire.bodyHtml ?? null,
            metadata: input.metadata ? { ...input.metadata } : null,
            messageRef: input.messageRef ?? null,
            sentAt: new Date(),
            deliveryStatus: 'accepted',
        } as Parameters<typeof this.emailMessages.save>[0]);
    }

    private async recordUsage(
        pluginId: string,
        operation: string,
        options: EmailFacadeSendOptions,
    ): Promise<void> {
        if (!this.pluginUsageService || !options.userId) return;
        try {
            await this.pluginUsageService.record({
                userId: options.userId,
                workId: options.workId,
                agentId: options.agentId,
                taskId: options.taskId,
                pluginId,
                capability: PluginUsageCapability.EMAIL,
                units: 1,
                costCents: 0,
                metadata: { operation },
            });
        } catch (err) {
            this.logger.warn(`PluginUsageEvent emission failed for ${pluginId}: ${String(err)}`);
        }
    }
}
