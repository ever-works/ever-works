import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { WorkspaceSearchService } from './workspace-search.service';

/**
 * Workspace search module (AW-01). Read-only; `DatabaseModule` makes the
 * TypeORM `DataSource` and every entity repository available to the live
 * fan-out. No schema of its own.
 */
@Module({
    imports: [DatabaseModule],
    providers: [WorkspaceSearchService],
    exports: [WorkspaceSearchService],
})
export class WorkspaceSearchModule {}
