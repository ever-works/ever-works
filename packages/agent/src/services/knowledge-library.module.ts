import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { DatabaseModule } from '../database/database.module';
import { KnowledgeDocumentReaderState } from '../entities/knowledge-document-reader-state.entity';
import { KnowledgeDocumentReaderStateRepository } from '../database/repositories/knowledge-document-reader-state.repository';
import { KnowledgeBaseModule } from './knowledge-base.module';
import { MemoryFilesModule } from './memory-files.module';
import { KnowledgeLibraryService } from './knowledge-library.service';
import { WorkOwnershipService } from './work-ownership.service';

/**
 * Knowledge library — the organization shelf over the Knowledge Base.
 *
 * A composition module rather than more providers on `KnowledgeBaseModule`:
 * the library needs the Knowledge Base (documents, archive / restore) AND
 * the folder tree (`MemoryFilesModule`), and neither of those modules should
 * import the other. Importing both here keeps the graph acyclic.
 *
 *  - `KnowledgeBaseModule` exports `KnowledgeBaseService` and
 *    `WorkKnowledgeDocumentRepository`;
 *  - `MemoryFilesModule` exports `MemoryFoldersService`;
 *  - `DatabaseModule` provides `WorkRepository` / `WorkMemberRepository`
 *    (for `WorkOwnershipService`, stateless, provided here the same way
 *    `KnowledgeBaseModule` provides its own instance);
 *  - `ActivityLogModule` so the `@Optional()` activity writer resolves.
 *
 * The reader-state repository is registered and exported now so the table
 * this phase migrates has its persistence seam in place for read state and
 * pins.
 */
@Module({
    imports: [
        DatabaseModule,
        ActivityLogModule,
        KnowledgeBaseModule,
        MemoryFilesModule,
        TypeOrmModule.forFeature([KnowledgeDocumentReaderState]),
    ],
    providers: [
        WorkOwnershipService,
        KnowledgeDocumentReaderStateRepository,
        KnowledgeLibraryService,
    ],
    exports: [KnowledgeLibraryService, KnowledgeDocumentReaderStateRepository],
})
export class KnowledgeLibraryModule {}
