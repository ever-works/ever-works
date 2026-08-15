import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Skill } from '../entities/skill.entity';
import { SkillBinding } from '../entities/skill-binding.entity';
import { SkillFile } from '../entities/skill-file.entity';
import { Mission } from '../entities/mission.entity';
import { Agent } from '../entities/agent.entity';
import { WorkProposal } from '../entities/work-proposal.entity';
import { SkillRepository } from '../database/repositories/skill.repository';
import { SkillBindingRepository } from '../database/repositories/skill-binding.repository';
import { SkillFileRepository } from '../database/repositories/skill-file.repository';
import { SkillsService } from './skills.service';
import { SkillFilesService } from './skill-files.service';
import { AgentRepository } from '../database/repositories/agent.repository';
import { WorkProposalRepository } from '../user-research/work-proposal.repository';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { DatabaseModule } from '../database/database.module';
import { PolicyModule } from '../policy/policy.module';

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
        TypeOrmModule.forFeature([Skill, SkillBinding, SkillFile, Mission, Agent, WorkProposal]),
        ActivityLogModule,
        // Audit item G12 — grant-aware activation. Binds
        // TOOL_GRANT_ENFORCER for `SkillsService.resolveActiveForAgent`,
        // which is @Optional(): without this import the filter silently
        // never fires. PolicyModule is a leaf, so this cannot cycle.
        PolicyModule,
    ],
    providers: [
        SkillRepository,
        SkillBindingRepository,
        SkillFileRepository,
        AgentRepository,
        WorkProposalRepository,
        SkillsService,
        SkillFilesService,
    ],
    exports: [
        SkillRepository,
        SkillBindingRepository,
        SkillFileRepository,
        SkillsService,
        SkillFilesService,
    ],
})
export class SkillsModule {}
