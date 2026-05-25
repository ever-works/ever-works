import { Module } from '@nestjs/common';
import { SkillsModule as AgentSkillsModule } from '@ever-works/agent/skills';
import { FacadesModule } from '@ever-works/agent/facades';
import { SkillsController } from './skills.controller';
import { SkillBindingsController } from './skill-bindings.controller';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 8.7 + Phase 9. API-side
 * Skills module. Imports the agent-side data module (now with
 * SkillsService for write paths) + the facade module and mounts:
 *
 *   - SkillsController         — /api/skills/* (read + write)
 *   - SkillBindingsController  — /api/skill-bindings/:id (delete)
 */
@Module({
	imports: [AgentSkillsModule, FacadesModule],
	controllers: [SkillsController, SkillBindingsController],
})
export class SkillsModule {}
