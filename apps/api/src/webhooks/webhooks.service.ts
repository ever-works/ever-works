import {
    Injectable,
    Logger,
    BadRequestException,
    NotFoundException,
    ForbiddenException,
    Optional,
} from '@nestjs/common';
import {
    OrganizationRepository,
    UserRepository,
    WebhookSubscriptionRepository,
} from '@ever-works/agent/database';
import { ApiKey } from '@ever-works/agent/entities';
import type {
    WebhookSubscription,
    WebhookSubscriptionOwnerType,
    WebhookSubscriptionStatus,
} from '@ever-works/agent/entities';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { DOMAIN_EVENT_TYPES, isDomainEventType } from '@ever-works/contracts';
import { DomainEventFeedService } from '@ever-works/agent/domain-events';
// Security: reuse the canonical lexical SSRF guard shared with the delivery
// path (packages/agent/src/utils/ssrf-guard.ts) instead of a weaker inline
// hostname check. It strips IPv6 brackets, and covers IPv4-mapped IPv6,
// ULA (fc00::/7), link-local, CGNAT (100.64/10), 0.0.0.0/8 and cloud-metadata
// hosts — closing the [::1] / ::ffff:127.0.0.1 / IPv6-range bypasses.
import { isSafeWebhookUrl } from '@ever-works/agent/utils';
// Security (EW-711 #14): work-scoped subscriptions must be authorized against
// the caller's access to that Work — see the ownership gate in `create()`.
import { effectiveIntegrationKeyPins, WorkOwnershipService } from '@ever-works/agent/services';
import { WebhookSecretService } from './webhook-secret.service';

export interface WebhookSubscriptionView {
    id: string;
    accountId: string;
    workId: string | null;
    url: string;
    status: WebhookSubscriptionStatus;
    consecutiveFailures: number;
    lastDeliveryAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    /** 1 = legacy work/deploy events; 2 = domain events (webhooks v2). */
    version: 1 | 2;
    /** v2 fields (null on v1 rows). */
    ownerType: WebhookSubscriptionOwnerType;
    /**
     * The owning user or integration key (`api_keys.id`); null on v1 rows. Lets
     * Settings → Integrations → Ever Gauzy list each key's subscriptions (EW-P1-7).
     */
    ownerId: string | null;
    events: string[] | null;
    organizationIds: string[] | null;
    excludeOriginTags: string[] | null;
    description: string | null;
}

/** Webhooks v2 (EW-P1-5) create input: `events` + `organizationIds` make a v2 subscription. */
export interface CreateWebhookV2Input {
    readonly url: string;
    readonly events: readonly string[];
    readonly organizationIds: readonly string[];
    readonly excludeOriginTags?: readonly string[];
    readonly description?: string | null;
}

/** PATCH input: `status` for every subscription; the rest for v2 only. */
export interface UpdateWebhookInput {
    readonly status?: 'active' | 'paused';
    readonly url?: string;
    readonly events?: readonly string[];
    readonly organizationIds?: readonly string[];
    readonly excludeOriginTags?: readonly string[];
    readonly description?: string | null;
}

const MAX_PER_ACCOUNT = 25;

/** v2 rotation: how long the previous secret keeps signing (as a second `v1=`). */
const DEFAULT_ROTATION_GRACE_HOURS = 24;

/**
 * Webhooks v2 event filters: a catalog type, `<prefix>.*` for a prefix some
 * catalog type has, or `*`. Opt-in types (task.runtime_updated) are delivered
 * only when named exactly; patterns never widen to them.
 */
export function assertValidEventPatterns(patterns: readonly string[]): string[] {
    const cleaned = [...new Set(patterns.map((p) => p.trim()).filter((p) => p.length > 0))];
    if (cleaned.length === 0) {
        throw new BadRequestException('events must name at least one event type or pattern');
    }
    if (cleaned.length > 200) {
        throw new BadRequestException('events takes at most 200 types or patterns');
    }
    for (const pattern of cleaned) {
        if (pattern === '*' || isDomainEventType(pattern)) continue;
        if (pattern.endsWith('.*')) {
            const prefix = pattern.slice(0, -1);
            if (DOMAIN_EVENT_TYPES.some((type) => type.startsWith(prefix))) continue;
        }
        throw new BadRequestException(
            `events: "${pattern}" is not a catalog event type, "<prefix>.*" or "*"`,
        );
    }
    return cleaned;
}

