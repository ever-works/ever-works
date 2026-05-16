import { Module } from '@nestjs/common';
import { TriggerInternalController } from './trigger-internal.controller';
import { WorkOperationsModule } from '@ever-works/agent/work-operations';
import { WorkModule } from '@ever-works/agent/services';
import { NotificationsModule } from '@ever-works/agent/notifications';
import { FacadesModule } from '@ever-works/agent/facades';
import { WorkProposalsModule } from '../work-proposals/work-proposals.module';
import { DataSyncModule } from '../data-sync/data-sync.module';

@Module({
    imports: [
        WorkOperationsModule,
        WorkModule,
        NotificationsModule,
        FacadesModule,
        WorkProposalsModule,
        // EW-628 G7 — exposes DataSyncDispatcherService through the
        // remote-proxy controller so the Trigger.dev worker can call it
        // each cron tick without importing the full API stack.
        DataSyncModule,
    ],
    controllers: [TriggerInternalController],
})
export class TriggerInternalModule {}
