import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Skill } from '../entities/skill.entity';
import { SkillBinding } from '../entities/skill-binding.entity';
import { SkillRepository } from '../database/repositories/skill.repository';
import { SkillBindingRepository } from '../database/repositories/skill-binding.repository';

/**
 * Skills feature — Phase 8.
 *
 * The agent-side module that owns the Skill / SkillBinding data
 * surface. The API-side `apps/api/src/skills/SkillsModule` imports
 * this one + the facades + mounts the controller.
 *
 * Service layer (SkillsService for CRUD / install / mutation) lands
 * in Phase 9 — the controller in Phase 8 calls the repository
 * directly for the read-only endpoints (GET /skills, GET /skills/:id,
 * GET /skills/catalog). Phase 9 wires write paths through
 * SkillsService.
 */
@Module({
	imports: [TypeOrmModule.forFeature([Skill, SkillBinding])],
	providers: [SkillRepository, SkillBindingRepository],
	exports: [SkillRepository, SkillBindingRepository],
})
export class SkillsModule {}