@Injectable()
export class WebhooksService {
    private readonly logger = new Logger(WebhooksService.name);

    constructor(
        private readonly repo: WebhookSubscriptionRepository,
        private readonly secrets: WebhookSecretService,
        private readonly workOwnership: WorkOwnershipService,
        // Webhooks v2 (EW-P1-5): organization access checks. Optional and last so
        // hand-built test graphs keep constructing; v2 creation refuses without them.
        @Optional() private readonly users?: UserRepository,
        @Optional() private readonly organizations?: OrganizationRepository,
        // The change-feed head a new v2 subscription starts after (exact
        // "only new events"). Optional + last.
        @Optional() private readonly feed?: DomainEventFeedService,
        // Review 2026-10-17 F46: the key's effective pins, for a key-owned subscription
        // edited from Settings. Optional + last.
        @Optional() @InjectDataSource() private readonly dataSource?: DataSource,
    ) {}

    /**
     * Every subscription of the account, whatever its status: a paused or
     * failed subscription stays visible so it can be resumed (Settings > Webhooks).
     */
    async listForAccount(accountId: string): Promise<WebhookSubscriptionView[]> {
        const rows = await this.repo.listForAccount(accountId);
        return rows.map((row) => this.toView(row));
    }

    /**
     * Review 2026-10-17 F47: the v2 subscriptions owned by these integration keys,
     * whichever account holds them (a key's subscriptions sit in its creator's
     * account). The caller passes only keys it manages (`IntegrationKeyService.list`).
     */
    async listForIntegrationKeys(keyIds: readonly string[]): Promise<WebhookSubscriptionView[]> {
        const views: WebhookSubscriptionView[] = [];
        for (const keyId of new Set(keyIds)) {
            const rows = await this.repo.listForOwner('integration_key', keyId);
            views.push(...rows.map((row) => this.toView(row)));
        }
        return views;
    }

    /**
     * Integration API v1 (EW-P1-5): the v2 subscriptions one owner holds in the
     * account, e.g. those an integration key created. Another owner's
     * subscriptions in the same account are not listed.
     */
    async listForOwner(
        accountId: string,
        owner: { type: WebhookSubscriptionOwnerType; id: string },
    ): Promise<WebhookSubscriptionView[]> {
        const rows = await this.repo.listForOwner(owner.type, owner.id);
        return rows.filter((row) => row.accountId === accountId).map((row) => this.toView(row));
    }

    /**
     * The subscription, when it is in the account AND held by `owner`; else 404
     * (an integration key never sees or changes the account's other webhooks).
     */
    async findOwnedBy(
        accountId: string,
        id: string,
        owner: { type: WebhookSubscriptionOwnerType; id: string },
    ): Promise<WebhookSubscriptionView> {
        const row = await this.findOwn(accountId, id);
        if ((row.ownerType ?? 'user') !== owner.type || row.ownerId !== owner.id) {
            throw new NotFoundException('Webhook subscription not found');
        }
        return this.toView(row);
    }

    /**
     * Webhooks v2 (EW-P1-5): a subscription to the domain events of the given
     * organizations. The account must belong to each organization (the rule of
     * OrganizationMembershipService.ensureAdmin: the organization's tenant is
     * the user's). `owner` defaults to the account itself.
     */
    async createV2(
        accountId: string,
        input: CreateWebhookV2Input,
        owner: { type: WebhookSubscriptionOwnerType; id: string } = { type: 'user', id: accountId },
    ): Promise<{ subscription: WebhookSubscriptionView; signingSecret: string }> {
        this.assertValidUrl(input.url);
        const events = assertValidEventPatterns(input.events);
        const organizationIds = await this.assertOrganizationsAccessible(
            accountId,
            input.organizationIds,
        );
        const excludeOriginTags = this.cleanOriginTags(input.excludeOriginTags);

        const existing = await this.repo.listActiveForAccount(accountId);
        if (existing.length >= MAX_PER_ACCOUNT) {
            throw new BadRequestException(
                `Account is already at the per-account limit of ${MAX_PER_ACCOUNT} active subscriptions`,
            );
        }

        const { raw, encrypted } = this.secrets.generateSecret();
        const firstOrg = await this.organizations?.findById(organizationIds[0]);
        const row = await this.repo.createV2({
            accountId,
            ownerType: owner.type,
            ownerId: owner.id,
            url: input.url,
            secretEncrypted: encrypted,
            events,
            organizationIds,
            excludeOriginTags,
            description: input.description?.trim() || null,
            tenantId: firstOrg?.tenantId ?? null,
            organizationId: organizationIds.length === 1 ? organizationIds[0] : null,
            startAfterSeq: this.feed ? await this.feed.head() : null,
        });
        return { subscription: this.toView(row), signingSecret: raw };
    }

