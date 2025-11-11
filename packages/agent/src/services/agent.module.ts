import { Module } from '@nestjs/common';
import { DataGeneratorModule } from '../data-generator/data-generator.module';
import { ItemsGeneratorModule } from '../items-generator/items-generator.module';
import { GitModule } from '../git/git.module';
import { MarkdownGeneratorModule } from '../markdown-generator/markdown-generator.module';
import { WebsiteGeneratorModule } from '../website-generator/website-generator.module';
import { DeployModule } from '../deploy/deploy.module';
import { DatabaseModule } from '../database/database.module';
import { AiModule } from '../ai/ai.module';
import { DirectoryDetailService } from './directory-detail.service';
import { TriggerModule } from '@src/trigger';
import { DirectoryOwnershipService } from './directory-ownership.service';
import { DirectoryQueryService } from './directory-query.service';
import { DirectoryLifecycleService } from './directory-lifecycle.service';
import { DirectoryGenerationService } from './directory-generation.service';

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
        TriggerModule,
    ],
    providers: [
        DirectoryOwnershipService,
        DirectoryQueryService,
        DirectoryLifecycleService,
        DirectoryGenerationService,
        DirectoryDetailService,
    ],
    exports: [
        DirectoryOwnershipService,
        DirectoryQueryService,
        DirectoryLifecycleService,
        DirectoryGenerationService,
        DirectoryDetailService,
    ],
})
export class AgentModule {}
