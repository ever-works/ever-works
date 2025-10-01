import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DatabaseConfigurations, DatabaseInitService } from '@packages/agent/database';
import { AiModule } from '@packages/agent/ai';
import { AgentModule } from '@packages/agent/services';
import { GitModule } from '@packages/agent/git';
import { DatabaseModule } from '@packages/agent/database';
import { DataGeneratorModule } from '@packages/agent/data-generator';
import { ItemsGeneratorModule } from '@packages/agent/items-generator';
import { MarkdownGeneratorModule } from '@packages/agent/markdown-generator';
import { WebsiteGeneratorModule } from '@packages/agent/website-generator';
import { DeployModule } from '@packages/agent/deploy';
import { ConfigModule } from './config/config.module';

// Commands
import { ConfigCommands } from './commands/config';
import { DirectoryCommands } from './commands/directory';
import { ServeCommands } from './commands/serve';

@Module({
    imports: [
        DatabaseConfigurations.cli(),
        EventEmitterModule.forRoot(),
        ConfigModule,
        AiModule,
        DatabaseModule,
        DataGeneratorModule,
        ItemsGeneratorModule,
        GitModule,
        MarkdownGeneratorModule,
        WebsiteGeneratorModule,
        DeployModule,
        AgentModule,
    ],
    providers: [
        DatabaseInitService,
        // Commands
        ...ConfigCommands,
        ...DirectoryCommands,
        ...ServeCommands,
    ],
})
export class CLIModule {}
