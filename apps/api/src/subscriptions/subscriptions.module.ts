import { Module } from '@nestjs/common';
import { AuthModule } from '@src/auth';
import { SubscriptionsModule as AgentSubscriptionsModule } from '@ever-works/agent/subscriptions';
import { SubscriptionsController } from './subscriptions.controller';

@Module({
    imports: [AuthModule, AgentSubscriptionsModule],
    controllers: [SubscriptionsController],
})
export class SubscriptionsModule {}
