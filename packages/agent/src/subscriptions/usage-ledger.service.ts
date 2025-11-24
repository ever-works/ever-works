import { Injectable } from '@nestjs/common';
import { UsageLedgerRepository } from '@src/database/repositories/usage-ledger.repository';
import { DirectorySchedule } from '@src/entities/directory-schedule.entity';
import { UsageLedgerEntry, UsageLedgerTriggerType } from '@src/entities/usage-ledger-entry.entity';
import { config } from '@src/config';
import { DirectoryScheduleBillingMode } from '@src/entities';
import { BillingProvider } from './billing/billing.provider';

type RecordUsageOptions = {
    userId: string;
    directoryId: string;
    schedule?: DirectorySchedule | null;
    triggerType: UsageLedgerTriggerType;
    billingMode: DirectoryScheduleBillingMode;
    generationHistoryId?: string;
};

@Injectable()
export class UsageLedgerService {
    constructor(
        private readonly ledgerRepository: UsageLedgerRepository,
        private readonly billingProvider: BillingProvider,
    ) {}

    async recordUsage(options: RecordUsageOptions): Promise<UsageLedgerEntry | null> {
        if (options.billingMode !== DirectoryScheduleBillingMode.USAGE) {
            return null;
        }

        const amountCents = config.subscriptions.getPayPerUsePriceCents();

        const entry = await this.ledgerRepository.record({
            userId: options.userId,
            directoryId: options.directoryId,
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