    /**
     * PATCH: `status: 'paused'` pauses and `status: 'active'` resumes (and
     * resets the failure streak of) any subscription; `url`, `events`,
     * `organizationIds`, `excludeOriginTags` and `description` change a v2 one.
     * A `disabled` subscription (its owner lost access) cannot be resumed.
     */
    async update(
        accountId: string,
        id: string,
        input: UpdateWebhookInput,
    ): Promise<WebhookSubscriptionView> {
        const row = await this.findOwn(accountId, id);
        const isV2 = Number(row.version) === 2;
        const touchesV2 =
            input.url !== undefined ||
            input.events !== undefined ||
            input.organizationIds !== undefined ||
            input.excludeOriginTags !== undefined ||
            input.description !== undefined;
        if (touchesV2 && !isV2) {
            throw new BadRequestException(
                'Only status can change on a v1 subscription; create a v2 subscription (events + organizationIds) instead',
            );
        }
        if (input.status !== undefined && row.status === 'disabled') {
            // Neither pause nor resume: pausing would turn `disabled` into
            // something a second PATCH could resume.
            throw new BadRequestException(
                'This subscription was disabled because its owner lost access; create a new one',
            );
        }
        if (input.status === 'active' && row.status !== 'active') {
            // Resuming counts against the same limit as creating.
            const active = await this.repo.listActiveForAccount(accountId);
            if (active.filter((sub) => sub.id !== row.id).length >= MAX_PER_ACCOUNT) {
                throw new BadRequestException(
                    `Account is already at the per-account limit of ${MAX_PER_ACCOUNT} active subscriptions`,
                );
            }
        }
        if (touchesV2) {
            const patch: Parameters<WebhookSubscriptionRepository['updateV2']>[1] = {};
            if (input.url !== undefined) {
                this.assertValidUrl(input.url);
                patch.url = input.url;
            }
            if (input.events !== undefined) patch.events = assertValidEventPatterns(input.events);
            if (input.organizationIds !== undefined) {
                patch.organizationIds = await this.assertOrganizationsAccessible(
                    accountId,
                    input.organizationIds,
                );
                if (row.ownerType === 'integration_key') {
                    await this.assertKeyPinned(row, patch.organizationIds);
                }
                // Keep the ownership stamp (what backups and scope filters read)
                // in step with the subscribed organizations.
                const firstOrg = await this.organizations?.findById(patch.organizationIds[0]);
                patch.organizationId =
                    patch.organizationIds.length === 1 ? patch.organizationIds[0] : null;
                patch.tenantId = firstOrg?.tenantId ?? row.tenantId ?? null;
            }
            if (input.excludeOriginTags !== undefined) {
                patch.excludeOriginTags = this.cleanOriginTags(input.excludeOriginTags);
            }
            if (input.description !== undefined) {
                patch.description = input.description?.trim() || null;
            }
            await this.repo.updateV2(row.id, patch);
        }
        if (input.status === 'paused') {
            await this.repo.pause(row.id);
        } else if (input.status === 'active') {
            await this.repo.resume(row.id);
        }
        const updated = await this.repo.findById(row.id);
        return this.toView(updated ?? row);
    }

