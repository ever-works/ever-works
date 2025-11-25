import { Injectable } from '@nestjs/common';
import { config } from '@src/config';
import { UsageLedgerEntry } from '@src/entities/usage-ledger-entry.entity';

export abstract class BillingProvider {
    abstract getDefaultCurrency(): string;

    // Optional hook for forwarding charges to an external gateway.
    async recordUsageCharge(_entry: UsageLedgerEntry): Promise<void> {
        return;
    }
}

@Injectable()
export class ManualBillingProvider extends BillingProvider {
    getDefaultCurrency(): string {
        return config.billing.getDefaultCurrency();
    }
}
