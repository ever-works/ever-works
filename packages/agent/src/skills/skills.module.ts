import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Skill } from '../entities/skill.entity';
import { SkillBinding } from '../entities/skill-binding.entity';
import { Mission } from '../entities/mission.entity';
import { Agent } from '../entities/agent.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { SkillRepository } from '../database/repositories/skill.repository';
import { SkillBindingRepository } from '../database/repositories/skill-binding.repository';
import { AgentRepository } from '../database/repositories/agent.repository';
import { WorkProposalRepository } from '../user-research/work-proposal.repository';
import { SkillsService } from './skills.service';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { DatabaseModule } from '../database/database.module';

/**
 * Skills feature — Phase 8 + 9.
 *
 * The agent-side module that owns the Skill / SkillBinding data
 * surface. The API-side `apps/api/src/skills/SkillsModule` imports
 * this one + the facades + mounts the controller.
 *
 * Phase 9 adds SkillsService for CRUD / catalog install / bindings
 * management — wired into ActivityLogModule for the SKILL_INSTALLED
 * + SKILL_ATTACHED_TO_AGENT events.
 */
@Module({
    imports: [
        DatabaseModule,
        TypeOrmModule.forFeature([Skill, SkillBinding, Mission, Agent, WorkProposal]),
        ActivityLogModule,
    ],
    providers: [
        SkillRepository,
        SkillBindingRepository,
        AgentRepository,
        WorkProposalRepository,
        SkillsService,
    ],
    exports: [SkillRepository, SkillBindingRepository, SkillsService],
})
export class SkillsModule {}
