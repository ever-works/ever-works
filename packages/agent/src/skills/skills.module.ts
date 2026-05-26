import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Skill } from '../entities/skill.entity';
import { SkillBinding } from '../entities/skill-binding.entity';
import { SkillRepository } from '../database/repositories/skill.repository';
import { SkillBindingRepository } from '../database/repositories/skill-binding.repository';
import { SkillsService } from './skills.service';
import { ActivityLogModule } from '../activity-log/activity-log.module';

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
    imports: [TypeOrmModule.forFeature([Skill, SkillBinding]), ActivityLogModule],
    providers: [SkillRepository, SkillBindingRepository, SkillsService],
    exports: [SkillRepository, SkillBindingRepository, SkillsService],
})
export class SkillsModule {}