    /**
     * Create a subscription for the caller. Returns the canonical
     * view plus the RAW signing secret. The raw secret appears ONLY
     * in this response — it is never readable again. Callers that
     * lose it must rotate via `rotateSecret()`.
     *
     * Security gates:
     *  - URL must be http: or https: (no `file:`, no `javascript:`)
     *  - URL must not target a loopback / link-local / private range
     *    when running in production (SSRF defense)
     *  - At most MAX_PER_ACCOUNT (25) active subscriptions per user
     */
    async create(
        accountId: string,
        input: { url: string; workId?: string | null },
    ): Promise<{ subscription: WebhookSubscriptionView; signingSecret: string }> {
        this.assertValidUrl(input.url);

        // Security (EW-711 #14): a subscription bound to a Work receives that
        // Work's lifecycle events (names, deployment URLs, error details), so
        // the caller must be allowed to view the Work they bind to. Nothing
        // validated `input.workId` before — any authenticated user could
        // subscribe to a foreign workId and exfiltrate its event stream.
        // `ensureCanView` passes for the creator and any work member, so
        // legitimate callers keep working. A Forbidden (work exists, not
        // yours) is masked as 404 to match this service's enumeration
        // defense (see `findOwn`) — callers must not learn that a foreign
        // workId exists.
        if (input.workId) {
            try {
                await this.workOwnership.ensureCanView(input.workId, accountId);
            } catch (error) {
                if (error instanceof ForbiddenException) {
                    throw new NotFoundException(`Work with id '${input.workId}' not found`);
                }
                throw error;
            }
        }

        const existing = await this.repo.listActiveForAccount(accountId);
        if (existing.length >= MAX_PER_ACCOUNT) {
            throw new BadRequestException(
                `Account is already at the per-account limit of ${MAX_PER_ACCOUNT} active subscriptions`,
            );
        }

        const { raw, encrypted } = this.secrets.generateSecret();
        const row = await this.repo.createForAccount({
            accountId,
            workId: input.workId ?? null,
            url: input.url,
            secretEncrypted: encrypted,
        });

        return {
            subscription: this.toView(row),
            signingSecret: raw,
        };
    }

    async pause(accountId: string, id: string): Promise<WebhookSubscriptionView> {
        const row = await this.findOwn(accountId, id);
        await this.repo.pause(row.id);
        const updated = await this.repo.findById(row.id);
        return this.toView(updated ?? row);
    }

    async rotateSecret(
        accountId: string,
        id: string,
    ): Promise<{ subscription: WebhookSubscriptionView; signingSecret: string }> {
        const row = await this.findOwn(accountId, id);
        const { raw, encrypted } = this.secrets.generateSecret();
        if (Number(row.version) === 2) {
            // v2: the previous secret keeps signing as a second `v1=` for the
            // grace window, so receivers can roll their verifier without a gap.
            await this.repo.updateSecret(row.id, encrypted, {
                secretEncrypted: row.secretEncrypted,
                expiresAt: new Date(Date.now() + rotationGraceMs()),
            });
        } else {
            await this.repo.updateSecret(row.id, encrypted);
        }
        const updated = await this.repo.findById(row.id);
        return {
            subscription: this.toView(updated ?? row),
            signingSecret: raw,
        };
    }

    async remove(accountId: string, id: string): Promise<void> {
        const row = await this.findOwn(accountId, id);
        await this.repo.delete(row.id);
    }

    /**
     * Internal helper used by {@link import('./webhooks-deliveries.service.ts').WebhooksDeliveriesService}
     * and the test-fire endpoint. Returns the raw entity (NOT the view) so
     * the caller can decrypt the secret. Cross-account access is masked
     * as 404 — same enumeration-defense as `findOwn`.
     */
    async findOwnEntity(accountId: string, id: string): Promise<WebhookSubscription> {
        return this.findOwn(accountId, id);
    }

    private async findOwn(accountId: string, id: string): Promise<WebhookSubscription> {
        const row = await this.repo.findById(id);
        if (!row) {
            throw new NotFoundException('Webhook subscription not found');
        }
        if (row.accountId !== accountId) {
            // Don't 403 vs 404 — that leaks "subscription with this id
            // exists, but isn't yours". Pretend it doesn't exist.
            throw new NotFoundException('Webhook subscription not found');
        }
        return row;
    }

    private toView(row: WebhookSubscription): WebhookSubscriptionView {
        return {
            id: row.id,
            accountId: row.accountId,
            workId: row.workId,
            url: row.url,
            status: row.status,
            consecutiveFailures: row.consecutiveFailures,
            lastDeliveryAt: row.lastDeliveryAt,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            version: Number(row.version) === 2 ? 2 : 1,
            ownerType: row.ownerType ?? 'user',
            ownerId: row.ownerId ?? null,
            events: row.events ?? null,
            organizationIds: row.organizationIds ?? null,
            excludeOriginTags: row.excludeOriginTags ?? null,
            description: row.description ?? null,
        };
    }

