import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import {
    WebhookSubscription,
    type WebhookSubscriptionOwnerType,
} from '../../entities/webhook-subscription.entity';
@Injectable()
export class WebhookSubscriptionRepository {
    constructor(
        @InjectRepository(WebhookSubscription)
        private readonly repository: Repository<WebhookSubscription>,
    ) {}

    async createForAccount(data: {
        accountId: string;
        workId?: string | null;
        url: string;
        secretEncrypted: string;
    }): Promise<WebhookSubscription> {
        const row = this.repository.create({
            accountId: data.accountId,
            workId: data.workId ?? null,
            url: data.url,
            secretEncrypted: data.secretEncrypted,
            status: 'active',
            consecutiveFailures: 0,
        });
        return this.repository.save(row);
    }

    async listActiveForWork(workId: string, accountId?: string): Promise<WebhookSubscription[]> {
        // Security: when an accountId is supplied, scope BOTH arms of the OR to
        // that account so the account-wide (workId IS NULL) branch can no longer
        // pull every tenant's active subscriptions into memory. Callers that pass
        // accountId get tenant isolation enforced at the DB instead of relying on
        // a fragile post-query filter. Omitting accountId preserves the legacy
        // behaviour (and exact query shape) for existing callers.
        if (accountId) {
            return this.repository.find({
                where: [
                    { workId, accountId, status: 'active' },
                    { workId: null as unknown as string, accountId, status: 'active' },
                ],
            });
        }
        return this.repository.find({
            where: [
                { workId, status: 'active' },
                { workId: null as unknown as string, status: 'active' },
            ],
        });
    }

    async listActiveForAccount(accountId: string): Promise<WebhookSubscription[]> {
        return this.repository.find({ where: { accountId, status: 'active' } });
    }

    // ── Webhooks v2 (EW-P1-5) ───────────────────────────────────────────────

    /** Create a v2 (domain event) subscription. */
    async createV2(data: {
        accountId: string;
        ownerType: WebhookSubscriptionOwnerType;
        ownerId: string;
        url: string;
        secretEncrypted: string;
        events: string[];
        organizationIds: string[];
        excludeOriginTags: string[];
        description: string | null;
        tenantId?: string | null;
        organizationId?: string | null;
        /** The change-feed head at creation (only later events are delivered). */
        startAfterSeq?: string | null;
    }): Promise<WebhookSubscription> {
        const row = this.repository.create({
            accountId: data.accountId,
            workId: null,
            url: data.url,
            secretEncrypted: data.secretEncrypted,
            status: 'active',
            consecutiveFailures: 0,
            version: 2,
            ownerType: data.ownerType,
            ownerId: data.ownerId,
            events: data.events,
            organizationIds: data.organizationIds,
            excludeOriginTags: data.excludeOriginTags,
            description: data.description,
            startAfterSeq: data.startAfterSeq ?? null,
            tenantId: data.tenantId ?? null,
            organizationId: data.organizationId ?? null,
        });
        return this.repository.save(row);
    }

    /** Every subscription of an account, whatever its status (Settings lists paused / failed ones too). */
    async listForAccount(accountId: string): Promise<WebhookSubscription[]> {
        return this.repository.find({ where: { accountId }, order: { createdAt: 'ASC' } });
    }

    /** The subscriptions of one owner (e.g. an integration key), whatever their status. */
    async listForOwner(
        ownerType: WebhookSubscriptionOwnerType,
        ownerId: string,
    ): Promise<WebhookSubscription[]> {
        return this.repository.find({
            where: { ownerType, ownerId, version: 2 },
            order: { createdAt: 'ASC' },
        });
    }

    /** Active v2 subscriptions — the domain-event fan-out's candidates. */
    async listActiveV2(): Promise<WebhookSubscription[]> {
        return this.repository.find({ where: { version: 2, status: 'active' } });
    }

    /**
     * Resume a paused / failed subscription: active again, failure streak
     * reset. Never touches a `disabled` one (its owner lost access).
     */
    async resume(id: string): Promise<boolean> {
        const result = await this.repository.update(
            { id, status: In(['paused', 'failed', 'active']) },
            { status: 'active', consecutiveFailures: 0 },
        );
        return (result.affected ?? 0) > 0;
    }

    /** The owner lost access (key revoked, membership gone): stop delivering until re-enabled. */
    async markDisabled(id: string): Promise<void> {
        await this.repository.update(id, { status: 'disabled' });
    }

    /** Disable every v2 subscription of one owner (e.g. its integration key was revoked). */
    async disableForOwner(
        ownerType: WebhookSubscriptionOwnerType,
        ownerId: string,
    ): Promise<number> {
        const result = await this.repository.update(
            { ownerType, ownerId, version: 2, status: In(['active', 'paused', 'failed']) },
            { status: 'disabled' },
        );
        return result.affected ?? 0;
    }

    /** Update the v2 filters / target of a subscription (PATCH). */
    async updateV2(
        id: string,
        patch: Partial<
            Pick<
                WebhookSubscription,
                | 'url'
                | 'events'
                | 'organizationIds'
                | 'excludeOriginTags'
                | 'description'
                | 'organizationId'
                | 'tenantId'
            >
        >,
    ): Promise<void> {
        if (Object.keys(patch).length === 0) return;
        await this.repository.update(id, patch);
    }

    async markSuccess(id: string): Promise<void> {
        await this.repository.update(id, {
            consecutiveFailures: 0,
            lastDeliveryAt: new Date(),
        });
    }

    async incrementFailure(id: string): Promise<number> {
        await this.repository.increment({ id }, 'consecutiveFailures', 1);
        const row = await this.repository.findOne({ where: { id } });
        return row?.consecutiveFailures ?? 0;
    }

    async markFailed(id: string): Promise<void> {
        await this.repository.update(id, { status: 'failed', lastDeliveryAt: new Date() });
    }

    async pause(id: string): Promise<void> {
        // A `disabled` subscription stays disabled: pausing it must not turn it
        // into something PATCH status=active can resume.
        await this.repository.update({ id, status: Not('disabled') }, { status: 'paused' });
    }

    async updateSecret(
        id: string,
        secretEncrypted: string,
        previous?: { secretEncrypted: string | null; expiresAt: Date | null },
    ): Promise<void> {
        if (!previous) {
            await this.repository.update(id, { secretEncrypted });
            return;
        }
        // v2 rotation: the old secret keeps signing (as a second `v1=`) until `expiresAt`.
        await this.repository.update(id, {
            secretEncrypted,
            previousSecretEncrypted: previous.secretEncrypted,
            previousSecretExpiresAt: previous.expiresAt,
        });
    }

    async delete(id: string, accountId?: string): Promise<void> {
        // Security: defence-in-depth ownership guard. When an accountId is
        // supplied the delete is scoped to { id, accountId } so a caller can
        // never remove another tenant's subscription by supplying an arbitrary
        // UUID, even if the service-layer ownership check is bypassed. Omitting
        // accountId preserves the existing by-id behaviour for current callers.
        await this.repository.delete(accountId ? { id, accountId } : id);
    }

    async findById(id: string): Promise<WebhookSubscription | null> {
        return this.repository.findOne({ where: { id } });
    }
}
