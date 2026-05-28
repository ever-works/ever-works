import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { FacadesModule } from '@ever-works/agent/facades';
import { AuthModule } from '@src/auth';
import { NotificationChannelsController } from './notification-channels.controller';
import { NotificationChannelsService } from './notification-channels.service';

/**
 * EW-663 / EW-673 — Notification Channels module wiring.
 * Consumes NotificationChannelFacadeService from FacadesModule and the
 * notification_channels repository from DatabaseModule.
 */
@Module({
    imports: [DatabaseModule, FacadesModule, AuthModule],
    controllers: [NotificationChannelsController],
    providers: [NotificationChannelsService],
    exports: [NotificationChannelsService],
})
export class NotificationChannelsModule {}
