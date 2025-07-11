import { Module } from '@nestjs/common';
import { DatabaseConfigurations, AiModule } from '@packages/agent';
import { ConfigModule } from './config/config.module';

// Commands
import { ConfigCommands } from './commands/config';
import { DirectoryCommands } from './commands/directory';

@Module({
    imports: [DatabaseConfigurations.cli(), ConfigModule, AiModule],
    providers: [
        // Commands
        ...ConfigCommands,
        ...DirectoryCommands,
    ],
})
export class CLIModule {}
