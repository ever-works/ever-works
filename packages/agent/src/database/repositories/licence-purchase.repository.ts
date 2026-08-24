import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LicencePurchase, LicencePurchaseStatus } from '@src/entities/licence-purchase.entity';

export interface LicencePurchaseWrite {
    userId: string;
    planCode: string;
    provider: string;
    providerPaymentId: string;
    amountCents: number;
    currency: string;
}

@Injectable()
export class LicencePurchaseRepository {
    constructor(
        @InjectRepository(LicencePurchase)
        private readonly repository: Repository<LicencePurchase>,
    ) {}

    findActiveByUserAndPlan(userId: string, planCode: string): Promise<LicencePurchase | null> {
        return this.repository.findOne({
            where: { userId, planCode, status: LicencePurchaseStatus.ACTIVE },
            order: { createdAt: 'DESC' },
        });
    }

    async listActivePlanCodes(userId: string): Promise<string[]> {
        const rows = await this.repository.find({
            where: { userId, status: LicencePurchaseStatus.ACTIVE },
            order: { createdAt: 'ASC' },
        });
        return [...new Set(rows.map((row) => row.planCode))];
    }

    countByUserAndPlan(userId: string, planCode: string): Promise<number> {
        return this.repository.count({ where: { userId, planCode } });
    }

    /**
     * Provider-event idempotency: webhook replay and return-route sync both
     * carry the same payment id and converge on the same row. A previously
     * refunded row is returned unchanged; replay must never reactivate it.
     */
    async recordPurchase(write: LicencePurchaseWrite): Promise<LicencePurchase> {
        const existing = await this.repository.findOne({
            where: {
                provider: write.provider,
                providerPaymentId: write.providerPaymentId,
            },
        });
        if (existing) return existing;

        try {
            return await this.repository.save(
                this.repository.create({
                    ...write,
                    status: LicencePurchaseStatus.ACTIVE,
                    refundedAt: null,
                }),
            );
        } catch (error) {
            // Two app instances can race the webhook against the checkout
            // return. Only the provider-payment UNIQUE constraint is expected;
            // re-read and return its winner instead of surfacing a false 500.
            const raced = await this.repository.findOne({
                where: {
                    provider: write.provider,
                    providerPaymentId: write.providerPaymentId,
                },
            });
            if (raced) return raced;
            throw error;
        }
    }
}
