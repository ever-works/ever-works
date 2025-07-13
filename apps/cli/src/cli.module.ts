import { Module } from '@nestjs/common';
import {
    DatabaseConfigurations,
    AiModule,
    AgentHTTPModule,
    GitModule,
    DatabaseModule,
    DataGeneratorModule,
    ItemsGeneratorModule,
    MarkdownGeneratorModule,
    WebsiteGeneratorModule,
    DeployModule,
} from '@packages/agent';
import { ConfigModule } from './config/config.module';

// Commands
import { ConfigCommands } from './commands/config';
import { DirectoryCommands } from './commands/directory';

@Module({
    imports: [
        DatabaseConfigurations.cli(),
        ConfigModule,
        AiModule,
        DatabaseModule,
        DataGeneratorModule,
        ItemsGeneratorModule,
        GitModule,
        MarkdownGeneratorModule,
        WebsiteGeneratorModule,
        DeployModule,
        AgentHTTPModule,
    ],
    providers: [
        // Commands
        ...ConfigCommands,
        ...DirectoryCommands,
    ],
})
export class CLIModule {}
