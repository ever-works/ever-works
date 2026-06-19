import { Injectable, Logger, Optional } from '@nestjs/common';
import {
    OrganizationRepository,
    TemplateCustomizationRepository,
    WebhookSubscriptionRepository,
    WorkRepository,
} from '@ever-works/agent/database';
import { CredentialVersionService } from '@ever-works/agent/tasks';
import type { TenantJobRuntimeConfig } from '@ever-works/agent/entities';

/**
 * EW-742 P3.2 T22 (worker-host consumption) — reads the
 * `(providerId, credentialVersion)` pair captured at enqueue time by
 * {@link RuntimeBindingStamperService} and resolves the matching
 * tenant credential snapshot via
 * {@link CredentialVersionService.resolveSnapshot}.
 *
 * # Why this exists
 *
 * The dispatcher-side T22 rollout (PRs #1427, #1430, #1431) stamps
 * `(providerId, credentialVersion)` onto every supported dispatcher's
 * payload. Without a consumer, those fields are pure metadata. This
 * service is the first consumer — it gives every Trigger.dev worker
 * task the ability to:
 *
 *   1. **Verify the binding is still valid** — if the tenant rotated
 *      credentials past this run's version (`resolveSnapshot` returns
 *      null), the run can either retry against the current credentials
 *      (idempotent operations) or fail with `CREDENTIAL_DRAINED` and
 *      defer to a fresh enqueue (per ADR-017 §3 graceful drain).
 *
 *   2. **Observe binding state** — every call logs the resolved
 *      provider + version + tenant for production traces, so the
 *      operator can see "this kb-embed run used tenant overlay v7"
 *      without instrumenting each task individually.
 *
 *   3. **Bind the runtime to the snapshot** (future) — once
 *      per-provider `bindToTenant` impls land for the non-Trigger
 *      runtimes, this service is the seam where the resolved snapshot
 *      becomes the per-run binding passed to the dispatcher's
 *      transient view. For Trigger.dev today, that's a no-op (the
 *      Trigger SDK is a singleton; see TriggerJobRuntimeProvider
 *      `bindToTenant` JSDoc "What this PR DOES NOT do" note).
 *
 * # API
 *
 * Single public method:
 *
 *   `resolve(payload, tenantIdResolver) -> { status, snapshot?, ... }`
 *
 * - `status: 'no-binding'` — payload has no `(providerId, credentialVersion)`
 *   pair (pre-T22 enqueue, or tenant has no overlay). Worker MUST fall
 *   back to the instance default (byte-identical pre-overlay path).
 * - `status: 'resolved'` — snapshot matches the requested version.
 *   Worker uses it.
 * - `status: 'drained'` — snapshot was rotated past the requested
 *   version. Worker MUST either fail with `CREDENTIAL_DRAINED` (strict
 *   tasks) or fall back to instance default (idempotent tasks).
 * - `status: 'error'` — RPC / DB error during resolution. Treated as
 *   `'no-binding'` for fail-open per FR-5 — better to run with the
 *   instance default than to block a run on a transient lookup error.
 *
 * `tenantIdResolver` is task-specific: KB-embed resolves via
 * `WorkRepository.findById(workId)`; work-generation already has the
 * tenantId on `work.tenantId`; etc. The service accepts a callback so
 * the resolver pattern stays per-task without leaking task knowledge
 * into this generic service.
 *
 * # Scope of THIS PR (PoC)
 *
 * Only the service + tests. The kb-embed-document task picks it up in
 * a follow-up (one-line `appContext.get` + `await resolve(...)` + log).
 * The same per-task wiring deferral the dispatcher-side T22 rollout
 * used — adopt incrementally, no bus-stop PR.
 */
@Injectable()
export class TenantRuntimeBindingResolverService {
    private readonly logger = new Logger(TenantRuntimeBindingResolverService.name);

