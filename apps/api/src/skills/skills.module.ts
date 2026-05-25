import { Module } from '@nestjs/common';
import { SkillsModule as AgentSkillsModule } from '@ever-works/agent/skills';
import { FacadesModule } from '@ever-works/agent/facades';
import { SkillsController } from './skills.controller';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 8.7. API-side Skills module.
 * Imports the agent-side data module + the facade module and mounts
 * the read-only controller.
 *
 * Write paths (POST/PATCH/DELETE) ship with Phase 9 once SkillsService
 * lands.
 */
@Module({
	imports: [AgentSkillsModule, FacadesModule],
	controllers: [SkillsController],
})
export class SkillsModule {}
