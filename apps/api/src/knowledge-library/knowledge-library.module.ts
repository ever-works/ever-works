import { Module } from '@nestjs/common';
import { DatabaseModule } from '@ever-works/agent/database';
import { KnowledgeLibraryModule } from '@ever-works/agent/services';
import { OrganizationsModule } from '../organizations/organizations.module';
import { KnowledgeLibraryController } from './knowledge-library.controller';

/**
 * Knowledge library — the `/api/knowledge` surface (the organization shelf,
 * its folder rail, filing, archive / restore and the
 * single-document Markdown export).
 *
 * Wiring:
 *  - agent-side `KnowledgeLibraryModule` provides `KnowledgeLibraryService`
 *    (over `KnowledgeBaseModule` + `MemoryFilesModule`);
 *  - `OrganizationsModule` provides `OrganizationMembershipService` for the
 *    membership gate;
 *  - `ScopeContextService` arrives via the `@Global()` ScopeModule.
 */
@Module({
    imports: [DatabaseModule, KnowledgeLibraryModule, OrganizationsModule],
    controllers: [KnowledgeLibraryController],
})
export class KnowledgeLibraryApiModule {}
