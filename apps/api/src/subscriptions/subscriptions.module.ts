import { Module } from '@nestjs/common';
import { AuthModule } from '@src/auth';
import { SubscriptionsModule as AgentSubscriptionsModule } from '@ever-works/agent/subscriptions';
import { SubscriptionsController } from './subscriptions.controller';
import { CreditsController } from './credits.controller';

@Module({
    imports: [AuthModule, AgentSubscriptionsModule],
    // CreditsController (pricing Wave 9 M1) — read-only credits surface
    // beside the existing plan endpoints; consumed by the Wave 13 UI.
    controllers: [SubscriptionsController, CreditsController],
})
export class SubscriptionsModule {}
