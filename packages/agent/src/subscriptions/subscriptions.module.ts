import { Module } from '@nestjs/common';
import { DatabaseModule } from '@src/database/database.module';
import { SubscriptionService } from './subscription.service';
import { UsageLedgerService } from './usage-ledger.service';
import { BillingProvider, ManualBillingProvider } from './billing/billing.provider';

@Module({
    imports: [DatabaseModule],
    providers: [
        SubscriptionService,
        UsageLedgerService,
        { provide: BillingProvider, useClass: ManualBillingProvider },
    ],
    exports: [SubscriptionService, UsageLedgerService, BillingProvider],
})
export class SubscriptionsModule {}
