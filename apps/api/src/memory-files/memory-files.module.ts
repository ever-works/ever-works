import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { KnowledgeBaseModule, MemoryFilesModule } from '@ever-works/agent/services';
import { OrganizationsModule } from '../organizations/organizations.module';
import { UploadsModule } from '../uploads/uploads.module';
import { MemoryFilesController } from './memory-files.controller';

/**
 * Memory Files — the /api/memory/files surface (unified file list +
 * folder tree CRUD + upload-into-folder + manual git sync + downloads).
 *
 * Wiring:
 *  - agent-side `MemoryFilesModule` provides the three services + the
 *    KB-upload / attachment-edge repositories the unified list reads;
 *  - `KnowledgeBaseModule` provides `KnowledgeBaseService` for KB
 *    original bytes (per-Work + the new org path);
 *  - `UploadsModule` provides `UploadsService` (validated multipart
 *    ingest + owner-gated byte reads for plain uploads);
 *  - `OrganizationsModule` provides `OrganizationMembershipService` for
 *    the org-original defense-in-depth gate;
 *  - `ScopeContextService` arrives via the `@Global()` ScopeModule.
 */
@Module({
    imports: [
        DatabaseModule,
        MemoryFilesModule,
        KnowledgeBaseModule,
        UploadsModule,
        OrganizationsModule,
    ],
    controllers: [MemoryFilesController],
})
export class MemoryFilesApiModule {}
