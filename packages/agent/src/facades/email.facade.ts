import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { PLUGIN_CAPABILITIES, type FacadeOptions, type IPlugin } from '@ever-works/plugin';
import {
    isEmailOutboundPlugin,
    isEmailInboundPlugin,
    type IEmailOutboundPlugin,
    type IEmailInboundPlugin,
    type EmailSendInput,
    type EmailSendResult,
    type EmailInboundMessage,
    type EmailDeliveryEvent,
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
import { EMAIL_MAX_FAILURE_REASON_CHARS, type EmailSendOrigin } from '@ever-works/contracts';
// Leaf token file — no runtime graph (see email-send-policy.port.ts).
import {
    EMAIL_SEND_POLICY_GATE,
    type EmailSendAttempt,
    type EmailSendPolicyGate,
    type EmailSendReservation,
} from '../email/email-send-policy.port';
import { BaseFacadeService, FacadeError, NoProviderError } from './base.facade';

/**
 * AW-05 — provisional `pluginId` on a send reservation (the row is written
 * before any provider is resolved). Replaced by the provider that actually
 * sends, or by the address's provider when the send fails first.
 */
export const EMAIL_SEND_RESERVATION_PENDING_PLUGIN_ID = 'pending';

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
    /**
     * AW-05 — who asked for this send. SERVER-SET at the call site, never
     * copied from a request body: `agent` sends are held when the Agent's
     * inbox is in `draft-review`. Absent = `system` (the pre-gate behaviour).
     */
    readonly origin?: EmailSendOrigin;
    /**
     * AW-05 — the persisted draft this send releases. The send path verifies
     * a person approved exactly this message, and the existing row is moved
     * to `sent` instead of a second row being inserted.
     */
    readonly draftMessageId?: string;
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
 *
 * AW-05 — before any provider is resolved, `send()` asks the
 * `EMAIL_SEND_POLICY_GATE` whether the message may go out: an Agent's mail
 * waits for approval when its inbox says so, and every send ceiling is
 * checked. Every outbound path converges here, so no caller can skip it.
 * When a windowed ceiling applies, the gate also RESERVES the capacity (the
 * audit row is written up front as `sending`); `send()` then settles that
 * row — `sent` on success, released (`failed`, no `sentAt`) when nothing
 * went out.
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
        // AW-05 — approve-before-send + send ceilings. @Optional() and
        // appended LAST so bare constructions keep working; bound by
        // EmailSendPolicyModule, which FacadesModule imports.
        @Optional()
        @Inject(EMAIL_SEND_POLICY_GATE)
        private readonly sendPolicy?: EmailSendPolicyGate,
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
        // AW-05 — the gate runs before plugin resolution, so a refused send
        // never touches a provider (or its credentials).
        let reservedMessageId: string | null = null;
        if (this.sendPolicy) {
            const attempt: EmailSendAttempt = {
                userId: options.userId,
                agentId: options.agentId,
                origin: options.origin,
                draftMessageId: options.draftMessageId,
                to: input.to,
                cc: input.cc,
                bcc: input.bcc,
                subject: input.subject,
            };
            if (typeof this.sendPolicy.admitSend === 'function') {
                // Count + reserve atomically when a windowed ceiling applies,
                // so a concurrent burst cannot overshoot a hard stop.
                const admission = await this.sendPolicy.admitSend(
                    attempt,
                    await this.reservationFor(input, options),
                );
                reservedMessageId = admission?.reservedMessageId ?? null;
            } else {
                await this.sendPolicy.assertSendAllowed(attempt);
            }
        }

        let plugin: IEmailOutboundPlugin;
        let resolvedPluginId: string | undefined;
        let wireInput: EmailSendInput;
        let result: EmailSendResult;
        try {
            plugin = await this.resolveOutboundPlugin(options);
            resolvedPluginId = plugin.id;
            const settings = await this.resolveSettings(plugin.id, options);

            const { bodyText, bodyHtml } = await this.renderBody(input);

            wireInput = {
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

            result = await plugin.sendEmail(wireInput, emailOpts);
        } catch (error) {
            // Nothing went out: give the reserved capacity back.
            if (reservedMessageId) {
                await this.releaseReservation(reservedMessageId, options, error, resolvedPluginId);
            }
            throw error;
        }

        await this.persistOutboundMessage(input, wireInput, result, options, reservedMessageId);
        await this.recordUsage(plugin.id, 'sendEmail', options);

        return result;
    }

    /**
     * AW-05 — what the gate should reserve if a windowed ceiling applies.
     * Only offered when this facade will settle it afterwards — the same
     * conditions under which it records a send at all.
     */
    private async reservationFor(
        input: EmailFacadeSendInput,
        options: EmailFacadeSendOptions,
    ): Promise<EmailSendReservation | null> {
        if (!this.emailMessages || !options.userId || !options.addressId) return null;
        if (options.draftMessageId) return { kind: 'draft' };
        // Pure (no provider, no I/O): the same bodies the send renders.
        const { bodyText, bodyHtml } = await this.renderBody(input);
        return {
            kind: 'message',
            row: {
                userId: options.userId,
                agentId: options.agentId ?? null,
                taskId: options.taskId ?? null,
                emailAddressId: options.addressId,
                // Provisional — replaced by the provider that actually sends.
                pluginId: EMAIL_SEND_RESERVATION_PENDING_PLUGIN_ID,
                from: input.from,
                toAddresses: [...input.to],
                ccAddresses: input.cc ? [...input.cc] : null,
                bccAddresses: input.bcc ? [...input.bcc] : null,
                subject: input.subject,
                bodyText,
                bodyHtml: bodyHtml ?? null,
                metadata: input.metadata ? { ...input.metadata } : null,
                messageRef: input.messageRef ?? null,
            },
        };
    }

    /**
     * AW-05 — a reserved send did not go out. Clear `sentAt` so it stops
     * counting against every window (the counts only read sent rows). A
     * direct send's reservation becomes a `failed` row with the reason; a
     * released draft keeps `sending` so its owner (`EmailDraftService`)
     * records the outcome it already knows how to. Never masks the original
     * error.
     */
    private async releaseReservation(
        messageId: string,
        options: EmailFacadeSendOptions,
        error: unknown,
        pluginId?: string,
    ): Promise<void> {
        if (!this.emailMessages) return;
        try {
            if (options.draftMessageId) {
                await this.emailMessages.transitionStatus(messageId, ['sending'], 'sending', {
                    sentAt: null,
                });
                return;
            }
            const reason = (error instanceof Error ? error.message : String(error)).slice(
                0,
                EMAIL_MAX_FAILURE_REASON_CHARS,
            );
            let recordedPluginId = pluginId;
            if (!recordedPluginId && options.addressId && this.emailAddresses) {
                // No provider was resolved: name the address's provider
                // rather than leave the provisional marker on the audit row.
                const address = await this.emailAddresses
                    .findById(options.addressId)
                    .catch(() => null);
                recordedPluginId = address?.pluginId ?? undefined;
            }
            await this.emailMessages.transitionStatus(messageId, ['sending'], 'failed', {
                sentAt: null,
                failureReason: reason,
                ...(recordedPluginId ? { pluginId: recordedPluginId } : {}),
            });
        } catch (releaseError) {
            this.logger.warn(
                `Could not release the send reservation ${messageId}: ${
                    releaseError instanceof Error ? releaseError.message : String(releaseError)
                }`,
            );
        }
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
     * Authenticate and decode an inbound-email webhook for the matching
     * email-inbound plugin. Called from `apps/api/src/email/email.controller.ts`.
     *
     * The route is public: this signature check is its ONLY authentication,
     * so it fails closed. Every plugin method below is called on the plugin's
     * REAL, loaded instance ({@link getUsableInboundPlugin}), never through
     * the registry's lazy proxy, and the verification is awaited
     * ({@link verifyWebhookSignature}). Note that a plugin with NO secret at
     * the resolved scope accepts unsigned webhooks (an operator opt-in in the
     * shipped postmark and mailgun plugins).
     */
    async parseInbound(
        pluginId: string,
        rawBody: Buffer,
        headers: Readonly<Record<string, string>>,
        options?: FacadeOptions,
    ): Promise<EmailInboundMessage> {
        const plugin = await this.getUsableInboundPlugin(pluginId, 'parseInbound');

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
        await this.verifyWebhookSignature(plugin, pluginId, rawBody, headers, emailOpts);
        return plugin.parseInboundWebhook(rawBody, headers, emailOpts);
    }

    /**
     * Verify + decode a provider delivery-event webhook (bounces, opens,
     * clicks, complaints). Verification uses the admin/env-scoped secret
     * (delivery events reference a `providerMessageId`, not a recipient,
     * so per-user owner resolution isn't possible up front). Returns an
     * empty array when the plugin doesn't publish delivery events.
     */
    async parseEventWebhook(
        pluginId: string,
        rawBody: Buffer,
        headers: Readonly<Record<string, string>>,
        options?: FacadeOptions,
    ): Promise<readonly EmailDeliveryEvent[]> {
        // The loaded instance, as for `parseInbound`: its optional
        // `parseEventWebhook` is then truthfully present or absent (the lazy
        // proxy answers a forwarding wrapper for ANY name), and the signature
        // check below is the plugin's real, synchronous one.
        const plugin = await this.getUsableInboundPlugin(pluginId, 'parseEventWebhook');
        if (typeof plugin.parseEventWebhook !== 'function') return [];
        const settings = await this.resolveSettings(pluginId, options);
        const emailOpts: EmailOptions = {
            userId: options?.userId,
            workId: options?.workId,
            agentId: options?.agentId,
            taskId: options?.taskId,
            settings,
        };
        await this.verifyWebhookSignature(plugin, pluginId, rawBody, headers, emailOpts);
        return plugin.parseEventWebhook(rawBody, headers, emailOpts);
    }

    /**
     * Persist delivery-event outcomes onto the matching `email_messages`
     * rows (latest-status-wins). Looks each event up by
     * `(pluginId, providerMessageId)`; unknown ids are skipped (the
     * message may predate audit-row persistence). Returns how many rows
     * were updated. Best-effort per event — one failed update never
     * aborts the batch.
     */
    async recordDeliveryEvents(
        pluginId: string,
        events: readonly EmailDeliveryEvent[],
    ): Promise<number> {
        if (!this.emailMessages || events.length === 0) return 0;
        let updated = 0;
        for (const event of events) {
            try {
                const message = await this.emailMessages.findByProviderMessageId(
                    pluginId,
                    event.providerMessageId,
                );
                if (!message) continue;
                await this.emailMessages.updateDeliveryStatus(message.id, event.type);
                updated += 1;
            } catch (err) {
                this.logger.warn(
                    `recordDeliveryEvents: failed to record ${event.type} for ${event.providerMessageId} — ${
                        (err as Error).message
                    }`,
                );
            }
        }
        return updated;
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
        if (
            base.userId ||
            typeof plugin.extractInboundRecipients !== 'function' ||
            !this.emailAddresses
        ) {
            return base;
        }
        try {
            // `plugin` is the loaded instance, so this sync method answers its
            // array. `Promise.resolve` still tolerates an implementation that
            // returns a Promise, and anything but an array names nobody.
            const extracted: unknown = await Promise.resolve(
                plugin.extractInboundRecipients(rawBody, headers),
            );
            const recipients: readonly unknown[] = Array.isArray(extracted) ? extracted : [];
            for (const recipient of recipients) {
                if (typeof recipient !== 'string' || !recipient) continue;
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

    /**
     * The REAL, loaded instance of the inbound plugin `pluginId`, for a
     * webhook about to be verified with it.
     *
     * The registry holds a disk-discovered plugin (mailgun, postmark) as a
     * lazy proxy, and the proxy answers EVERY non-manifest member with an
     * async forwarding wrapper, cold or loaded. Called through it, a SYNC
     * method answers a Promise: a failing `verifyWebhookSignature` became a
     * discarded rejected Promise (the forged message was parsed and
     * dispatched, and the rejection went unhandled),
     * `extractInboundRecipients` named no owner (so a per-user secret was
     * never resolved), and `parseEventWebhook` was always "present". While
     * the proxy is cold its `settingsSchema` also reads as `{}`, so settings
     * resolved before the load missed every secret. `__materialize()` loads
     * the plugin (import + onLoad, deduped across concurrent callers) and
     * answers the instance itself, whose methods are the plugin's own; it runs
     * before any settings are resolved. A caller that arrives after the import
     * while another request's onLoad is still running gets the instance at
     * once: its signature check is still the plugin's own synchronous one.
     *
     * A plugin that cannot load is refused with a 503, never accepted
     * unverified: its import fails, or its onLoad fails. `callOnLoad` catches
     * an onLoad failure and records `error` on the registry entry while
     * `__materialize()` still resolves, so the entry is checked again after
     * the load (the registry mutates its entries in place).
     */
    private async getUsableInboundPlugin(
        pluginId: string,
        operation: string,
    ): Promise<IEmailInboundPlugin> {
        const registered = this.registry
            .getByCapability(PLUGIN_CAPABILITIES.EMAIL_INBOUND)
            .find((p) => p.plugin.id === pluginId && p.state === 'loaded');
        if (!registered || !isEmailInboundPlugin(registered.plugin)) {
            throw new EmailFacadeError(
                `Inbound email plugin not found or disabled: ${pluginId}`,
                operation,
                pluginId,
            );
        }
        const refuse = (reason: string): never => {
            this.logger.warn(`${operation}: refusing the webhook for ${pluginId} — ${reason}`);
            throw new ServiceUnavailableException(
                `Inbound email plugin ${pluginId} is unavailable`,
            );
        };
        let real: unknown = registered.plugin;
        const lazy = registered.plugin as { __materialize?: () => Promise<IPlugin> };
        if (typeof lazy.__materialize === 'function') {
            try {
                real = await lazy.__materialize();
            } catch (error) {
                refuse(
                    `it could not be loaded: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }
        // Re-read the entry: an onLoad failure is recorded on it, in place.
        const state: string = registered.state;
        if (state !== 'loaded') {
            const cause = registered.error;
            refuse(
                `it is in the "${state}" state${
                    cause ? `: ${cause instanceof Error ? cause.message : String(cause)}` : ''
                }`,
            );
        }
        return (real ?? registered.plugin) as IEmailInboundPlugin;
    }

    /**
     * Run the plugin's signature check and FAIL CLOSED.
     *
     * The contract is synchronous: throw on a mismatch. An implementation
     * that returns a Promise instead is a bug, but a rejection it carries
     * must still refuse the webhook — never be left unawaited (a discarded
     * verification Promise both skips the check and surfaces as an unhandled
     * rejection, which terminates a Node process that has no
     * `unhandledRejection` listener) — so a thenable is awaited. A plugin with
     * no `verifyWebhookSignature` at all cannot authenticate anything and is
     * refused.
     */
    private async verifyWebhookSignature(
        plugin: IEmailInboundPlugin,
        pluginId: string,
        rawBody: Buffer,
        headers: Readonly<Record<string, string>>,
        emailOpts: EmailOptions,
    ): Promise<void> {
        if (typeof plugin.verifyWebhookSignature !== 'function') {
            throw new EmailFacadeError(
                `Inbound email plugin ${pluginId} cannot verify webhook signatures`,
                'verifyWebhookSignature',
                pluginId,
            );
        }
        const outcome: unknown = plugin.verifyWebhookSignature(rawBody, headers, emailOpts);
        if (isThenable(outcome)) {
            this.logger.error(
                `verifyWebhookSignature of ${pluginId} returned a Promise; the contract is ` +
                    'synchronous (throw on mismatch). Awaiting it so the check still gates the webhook.',
            );
            await outcome;
        }
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
        reservedMessageId: string | null = null,
    ): Promise<void> {
        if (!this.emailMessages || !options.userId || !options.addressId) return;
        const existingRowId = options.draftMessageId ?? reservedMessageId;
        if (existingRowId) {
            // AW-05 — an approved draft, or a send admitted with a
            // reservation, already has its row; move it on rather than
            // inserting a duplicate audit row.
            await this.emailMessages.transitionStatus(existingRowId, ['sending'], 'sent', {
                pluginId: result.provider,
                providerMessageId: result.providerMessageId,
                sentAt: new Date(),
                deliveryStatus: 'accepted',
                failureReason: null,
            });
            return;
        }
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
            status: 'sent',
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

/** Whether `value` is a Promise or any other thenable. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
    return (
        (typeof value === 'object' || typeof value === 'function') &&
        value !== null &&
        typeof (value as { then?: unknown }).then === 'function'
    );
}
