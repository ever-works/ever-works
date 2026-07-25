import { Module } from '@nestjs/common';
import { DatabaseModule } from '@src/database/database.module';
import { SubscriptionService } from './subscription.service';
import { UsageLedgerService } from './usage-ledger.service';
import { BillingProvider, ManualBillingProvider } from './billing/billing.provider';
import { CreditLedgerService } from './credits/credit-ledger.service';
import { EntitlementsService } from './credits/entitlements.service';

@Module({
    imports: [DatabaseModule],
    providers: [
        SubscriptionService,
        UsageLedgerService,
        // Credits ledger + plan entitlements (pricing Wave 9 M1) —
        // additive beside the existing plan/usage-ledger services.
        CreditLedgerService,
        EntitlementsService,
        { provide: BillingProvider, useClass: ManualBillingProvider },
    ],
    exports: [
        SubscriptionService,
        UsageLedgerService,
        CreditLedgerService,
        EntitlementsService,
        BillingProvider,
    ],
})
export class SubscriptionsModule {}
