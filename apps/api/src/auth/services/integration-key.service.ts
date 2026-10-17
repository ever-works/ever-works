import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomBytes, createHash } from 'crypto';
import {
    ApiKeyRepository,
    OrganizationMemberRepository,
    OrganizationRepository,
    TenantRepository,
    UserRepository,
} from '@ever-works/agent/database';
import { ActivityLogService } from '@ever-works/agent/activity-log';
import { ActivityActionType, ActivityStatus } from '@ever-works/agent/entities';
import type { ApiKey, Organization } from '@ever-works/agent/entities';
import {
    INTEGRATION_API_KEY_KIND,
    INTEGRATION_KEY_MAX_ORGANIZATIONS,
    INTEGRATION_KEY_PREFIX,
    INTEGRATION_KEYS_MAX_PER_TENANT,
    integrationActorLabel,
    isIntegrationKind,
    isIntegrationScope,
    type CreateIntegrationKeyRequest,
    type CreateIntegrationKeyResponse,
    type IntegrationKeyOrganization,
    type IntegrationKeySummary,
    type IntegrationKind,
    type IntegrationScope,
} from '@ever-works/contracts';

/**
 * In-process event emitted when an integration key is revoked, so owners of
 * things that hang off a key (webhooks v2 subscriptions, EW-P1-5) can disable
 * them. Payload: {@link IntegrationKeyRevokedEvent}.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const INTEGRATION_KEY_REVOKED_EVENT = 'integration-key.revoked';

export interface IntegrationKeyRevokedEvent {
    keyId: string;
    tenantId: string | null;
    revokedByUserId: string;
}

/**
 * EW-P1-2 — creating, listing and revoking integration keys (`ew_int_…`).
 * Validation and rotation live in `ApiKeyService`, shared with personal keys.
 *
 * **Who may create (EW-P2-6):** the Tenant owner (every Organization of the
 * Tenant), or an Organization `admin` (a roster member the owner promoted), who may
 * pin only the Organizations they administer. The key acts as its creator; the
 * principal re-reads the creator's admin Organizations on every request
 * (`ApiKeyService.effectivePins`), so a demotion takes the pins away at once.
 *
 * **Pins:** at least one, at most 50, every one an Organization of the
 * creator's Tenant. **Scopes:** at least one, every one from vocabulary v1;
 * `goals:activate`, `missions:activate` and `ideas:build` do not exist in it,
 * so they can never be granted.
 *
 * **Cap:** 20 active integration keys per Tenant. They do NOT count against
 * the creator's ten personal keys.
 *
 * **Revoke** switches the row off (`isActive = false`) instead of deleting it:
 * the activity rows and webhook subscriptions that point at the key keep a
 * target, and the same `isActive` check that refuses a revoked personal key
 * refuses it immediately.
 */
@Injectable()
export class IntegrationKeyService {
    private readonly logger = new Logger(IntegrationKeyService.name);

    constructor(
        private readonly apiKeys: ApiKeyRepository,
        private readonly tenants: TenantRepository,
        private readonly organizations: OrganizationRepository,
        private readonly users: UserRepository,
        @Optional() private readonly activityLog?: ActivityLogService,
        @Optional() private readonly events?: EventEmitter2,
        // EW-P2-6 — Organization admins (roster role `admin`). Appended LAST +
        // @Optional(): absent, only the Tenant owner manages keys (today's rule).
        @Optional() private readonly members?: OrganizationMemberRepository,
    ) {}

