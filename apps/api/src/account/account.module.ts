import { Module } from '@nestjs/common';
import { AccountTransferModule } from '@ever-works/agent/account-transfer';
import { AccountController } from './account.controller';

@Module({
	imports: [AccountTransferModule],
	controllers: [AccountController],
})
export class AccountModule {}
