import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { AuthModule } from '../auth/auth.module';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';
import { WebhookSecretService } from './webhook-secret.service';

@Module({
    imports: [DatabaseModule, AuthModule],
    controllers: [WebhooksController],
    providers: [WebhooksService, WebhookSecretService],
    exports: [WebhooksService, WebhookSecretService],
})
export class WebhooksModule {}