    async create(
        userId: string,
        input: CreateIntegrationKeyRequest,
    ): Promise<CreateIntegrationKeyResponse> {
        const { tenantId, administered } = await this.assertCanManage(userId);

        const scopes = this.normalizeScopes(input.scopes);
        const integrationKind: IntegrationKind = input.integrationKind ?? 'generic';
        if (!isIntegrationKind(integrationKind)) {
            throw new BadRequestException(`Unknown integrationKind: ${String(integrationKind)}`);
        }
        const tenantOrgs = await this.organizations.findByTenantId(tenantId);
        // An admin pins only the Organizations they administer (the owner: all).
        const manageable =
            administered === 'all'
                ? tenantOrgs
                : tenantOrgs.filter((org) => administered.includes(org.id));
        const organizationIds = this.normalizeOrganizationIds(input.organizationIds, manageable);

        const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
        if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date())) {
            throw new BadRequestException('Expiration date must be in the future');
        }

        const active = await this.apiKeys.countActiveIntegrationKeysByTenant(tenantId);
        if (active >= INTEGRATION_KEYS_MAX_PER_TENANT) {
            throw new BadRequestException(
                `Maximum of ${INTEGRATION_KEYS_MAX_PER_TENANT} integration keys allowed per workspace`,
            );
        }

        const rawKey = INTEGRATION_KEY_PREFIX + randomBytes(32).toString('hex');
        const row = await this.apiKeys.create({
            userId,
            name: input.name.trim(),
            hashedKey: createHash('sha256').update(rawKey).digest('hex'),
            prefix: rawKey.substring(0, 12),
            expiresAt,
            kind: INTEGRATION_API_KEY_KIND,
            scopes,
            organizationIds,
            integrationKind,
            description: input.description?.trim() || null,
            tenantId,
            // The pins are the authorization; the scalar column stays NULL so
            // nothing mistakes the key for one bound to a single Organization.
            organizationId: null,
        });

        // The count above and the insert are not one atomic step, so two
        // overlapping creates could both pass it. Re-count with the new row in
        // place and withdraw it when the cap is exceeded: the request fails
        // closed (it never returned a secret), and a retry succeeds once a slot
        // is really free.
        const afterInsert = await this.apiKeys.countActiveIntegrationKeysByTenant(tenantId);
        if (afterInsert > INTEGRATION_KEYS_MAX_PER_TENANT) {
            await this.apiKeys.deleteByIdAndUserId(row.id, userId);
            throw new BadRequestException(
                `Maximum of ${INTEGRATION_KEYS_MAX_PER_TENANT} integration keys allowed per workspace`,
            );
        }

        const summary = this.toSummary(row, tenantOrgs);
        await this.audit(
            userId,
            ActivityActionType.INTEGRATION_KEY_CREATED,
            row,
            'Integration key created',
        );
        return { ...summary, key: rawKey };
    }

    /**
     * The Tenant's active integration keys: every one for the Tenant owner; an
     * Organization admin (EW-P2-6) sees the keys they created. Anyone else: none.
     */
    async list(userId: string): Promise<IntegrationKeySummary[]> {
        const tenant = await this.ownedTenant(userId);
        if (tenant) {
            const [rows, orgs] = await Promise.all([
                this.apiKeys.findIntegrationKeysByTenant(tenant.id),
                this.organizations.findByTenantId(tenant.id),
            ]);
            return rows.map((row) => this.toSummary(row, orgs));
        }
        const admin = await this.adminTenant(userId);
        if (!admin) return [];
        const [rows, orgs] = await Promise.all([
            this.apiKeys.findIntegrationKeysByTenant(admin.tenantId),
            this.organizations.findByTenantId(admin.tenantId),
        ]);
        return rows.filter((row) => row.userId === userId).map((row) => this.toSummary(row, orgs));
    }

    /**
     * EW-P2-6 — `org:write`: pin an Organization created through the integration
     * API to the key that created it (at most {@link INTEGRATION_KEY_MAX_ORGANIZATIONS}).
     */
    async addPin(keyId: string, organizationId: string): Promise<string[]> {
        await this.assertPinCapacity(keyId, organizationId);
        // One locked read-modify-write: concurrent creates through one key keep every pin.
        const result = await this.apiKeys.appendOrganizationId(
            keyId,
            organizationId,
            INTEGRATION_KEY_MAX_ORGANIZATIONS,
        );
        if (result.status === 'missing') throw new NotFoundException('Integration key not found');
        if (result.status === 'full') throw this.pinsFull();
        return result.organizationIds;
    }

    /**
     * EW-P2-6 — undo a pin {@link addPin} reserved for an Organization whose create then
     * failed. Never throws for a pin that is not there.
     */
    async releasePin(keyId: string, organizationId: string): Promise<void> {
        await this.apiKeys.removeOrganizationId(keyId, organizationId);
    }

    /**
     * EW-P2-6 — refuse BEFORE `POST /organizations` writes anything when the key has no
     * pin left, so a full key never leaves an orphan Organization behind. `404` when
     * `keyId` is not an integration key.
     */
    async assertPinCapacity(keyId: string, organizationId?: string): Promise<void> {
        const row = await this.apiKeys.findById(keyId);
        if (!row || row.kind !== INTEGRATION_API_KEY_KIND) {
            throw new NotFoundException('Integration key not found');
        }
        const pins = Array.isArray(row.organizationIds) ? row.organizationIds : [];
        if (organizationId && pins.includes(organizationId)) return;
        if (pins.length >= INTEGRATION_KEY_MAX_ORGANIZATIONS) throw this.pinsFull();
    }

    private pinsFull(): BadRequestException {
        return new BadRequestException(
            `A key may be pinned to at most ${INTEGRATION_KEY_MAX_ORGANIZATIONS} organizations`,
        );
    }

    /**
     * Revoke an integration key of the caller's Tenant. Returns `false` when
     * `id` is not an active integration key the caller manages (the controller
     * falls back to the personal-key path, then 404s).
     */
    async revoke(id: string, userId: string): Promise<boolean> {
        // A non-uuid id cannot be a key; answer before a uuid column sees it
        // (Postgres would reject the cast) so the caller's 404 stays a 404.
        if (!UUID_RE.test(id)) return false;
        let row = await this.apiKeys.findByIdAndUserId(id, userId);
        if (!row) {
            // EW-P2-6 — the Tenant owner may also revoke a key an Organization admin
            // created in their Tenant.
            const tenant = await this.ownedTenant(userId);
            const candidate = tenant ? await this.apiKeys.findById(id) : null;
            row = candidate && candidate.tenantId === tenant?.id ? candidate : null;
        }
        if (!row || row.kind !== INTEGRATION_API_KEY_KIND) return false;
        const deactivated = await this.apiKeys.deactivateById(row.id);
        // Already revoked: the request is handled (idempotent 200). It must
        // NOT fall through to the personal-key delete, which would destroy the
        // row the audit trail and webhook subscriptions point at. The event and
        // the audit row are written only by the revoke that switched it off.
        if (!deactivated) return true;
        const event: IntegrationKeyRevokedEvent = {
            keyId: row.id,
            tenantId: row.tenantId ?? null,
            revokedByUserId: userId,
        };
        this.events?.emit(INTEGRATION_KEY_REVOKED_EVENT, event);
        await this.audit(
            userId,
            ActivityActionType.INTEGRATION_KEY_REVOKED,
            row,
            'Integration key revoked',
        );
        return true;
    }

    /**
     * Record a rotation of an integration key (the rotation itself is
     * `ApiKeyService.rotateKey`). Best-effort end to end, the lookup included:
     * it runs after the new secret is saved, and the caller must still get
     * that secret back whatever happens here.
     */
    async recordRotation(userId: string, keyId: string): Promise<void> {
        if (!UUID_RE.test(keyId)) return;
        try {
            const row = await this.apiKeys.findByIdAndUserId(keyId, userId);
            if (!row || row.kind !== INTEGRATION_API_KEY_KIND) return;
            await this.audit(
                userId,
                ActivityActionType.INTEGRATION_KEY_ROTATED,
                row,
                'Integration key rotated',
            );
        } catch (err) {
            this.logger.warn(
                `Failed to record the rotation of integration key ${keyId}: ${(err as Error).message}`,
            );
        }
    }

    // ── internals ────────────────────────────────────────────────────────

    /**
     * The caller's Tenant and the Organizations they may pin: all of them for the
     * Tenant owner, the ones they administer for an Organization admin (EW-P2-6);
     * 403 for anyone else.
     */
    private async assertCanManage(
        userId: string,
    ): Promise<{ tenantId: string; administered: 'all' | string[] }> {
        const tenant = await this.ownedTenant(userId);
        if (tenant) return { tenantId: tenant.id, administered: 'all' };
        const admin = await this.adminTenant(userId);
        if (admin) return admin;
        throw new ForbiddenException(
            'Only the workspace owner or an organization admin can create integration keys. Create an organization first if you have none.',
        );
    }

    /** EW-P2-6 — the caller's Tenant and the Organizations they administer, or `null`. */
    private async adminTenant(
        userId: string,
    ): Promise<{ tenantId: string; administered: string[] } | null> {
        if (!this.members) return null;
        const user = await this.users.findById(userId);
        if (!user?.tenantId) return null;
        const administered = await this.members.listAdministeredOrganizationIds(
            userId,
            user.tenantId,
        );
        return administered.length > 0 ? { tenantId: user.tenantId, administered } : null;
    }

    private async ownedTenant(userId: string) {
        const user = await this.users.findById(userId);
        if (!user?.tenantId) return null;
        const tenant = await this.tenants.findById(user.tenantId);
        return tenant && tenant.ownerUserId === userId ? tenant : null;
    }

    private normalizeScopes(raw: unknown): IntegrationScope[] {
        if (!Array.isArray(raw) || raw.length === 0) {
            throw new BadRequestException('scopes must list at least one scope');
        }
        const unknownScopes = raw.filter((scope) => !isIntegrationScope(scope));
        if (unknownScopes.length > 0) {
            throw new BadRequestException(
                `Unknown or non-grantable scopes: ${unknownScopes.join(', ')}`,
            );
        }
        return [...new Set(raw as IntegrationScope[])];
    }

    private normalizeOrganizationIds(raw: unknown, tenantOrgs: Organization[]): string[] {
        if (!Array.isArray(raw) || raw.length === 0) {
            throw new BadRequestException(
                'organizationIds must pin the key to at least one organization',
            );
        }
        const ids = [...new Set(raw.filter((id): id is string => typeof id === 'string'))];
        if (ids.length > INTEGRATION_KEY_MAX_ORGANIZATIONS) {
            throw new BadRequestException(
                `A key may be pinned to at most ${INTEGRATION_KEY_MAX_ORGANIZATIONS} organizations`,
            );
        }
        const owned = new Set(tenantOrgs.map((org) => org.id));
        const foreign = ids.filter((id) => !owned.has(id));
        if (foreign.length > 0 || ids.length !== raw.length) {
            // Same answer for "missing" and "someone else's": no existence leak.
            throw new BadRequestException(
                'organizationIds must be organizations of your workspace',
            );
        }
        return ids;
    }

    private toSummary(row: ApiKey, tenantOrgs: Organization[]): IntegrationKeySummary {
        const pins = Array.isArray(row.organizationIds) ? row.organizationIds : [];
        const byId = new Map(tenantOrgs.map((org) => [org.id, org]));
        const organizations: IntegrationKeyOrganization[] = pins
            .map((id) => byId.get(id))
            .filter((org): org is Organization => !!org)
            .map((org) => ({ id: org.id, slug: org.slug, displayName: org.displayName }));
        return {
            id: row.id,
            name: row.name,
            description: row.description ?? null,
            prefix: row.prefix,
            kind: INTEGRATION_API_KEY_KIND,
            integrationKind: isIntegrationKind(row.integrationKind)
                ? row.integrationKind
                : 'generic',
            scopes: (Array.isArray(row.scopes) ? row.scopes : []).filter(isIntegrationScope),
            organizationIds: pins,
            organizations,
            createdByUserId: row.userId,
            createdAt: toIso(row.createdAt) ?? new Date().toISOString(),
            lastUsedAt: toIso(row.lastUsedAt),
            expiresAt: toIso(row.expiresAt),
            rotatedAt: toIso(row.rotatedAt),
            previousKeyGraceUntil: toIso(row.previousKeyGraceUntil),
        };
    }

    private async audit(
        userId: string,
        actionType: ActivityActionType,
        row: ApiKey,
        summary: string,
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId,
                actionType,
                action: actionType,
                status: ActivityStatus.COMPLETED,
                summary: `${summary}: ${integrationActorLabel(row.integrationKind, row.name)}`,
                details: {
                    resourceType: 'integration_key',
                    resourceId: row.id,
                    keyId: row.id,
                    name: row.name,
                    prefix: row.prefix,
                    integrationKind: row.integrationKind ?? null,
                    scopes: row.scopes ?? [],
                    organizationIds: row.organizationIds ?? [],
                },
                actorKind: 'user',
                tenantId: row.tenantId ?? null,
                organizationId: null,
            });
        } catch (err) {
            // Audit is best-effort here: the key operation already happened.
            this.logger.warn(
                `Failed to write ${actionType} activity row: ${(err as Error).message}`,
            );
        }
    }
}

function toIso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
