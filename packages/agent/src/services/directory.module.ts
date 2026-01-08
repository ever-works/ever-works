import { Module } from '@nestjs/common';
import { DataGeneratorModule } from '../data-generator/data-generator.module';
import { ItemsGeneratorModule } from '../items-generator/items-generator.module';
import { GitModule } from '../git/git.module';
import { MarkdownGeneratorModule } from '../markdown-generator/markdown-generator.module';
import { WebsiteGeneratorModule } from '../website-generator/website-generator.module';
import { DeployModule } from '../deploy/deploy.module';
import { DatabaseModule } from '../database/database.module';
import { AiModule } from '../ai/ai.module';
import { ImportModule } from '../import/import.module';
import { DirectoryDetailService } from './directory-detail.service';
import { DirectoryOwnershipService } from './directory-ownership.service';
import { DirectoryQueryService } from './directory-query.service';
import { DirectoryLifecycleService } from './directory-lifecycle.service';
import { DirectoryGenerationService } from './directory-generation.service';
import { DirectoryScheduleService } from './directory-schedule.service';
import { DirectoryScheduleDispatcherService } from './directory-schedule-dispatcher.service';
import { DirectoryMemberService } from './directory-member.service';
import { DirectoryImportService } from './directory-import.service';
import { SubscriptionsModule } from '@src/subscriptions';
import { RepositoryManagementService } from './repository-management.service';

@Module({
    imports: [
        DatabaseModule,
        DataGeneratorModule,
        ItemsGeneratorModule,
        GitModule,
        MarkdownGeneratorModule,
        WebsiteGeneratorModule,
        DeployModule,
        AiModule,
        ImportModule,
        SubscriptionsModule,
    ],
    providers: [
        DirectoryOwnershipService,
        DirectoryQueryService,
        DirectoryLifecycleService,
        DirectoryGenerationService,
        DirectoryDetailService,
        DirectoryScheduleService,
        DirectoryScheduleDispatcherService,
        DirectoryMemberService,
        DirectoryImportService,
        RepositoryManagementService,
    ],
    exports: [
        DirectoryOwnershipService,
        DirectoryQueryService,
        DirectoryLifecycleService,
        DirectoryGenerationService,
        DirectoryDetailService,
        DirectoryScheduleService,
        DirectoryScheduleDispatcherService,
        DirectoryMemberService,
        DirectoryImportService,
        RepositoryManagementService,
    ],
})
export class DirectoryModule {}
