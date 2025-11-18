import { Module } from '@nestjs/common';
import { DatabaseModule } from '@src/database/database.module';
import { SubscriptionService } from './subscription.service';
import { UsageLedgerService } from './usage-ledger.service';

@Module({
    imports: [DatabaseModule],
    providers: [SubscriptionService, UsageLedgerService],
    exports: [SubscriptionService, UsageLedgerService],
})
export class SubscriptionsModule {}
