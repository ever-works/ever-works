import { Module } from '@nestjs/common';
import { SkillsModule as AgentSkillsModule } from '@ever-works/agent/skills';
import { FacadesModule } from '@ever-works/agent/facades';
import { DatabaseModule } from '@ever-works/agent/database';
import { SkillsController } from './skills.controller';
import { SkillBindingsController } from './skill-bindings.controller';
import { SkillFileContentReaderService } from './skill-file-content-reader.service';
import { UploadsModule } from '../uploads/uploads.module';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 8.7 + Phase 9. API-side
 * Skills module. Imports the agent-side data module (now with
 * SkillsService + SkillFilesService for write paths) + the facade
 * module and mounts:
 *
 *   - SkillsController         — /api/skills/* (read + write + files)
 *   - SkillBindingsController  — /api/skill-bindings/:id (delete)
 *
 * Skill files feature: UploadsModule supplies UploadsService (the
 * storage spine the file bytes live behind) and DatabaseModule the
 * `user_uploads` ownership index; SkillFileContentReaderService is
 * the uploads-spine adapter behind the content endpoint AND the
 * agent-side `getSkillFile` tool (the @Global api AgentsModule binds
 * it to the SKILL_FILE_CONTENT_READER token — exported here so that
 * `useExisting` can resolve it).
 */
@Module({
    imports: [AgentSkillsModule, FacadesModule, DatabaseModule, UploadsModule],
    controllers: [SkillsController, SkillBindingsController],
    providers: [SkillFileContentReaderService],
    exports: [SkillFileContentReaderService],
})
export class SkillsModule {}
