import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BillingProfile } from '@src/entities/billing-profile.entity';

/** Columns a caller may set when creating a profile lazily. */
export interface BillingProfileUpsert {
    userId: string;
    provider: string;
    providerCustomerId: string;
    organizationId?: string | null;
    tenantId?: string | null;
}

/** Default payment-method SUMMARY — display metadata only, never a PAN. */
export interface PaymentMethodSummaryWrite {
    defaultPaymentMethodRef: string | null;
    paymentMethodBrand?: string | null;
    paymentMethodLast4?: string | null;
    paymentMethodExpMonth?: number | null;
    paymentMethodExpYear?: number | null;
}

export interface AutoRechargeWrite {
    autoRechargeEnabled: boolean;
    autoRechargeThresholdCredits?: number | null;
    autoRechargePackId?: string | null;
}

/**
 * Billing profiles (billing PRD §5.3(3)).
 *
 * One row per user, created lazily at first checkout. Carries the
 * provider customer mapping, the default payment-method summary and the
 * auto-recharge settings + in-flight guard (see the entity header for
 * why auto-recharge state lives here rather than on the `credit_accounts`
 * table the PRD originally proposed — that entity was designed away).
 */
@Injectable()
export class BillingProfileRepository {
    constructor(
        @InjectRepository(BillingProfile)
        private readonly repository: Repository<BillingProfile>,
    ) {}

    findByUserId(userId: string): Promise<BillingProfile | null> {
        return this.repository.findOne({ where: { userId } });
    }

    findByCustomerId(provider: string, providerCustomerId: string): Promise<BillingProfile | null> {
        return this.repository.findOne({ where: { provider, providerCustomerId } });
    }

    /** Create-or-return; never overwrites an existing customer mapping. */
    async ensure(upsert: BillingProfileUpsert): Promise<BillingProfile> {
        const existing = await this.findByUserId(upsert.userId);
        if (existing) {
            return existing;
        }
        try {
            return await this.repository.save(
                this.repository.create({
                    userId: upsert.userId,
                    provider: upsert.provider,
                    providerCustomerId: upsert.providerCustomerId,
                    organizationId: upsert.organizationId ?? null,
                    tenantId: upsert.tenantId ?? null,
                    autoRechargeEnabled: false,
                    autoRechargeFailureCount: 0,
                }),
            );
        } catch (error) {
            // Concurrent first-checkout hit the UNIQUE(userId) index —
            // resolve to the surviving row instead of failing the buy.
            const concurrent = await this.findByUserId(upsert.userId);
            if (concurrent) {
                return concurrent;
            }
            throw error;
        }
    }

    async updatePaymentMethod(
        userId: string,
        summary: PaymentMethodSummaryWrite,
    ): Promise<BillingProfile | null> {
        await this.repository.update(
            { userId },
            {
                defaultPaymentMethodRef: summary.defaultPaymentMethodRef,
                paymentMethodBrand: summary.paymentMethodBrand ?? null,
                paymentMethodLast4: summary.paymentMethodLast4 ?? null,
                paymentMethodExpMonth: summary.paymentMethodExpMonth ?? null,
                paymentMethodExpYear: summary.paymentMethodExpYear ?? null,
            },
        );
        return this.findByUserId(userId);
    }

    async updateAutoRecharge(
        userId: string,
        settings: AutoRechargeWrite,
    ): Promise<BillingProfile | null> {
        await this.repository.update(
            { userId },
            {
                autoRechargeEnabled: settings.autoRechargeEnabled,
                autoRechargeThresholdCredits: settings.autoRechargeThresholdCredits ?? null,
                autoRechargePackId: settings.autoRechargePackId ?? null,
            },
        );
        return this.findByUserId(userId);
    }

    /**
     * Compare-and-set the in-flight guard: claims the slot ONLY when it is
     * currently free. Returns `true` when this caller won the claim — the
     * caller that gets `false` must not place a second off-session charge.
     *
     * This is the "auto-recharge triggers at threshold exactly once"
     * primitive: two concurrent debits both cross the threshold, both call
     * here, exactly one gets `true`.
     */
    async claimAutoRechargeSlot(userId: string, inFlightKey: string, now: Date): Promise<boolean> {
        const result = await this.repository
            .createQueryBuilder()
            .update(BillingProfile)
            .set({ autoRechargeInFlightKey: inFlightKey, autoRechargeInFlightAt: now })
            .where('userId = :userId', { userId })
            .andWhere('autoRechargeInFlightKey IS NULL')
            .execute();
        return (result.affected ?? 0) > 0;
    }

    /** Release the guard after the provider confirms (or rejects) the charge. */
    async releaseAutoRechargeSlot(userId: string): Promise<void> {
        await this.repository.update(
            { userId },
            { autoRechargeInFlightKey: null, autoRechargeInFlightAt: null },
        );
    }

    async recordAutoRechargeFailure(userId: string, now: Date): Promise<void> {
        await this.repository.increment({ userId }, 'autoRechargeFailureCount', 1);
        await this.repository.update(
            { userId },
            {
                autoRechargeInFlightKey: null,
                autoRechargeInFlightAt: null,
                autoRechargeLastFailureAt: now,
            },
        );
    }

    async resetAutoRechargeFailures(userId: string): Promise<void> {
        await this.repository.update(
            { userId },
            { autoRechargeFailureCount: 0, autoRechargeLastFailureAt: null },
        );
    }
}
