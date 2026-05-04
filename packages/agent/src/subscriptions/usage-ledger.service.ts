import { Injectable } from '@nestjs/common';
import { UsageLedgerRepository } from '@src/database/repositories/usage-ledger.repository';
import { WorkSchedule } from '@src/entities/work-schedule.entity';
import { UsageLedgerEntry, UsageLedgerTriggerType } from '@src/entities/usage-ledger-entry.entity';
import { config } from '@src/config';
import { WorkScheduleBillingMode } from '@src/entities';
import { BillingProvider } from './billing/billing.provider';

type RecordUsageOptions = {
    userId: string;
    workId: string;
    schedule?: WorkSchedule | null;
    triggerType: UsageLedgerTriggerType;
    billingMode: WorkScheduleBillingMode;
    generationHistoryId?: string;
};

@Injectable()
export class UsageLedgerService {
    constructor(
        private readonly ledgerRepository: UsageLedgerRepository,
        private readonly billingProvider: BillingProvider,
    ) {}

    async recordUsage(options: RecordUsageOptions): Promise<UsageLedgerEntry | null> {
        if (
            !config.subscriptions.isEnabled() ||
            options.billingMode !== WorkScheduleBillingMode.USAGE
        ) {
            return null;
        }

        const amountCents = config.subscriptions.getPayPerUsePriceCents();

        const entry = await this.ledgerRepository.record({
            userId: options.userId,
            workId: options.workId,
            scheduleId: options.schedule?.id,
            triggerType: options.triggerType,
            billingMode: options.billingMode,
            units: 1,
            amountCents,
            currency: this.billingProvider.getDefaultCurrency(),
            generationHistoryId: options.generationHistoryId,
            metadata: {
                cadence: options.schedule?.cadence,
            },
        });

        await this.billingProvider.recordUsageCharge(entry);
        return entry;
    }
}
