import { Module } from '@nestjs/common';
import { TitlerService } from './titler.service';

/**
 * Phase 3 PR I — TitlerModule (Missions/Ideas/Works build).
 *
 * Standalone module exposing `TitlerService` for any module that
 * needs to derive a short title from a longer prompt. Stateless
 * service with no DI dependencies in the heuristic implementation;
 * a future AI-backed override will inject `AiFacadeService`
 * directly inside the service file, not via this module.
 *
 * Consuming modules (Phase 3 PR I + follow-ups):
 *   - UserResearchModule (work-proposal.service uses it to title
 *     user-manual Ideas — replaces the inline `deriveTitle`
 *     placeholder from Phase 1 PR B).
 *   - MissionsModule (missions.service uses it when the caller's
 *     `title` is missing / empty).
 *   - Phase 3 PR J Mission tick worker module (titles spawned
 *     Ideas when the model output is verbose).
 *   - Phase 8 PR X Mission scaffolder (titles Missions auto-created
 *     from a Mission Template's defaultPrompt).
 */
@Module({
    providers: [TitlerService],
    exports: [TitlerService],
})
export class TitlerModule {}