    constructor(
        @Optional() private readonly credentialVersionService?: CredentialVersionService,
        @Optional() private readonly workRepository?: WorkRepository,
        @Optional() private readonly organizationRepository?: OrganizationRepository,
        @Optional()
        private readonly templateCustomizationRepository?: TemplateCustomizationRepository,
        @Optional()
        private readonly webhookSubscriptionRepository?: WebhookSubscriptionRepository,
    ) {}

    /**
     * Resolve the tenant credential snapshot for an inbound worker
     * payload. See class JSDoc for the return-shape semantics.
     *
     * @param payload    The inbound worker payload. Only the
     *                   `providerId` + `credentialVersion` fields are
     *                   read; everything else is ignored.
     * @param tenantId   The tenantId for THIS run. Pass `null` when
     *                   unknown (the result will be `'no-binding'`).
     */
    async resolve(
        payload: { providerId?: string | null; credentialVersion?: number | null },
        tenantId: string | null,
    ): Promise<{
        status: 'no-binding' | 'resolved' | 'drained' | 'error';
        snapshot?: TenantJobRuntimeConfig;
        providerId?: string;
        credentialVersion?: number;
        tenantId?: string;
    }> {
        const providerId = payload.providerId ?? null;
        const credentialVersion = payload.credentialVersion ?? null;

        // Fast path: no overlay was active at enqueue time, OR the
        // payload was enqueued before T22 landed. Either way the
        // worker MUST behave byte-identically to the pre-overlay
        // (EW-683) path — no log noise for the common case.
        if (providerId === null || credentialVersion === null) {
            return { status: 'no-binding' };
        }

        if (!tenantId) {
            this.logger.debug(
                `TenantRuntimeBindingResolver: payload has provider=${providerId} v=${credentialVersion} ` +
                    `but tenantId is null. Treating as no-binding (worker falls back to instance default).`,
            );
            return { status: 'no-binding' };
        }

        if (!this.credentialVersionService) {
            this.logger.debug(
                `TenantRuntimeBindingResolver: CredentialVersionService not wired. ` +
                    `Returning no-binding (worker falls back to instance default).`,
            );
            return { status: 'no-binding' };
        }

        let snapshot: TenantJobRuntimeConfig | null;
        try {
            snapshot = await this.credentialVersionService.resolveSnapshot(
                tenantId,
                credentialVersion,
            );
        } catch (err) {
            // RPC / DB hiccup. Per FR-5 fail-open: never block a run on
            // a transient lookup error. The worker uses instance default.
            this.logger.warn(
                `TenantRuntimeBindingResolver: resolveSnapshot threw for tenant=${tenantId} ` +
                    `v=${credentialVersion} (${err instanceof Error ? err.message : String(err)}); ` +
                    `treating as 'error' status (worker falls back to instance default).`,
            );
            return { status: 'error' };
        }

        if (!snapshot) {
            this.logger.warn(
                `TenantRuntimeBindingResolver: tenant=${tenantId} requested v=${credentialVersion} ` +
                    `but resolveSnapshot returned null (rotated past this version). ` +
                    `Status: 'drained'. Worker decides retry-with-current vs CREDENTIAL_DRAINED.`,
            );
            return {
                status: 'drained',
                providerId,
                credentialVersion,
                tenantId,
            };
        }

        this.logger.debug(
            `TenantRuntimeBindingResolver: resolved tenant=${tenantId} provider=${providerId} ` +
                `v=${credentialVersion} (mode=${snapshot.mode}, enabled=${snapshot.enabled}).`,
        );
        return {
            status: 'resolved',
            snapshot,
            providerId,
            credentialVersion,
            tenantId,
        };
    }

