import { Module } from '@nestjs/common';
import { WorkAgentModule as AgentWorkAgentModule } from '@ever-works/agent/work-agent';
import { AuthModule } from '../auth/auth.module';
import { WorkAgentController } from './work-agent.controller';

@Module({
    imports: [AuthModule, AgentWorkAgentModule],
    controllers: [WorkAgentController],
})
export class WorkAgentModule {}