    /** Each organization must exist and share the account's tenant (404 otherwise, never 403). */
    private async assertOrganizationsAccessible(
        accountId: string,
        organizationIds: readonly string[],
    ): Promise<string[]> {
        const ids = [...new Set(organizationIds)];
        if (ids.length === 0) {
            throw new BadRequestException('organizationIds must name at least one organization');
        }
        if (!this.users || !this.organizations) {
            throw new BadRequestException('Webhooks v2 are not available in this deployment');
        }
        const user = await this.users.findById(accountId);
        for (const orgId of ids) {
            const org = await this.organizations.findById(orgId);
            if (!user?.tenantId || !org || org.tenantId !== user.tenantId) {
                throw new NotFoundException(`Organization ${orgId} not found`);
            }
        }
        return ids;
    }

    /**
     * Review 2026-10-17 F46: a subscription an integration key owns lists only
     * organizations that key is pinned to (contract: a subset of the key's pins), from
     * Settings as from the integration API. An organization outside them reads as absent
     * (404), like one outside the caller's Tenant.
     */
    private async assertKeyPinned(
        row: WebhookSubscription,
        organizationIds: readonly string[],
    ): Promise<void> {
        if (!this.dataSource) {
            throw new BadRequestException('Webhooks v2 are not available in this deployment');
        }
        const key = row.ownerId
            ? await this.dataSource.getRepository(ApiKey).findOne({ where: { id: row.ownerId } })
            : null;
        const pins = key ? await effectiveIntegrationKeyPins(this.dataSource.manager, key) : [];
        const outside = organizationIds.find((orgId) => !pins.includes(orgId));
        if (outside) throw new NotFoundException(`Organization ${outside} not found`);
    }

    private cleanOriginTags(tags: readonly string[] | undefined): string[] {
        const cleaned = [...new Set((tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0))];
        if (cleaned.length > 20) {
            throw new BadRequestException('excludeOriginTags takes at most 20 tags');
        }
        if (cleaned.some((t) => t.length > 100)) {
            throw new BadRequestException('an origin tag is at most 100 characters');
        }
        return cleaned;
    }

    private assertValidUrl(url: string): void {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new BadRequestException('url must be an absolute http(s) URL');
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new BadRequestException(
                `url scheme ${parsed.protocol} is not allowed; use http(s)`,
            );
        }
        // SSRF defense — refuse local / private / link-local / metadata
        // targets. We intentionally allow them in local dev/test so a
        // developer can point at https://webhook.site or a local tunnel,
        // but staging shares network access to cloud metadata / internal
        // tooling, so the guard MUST run there too. Skip only in the
        // explicit local dev/test envs.
        // Security: gate now covers every non-local env (was production-only),
        // and uses isSafeWebhookUrl (handles bracketed IPv6, IPv4-mapped IPv6,
        // ULA/CGNAT/metadata) which `localhost` also fails since it is not a
        // literal IP — but we keep an explicit `localhost` reject for clarity.
        const env = process.env.NODE_ENV;
        const isLocalEnv =
            env === 'development' || env === 'test' || env === undefined || env === '';
        if (!isLocalEnv) {
            const lowerHost = parsed.hostname.toLowerCase();
            const bareHost =
                lowerHost.startsWith('[') && lowerHost.endsWith(']')
                    ? lowerHost.slice(1, -1)
                    : lowerHost;
            if (bareHost === 'localhost' || !isSafeWebhookUrl(url)) {
                throw new ForbiddenException(
                    `url ${parsed.hostname} resolves to a private / loopback / link-local address`,
                );
            }
            // HMAC-signed webhook payloads must not traverse plaintext http
            // in non-local envs (the signature/secret would be exposed on the
            // wire). Local dev/test still allows http above so tunnels work.
            // Checked after the SSRF guard so private/loopback hosts keep their
            // existing 403 surface regardless of scheme.
            if (parsed.protocol !== 'https:') {
                throw new BadRequestException(
                    'webhook url must use https in non-local environments',
                );
            }
        }
    }
}

/** `WEBHOOK_SECRET_ROTATION_GRACE_HOURS` (default 24; 0 = no grace). */
function rotationGraceMs(): number {
    const env = process.env.WEBHOOK_SECRET_ROTATION_GRACE_HOURS;
    const raw = env ? Number(env) : Number.NaN;
    const hours = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_ROTATION_GRACE_HOURS;
    return hours * 60 * 60 * 1000;
}