    /**
     * Convenience wrapper for workId-scoped tasks (KB-embed, KB-mirror,
     * KB-normalize-media, work-generation, work-import — i.e. every
     * dispatcher whose payload carries a `workId`). Resolves the
     * Work's `tenantId` via WorkRepository.findById, then delegates to
     * {@link resolve}.
     */
    async resolveForWork(
        payload: { providerId?: string | null; credentialVersion?: number | null },
        workId: string,
    ): Promise<Awaited<ReturnType<TenantRuntimeBindingResolverService['resolve']>>> {
        if (!this.workRepository) {
            return { status: 'no-binding' };
        }
        let tenantId: string | null = null;
        try {
            const work = await this.workRepository.findById(workId);
            tenantId = work?.tenantId ?? null;
        } catch (err) {
            this.logger.debug(
                `TenantRuntimeBindingResolver.resolveForWork: workRepository.findById ` +
                    `threw for work=${workId} (${(err as Error).message}); treating as no-binding.`,
            );
            return { status: 'no-binding' };
        }
        return this.resolve(payload, tenantId);
    }

    /**
     * Convenience wrapper for organizationId-scoped tasks (kb-org-overlay-
     * fanout). An organization belongs to exactly one tenant, so the fanout
     * (which targets multiple Works in that org) still has a single
     * unambiguous tenant scope. Resolves the Org's `tenantId` via
     * OrganizationRepository.findById, then delegates to {@link resolve}.
     */
    async resolveForOrganization(
        payload: { providerId?: string | null; credentialVersion?: number | null },
        organizationId: string,
    ): Promise<Awaited<ReturnType<TenantRuntimeBindingResolverService['resolve']>>> {
        if (!this.organizationRepository) {
            return { status: 'no-binding' };
        }
        let tenantId: string | null = null;
        try {
            const org = await this.organizationRepository.findById(organizationId);
            tenantId = org?.tenantId ?? null;
        } catch (err) {
            this.logger.debug(
                `TenantRuntimeBindingResolver.resolveForOrganization: organizationRepository.findById ` +
                    `threw for org=${organizationId} (${(err as Error).message}); treating as no-binding.`,
            );
            return { status: 'no-binding' };
        }
        return this.resolve(payload, tenantId);
    }

    /**
     * Convenience wrapper for subscriptionId-scoped tasks (webhook-
     * delivery). The WebhookSubscription row carries `tenantId`
     * directly; look it up and delegate.
     */
    async resolveForSubscription(
        payload: { providerId?: string | null; credentialVersion?: number | null },
        subscriptionId: string,
    ): Promise<Awaited<ReturnType<TenantRuntimeBindingResolverService['resolve']>>> {
        if (!this.webhookSubscriptionRepository) {
            return { status: 'no-binding' };
        }
        let tenantId: string | null = null;
        try {
            const sub = await this.webhookSubscriptionRepository.findById(subscriptionId);
            tenantId = sub?.tenantId ?? null;
        } catch (err) {
            this.logger.debug(
                `TenantRuntimeBindingResolver.resolveForSubscription: webhookSubscriptionRepository.findById ` +
                    `threw for subscription=${subscriptionId} (${(err as Error).message}); ` +
                    `treating as no-binding.`,
            );
            return { status: 'no-binding' };
        }
        return this.resolve(payload, tenantId);
    }

    /**
     * Convenience wrapper for customizationId-scoped tasks (template-
     * customization). The TemplateCustomization row carries `tenantId`
     * directly; look it up and delegate.
     */
    async resolveForCustomization(
        payload: { providerId?: string | null; credentialVersion?: number | null },
        customizationId: string,
    ): Promise<Awaited<ReturnType<TenantRuntimeBindingResolverService['resolve']>>> {
        if (!this.templateCustomizationRepository) {
            return { status: 'no-binding' };
        }
        let tenantId: string | null = null;
        try {
            const row = await this.templateCustomizationRepository.findById(customizationId);
            tenantId = row?.tenantId ?? null;
        } catch (err) {
            this.logger.debug(
                `TenantRuntimeBindingResolver.resolveForCustomization: templateCustomizationRepository.findById ` +
                    `threw for customization=${customizationId} (${(err as Error).message}); treating as no-binding.`,
            );
            return { status: 'no-binding' };
        }
        return this.resolve(payload, tenantId);
    }
}
