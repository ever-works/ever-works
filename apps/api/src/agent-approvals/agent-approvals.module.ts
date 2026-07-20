import { Module } from '@nestjs/common';
import { AgentApprovalsModule as AgentAgentApprovalsModule } from '@ever-works/agent/agent-approvals';
import { AuthModule } from '../auth/auth.module';
import { AgentApprovalsController } from './agent-approvals.controller';

/**
 * Agent Action Approval Queue — api-side module. Mounts the
 * controller; defers to the agent-side `AgentApprovalsModule` for the
 * service + entity + repositories. Mirrors the api-side AgentsModule /
 * TasksModule structure.
 */
@Module({
    imports: [AgentAgentApprovalsModule, AuthModule],
    controllers: [AgentApprovalsController],
})
export class AgentApprovalsModule {}
