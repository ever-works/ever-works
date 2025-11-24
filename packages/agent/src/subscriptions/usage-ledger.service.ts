import { Injectable } from '@nestjs/common';
import { UsageLedgerRepository } from '@src/database/repositories/usage-ledger.repository';
import { DirectorySchedule } from '@src/entities/directory-schedule.entity';
import { UsageLedgerEntry, UsageLedgerTriggerType } from '@src/entities/usage-ledger-entry.entity';
import { config } from '@src/config';
import { DirectoryScheduleBillingMode } from '@src/entities';

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
    constructor(private readonly ledgerRepository: UsageLedgerRepository) {}

    async recordUsage(options: RecordUsageOptions): Promise<UsageLedgerEntry | null> {
        if (options.billingMode !== DirectoryScheduleBillingMode.USAGE) {
            return null;
        }

        const amountCents = config.subscriptions.getPayPerUsePriceCents();

        return this.ledgerRepository.record({
            userId: options.userId,
            directoryId: options.directoryId,
            scheduleId: options.schedule?.id,
            triggerType: options.triggerType,
            billingMode: options.billingMode,
            units: 1,
            amountCents,
            currency: options.schedule?.initiatedBySubscription?.plan?.currency || 'usd',
            generationHistoryId: options.generationHistoryId,
            metadata: {
                cadence: options.schedule?.cadence,
            },
        });
    }
}
