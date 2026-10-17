import { Module } from '@nestjs/common';
import { RecordVisibilityModule as AgentRecordVisibilityModule } from '@ever-works/agent/record-visibility';
import { AuthModule } from '../auth/auth.module';
import { RecordVisibilityController } from './record-visibility.controller';

/**
 * Record visibility (EW-P1-3) — api-side module exposing `/api/record-visibility`, the
 * visibility control behind the task, goal, mission, idea and agent forms. The policy
 * and the write rules live in the agent-side {@link AgentRecordVisibilityModule}.
 */
@Module({
    imports: [AgentRecordVisibilityModule, AuthModule],
    controllers: [RecordVisibilityController],
})
export class RecordVisibilityApiModule {}
