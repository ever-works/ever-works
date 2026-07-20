import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentActionProposal } from '../entities/agent-action-proposal.entity';
import { Agent } from '../entities/agent.entity';
import { AgentApprovalsService } from './agent-approvals.service';

/**
 * Agent Action Approval Queue — the agent-side module that owns the
 * `AgentActionProposal` entity + service surface. The api-side
 * `apps/api/src/agent-approvals/AgentApprovalsModule` imports this one
 * and mounts the controller. Mirrors the structure of the agent-side
 * Agents module.
 *
 * `Agent` is registered here (raw repository) only for the ownership
 * check in `createProposal`.
 */
@Module({
    imports: [TypeOrmModule.forFeature([AgentActionProposal, Agent])],
    providers: [AgentApprovalsService],
    exports: [AgentApprovalsService],
})
export class AgentApprovalsModule {}
