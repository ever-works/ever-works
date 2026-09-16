import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { DatabaseModule } from '../database/database.module';
import { SharedView } from '../entities/shared-view.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { TasksDomainModule } from '../tasks-domain/tasks.module';
import { SharedViewProjectionService } from './shared-view-projection.service';
import { SharedViewRepository } from './shared-view.repository';
import { SharedViewService } from './shared-view.service';

/**
 * Shared view — the domain module behind publishing a Workspace's read-only
 * view: the Shared view row and its token, the owner-side lifecycle, and the
 * live projection a share link reads.
 *
 * It sits ON the Task board rather than beside it: the projection reads
 * `TaskBoardService` (TasksDomainModule) and the Live Feed read model
 * (ActivityLogModule) and adds nothing to either module's graph, so the
 * private board is unchanged whether or not anyone ever publishes it.
 *
 * `SharedView` is also registered in `database/_entities-inventory.ts`.
 */
@Module({
    imports: [
        TypeOrmModule.forFeature([SharedView]),
        DatabaseModule,
        TasksDomainModule,
        ActivityLogModule,
        NotificationsModule,
    ],
    providers: [SharedViewRepository, SharedViewService, SharedViewProjectionService],
    exports: [SharedViewRepository, SharedViewService, SharedViewProjectionService],
})
export class SharedViewsModule {}
