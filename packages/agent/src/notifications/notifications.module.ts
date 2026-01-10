import { Module } from '@nestjs/common';
import { DatabaseModule } from '@src/database/database.module';
import { NotificationService } from './notification.service';

@Module({
    imports: [DatabaseModule],
    providers: [NotificationService],
    exports: [NotificationService],
})
export class NotificationsModule {}
