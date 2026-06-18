import { Module } from '@nestjs/common';
import { AccountTransferModule } from '@ever-works/agent/account-transfer';
import { AccountController } from './account.controller';
import { TenantJobRuntimeModule } from './tenant-job-runtime/tenant-job-runtime.module';

/**
 * Account-scoped APIs. Wires the legacy AccountController (export /
 * import / GitHub sync) plus the EW-742 P2.0 tenant-job-runtime overlay
 * admin surface (`/api/account/job-runtime/...`).
 */
@Module({
    imports: [AccountTransferModule, TenantJobRuntimeModule],
    controllers: [AccountController],
})
export class AccountModule {}
