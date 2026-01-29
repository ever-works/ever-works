import { Module } from '@nestjs/common';
import { DataGeneratorModule } from '../generators/data-generator/data-generator.module';
import { ItemsGeneratorModule } from '../items-generator/items-generator.module';
import { GitModule } from '../git/git.module';
import { MarkdownGeneratorModule } from '../generators/markdown-generator/markdown-generator.module';
import { WebsiteGeneratorModule } from '../generators/website-generator/website-generator.module';
import { DeployModule } from '../deploy/deploy.module';
import { DatabaseModule } from '../database/database.module';
import { AiModule } from '../ai/ai.module';
import { ImportModule } from '../import/import.module';
import { ScreenshotModule } from '../screenshot/screenshot.module';
import { DirectoryDetailService } from './directory-detail.service';
import { DirectoryOwnershipService } from './directory-ownership.service';
import { DirectoryQueryService } from './directory-query.service';
import { DirectoryLifecycleService } from './directory-lifecycle.service';
import { DirectoryGenerationService } from './directory-generation.service';
import { DirectoryScheduleService } from './directory-schedule.service';
import { DirectoryScheduleDispatcherService } from './directory-schedule-dispatcher.service';
import { DirectoryMemberService } from './directory-member.service';
import { DirectoryImportService } from './directory-import.service';
import { DirectoryAdvancedPromptsService } from './directory-advanced-prompts.service';
import { DirectoryTaxonomyService } from './directory-taxonomy.service';
import { GeneratorFormSchemaService } from './generator-form-schema.service';
import { SubscriptionsModule } from '@src/subscriptions';
import { RepositoryManagementService } from './repository-management.service';
import { PluginsModule } from '@src/plugins/plugins.module';
import { NotificationsModule } from '@src/notifications';
import { NotificationOperationsModule } from '@src/notification-operations';

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
        ScreenshotModule,
        SubscriptionsModule,
        NotificationsModule,
        NotificationOperationsModule,
        PluginsModule,
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
        DirectoryAdvancedPromptsService,
        DirectoryTaxonomyService,
        RepositoryManagementService,
        GeneratorFormSchemaService,
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
        DirectoryAdvancedPromptsService,
        DirectoryTaxonomyService,
        RepositoryManagementService,
        GeneratorFormSchemaService,
    ],
})
export class DirectoryModule {}
