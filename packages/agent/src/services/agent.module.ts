import { Module } from '@nestjs/common';
import { DataGeneratorModule } from '../data-generator/data-generator.module';
import { ItemsGeneratorModule } from '../items-generator/items-generator.module';
import { GitModule } from '../git/git.module';
import { MarkdownGeneratorModule } from '../markdown-generator/markdown-generator.module';
import { WebsiteGeneratorModule } from '../website-generator/website-generator.module';
import { DeployModule } from '../deploy/deploy.module';
import { DatabaseModule } from '../database/database.module';
import { AiModule } from '../ai/ai.module';
import { AgentService } from './agent.service';
import { DirectoryDetailService } from './directory-detail.service';
import { TriggerModule } from '@src/trigger';

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
    providers: [AgentService, DirectoryDetailService],
    exports: [AgentService, DirectoryDetailService],
})
export class AgentModule {}
