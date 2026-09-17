import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AgentActionProposal } from '../entities/agent-action-proposal.entity';
import { Agent } from '../entities/agent.entity';
import { AgentApprovalsService } from './agent-approvals.service';
import { SafetyModule } from '../safety/safety.module';

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
    // Safety rails (AW-24) — `SafetyModule` supplies `AutonomyGrantService`,
    // which `createProposal` folds into the guardrail decision (stricter
    // wins). It is a leaf module over its own three tables, so importing it
    // here adds no runtime coupling beyond those.
    imports: [TypeOrmModule.forFeature([AgentActionProposal, Agent]), SafetyModule],
    providers: [AgentApprovalsService],
    exports: [AgentApprovalsService, SafetyModule],
})
export class AgentApprovalsModule {}
