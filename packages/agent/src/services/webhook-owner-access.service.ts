import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { INTEGRATION_API_KEY_KIND, recipientScopeForEventType } from '@ever-works/contracts';
import { ApiKey } from '../entities/api-key.entity';
import { Organization } from '../entities/organization.entity';
import { User } from '../entities/user.entity';
import type { WebhookSubscription } from '../entities/webhook-subscription.entity';
import { effectiveIntegrationKeyPins } from './integration-key-pins';

/** Whether a v2 subscription's owner may receive events right now, and of which organizations. */
export interface WebhookOwnerAccess {
    readonly ok: boolean;
    /** Not ok AND for good (owner gone, key revoked or expired): mark the subscription `disabled`. */
    readonly disable: boolean;
    /** The organizations the owner can still see; empty when not ok. */
    readonly organizationIds: ReadonlySet<string>;
    /**
     * An integration-key owner's granted scopes (EW-P3-1: the recipient-scoped
     * domains `inbox.*` / `email.*` need their read scope). Absent for a user
     * owner, which never receives those events.
     */
    readonly scopes?: ReadonlySet<string> | null;
}

const DENIED_FOR_NOW: WebhookOwnerAccess = {
    ok: false,
    disable: false,
    organizationIds: new Set(),
};
const DENIED_FOR_GOOD: WebhookOwnerAccess = {
    ok: false,
    disable: true,
    organizationIds: new Set(),
};

/**
 * Webhooks v2 (EW-P1-5): who may still receive a subscription's events.
 *
 * Checked twice — when the fan-out creates a delivery, and again right
 * before each send (`WebhookSubscriptionDeliveryService`), so a delivery that
 * was queued, or is being retried, is never sent after its owner lost access:
 *  - a user owner belongs to the organizations of its tenant
 *    (`OrganizationMembershipService.ensureMember`); a deleted user denies for good;
 *  - an integration-key owner must be active and unexpired, and is limited to
 *    the organizations it is pinned to (for an admin's key, the ones its creator
 *    still administers — EW-P2-6); a revoked, expired or deleted key denies for good.
 */
@Injectable()
export class WebhookOwnerAccessService {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async resolve(sub: WebhookSubscription): Promise<WebhookOwnerAccess> {
        const ownerId = sub.ownerId ?? sub.accountId;
        if (sub.ownerType === 'integration_key') {
            const key = await this.dataSource
                .getRepository(ApiKey)
                .findOne({ where: { id: ownerId } });
            if (
                !key ||
                key.kind !== INTEGRATION_API_KEY_KIND ||
                !key.isActive ||
                (key.expiresAt && key.expiresAt.getTime() <= Date.now())
            ) {
                return DENIED_FOR_GOOD;
            }
            // EW-P2-6 — an admin's key keeps only the pins its creator still administers
            // (a demoted or removed admin receives nothing; re-promotion restores it).
            const pinned = await effectiveIntegrationKeyPins(this.dataSource.manager, key);
            if (key.tenantId && pinned.length === 0) return DENIED_FOR_NOW;
            return {
                ok: true,
                disable: false,
                organizationIds: new Set(pinned),
                scopes: new Set(Array.isArray(key.scopes) ? key.scopes : []),
            };
        }
        const user = await this.dataSource
            .getRepository(User)
            .findOne({ where: { id: ownerId }, select: ['id', 'tenantId'] });
        if (!user) return DENIED_FOR_GOOD;
        if (!user.tenantId) return DENIED_FOR_NOW;
        const orgs = await this.dataSource
            .getRepository(Organization)
            .find({ where: { tenantId: user.tenantId }, select: ['id'] });
        return { ok: true, disable: false, organizationIds: new Set(orgs.map((org) => org.id)) };
    }

    /**
     * {@link resolve} narrowed to one organization (`null`: no organization to
     * check, e.g. a test fire) and, with `eventType`, to the recipient scope
     * that type needs (EW-P3-1: `inbox.*` → `inbox:read`, `email.*` →
     * `email:read`): checked again right before each send, so a queued or
     * retried delivery is not sent after its key lost the scope.
     */
    async canReceive(
        sub: WebhookSubscription,
        organizationId: string | null,
        eventType?: string | null,
    ): Promise<{ allowed: boolean; disable: boolean }> {
        const access = await this.resolve(sub);
        if (!access.ok) return { allowed: false, disable: access.disable };
        const recipientScope = eventType ? recipientScopeForEventType(eventType) : null;
        if (recipientScope && !access.scopes?.has(recipientScope)) {
            return { allowed: false, disable: false };
        }
        if (organizationId === null) return { allowed: true, disable: false };
        return { allowed: access.organizationIds.has(organizationId), disable: false };
    }
}
