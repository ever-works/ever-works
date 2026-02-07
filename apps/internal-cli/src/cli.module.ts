import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DatabaseConfigurations, DatabaseInitService } from '@packages/agent/database';
import { DirectoryModule } from '@packages/agent/services';
import { DatabaseModule } from '@packages/agent/database';
import { DataGeneratorModule } from '@packages/agent/generators';
import { ItemsGeneratorModule } from '@packages/agent/items-generator';
import { MarkdownGeneratorModule } from '@packages/agent/generators';
import { WebsiteGeneratorModule } from '@packages/agent/generators';
import { FacadesModule } from '@packages/agent/facades';
import {
    PluginsModule as AgentPluginsModule,
    PluginBootstrapService,
} from '@packages/agent/plugins';
import { ConfigModule } from './config/config.module';

// Commands
import { ConfigCommands } from './commands/config';
import { DirectoryCommands } from './commands/directory';
import { ServeCommands } from './commands/serve';
import { CacheFactory } from '@packages/agent/cache';

@Module({
    imports: [
        CacheFactory.TypeORM({
            isGlobal: true,
        }),
        DatabaseConfigurations.cli(),
        EventEmitterModule.forRoot(),
        AgentPluginsModule.forRoot(),
        ConfigModule,
        DatabaseModule,
        DataGeneratorModule,
        ItemsGeneratorModule,
        MarkdownGeneratorModule,
        WebsiteGeneratorModule,
        FacadesModule,
        DirectoryModule,
    ],
    providers: [
        DatabaseInitService,
        // Commands
        ...ConfigCommands,
        ...DirectoryCommands,
        ...ServeCommands,
    ],
})
export class CLIModule implements OnApplicationBootstrap {
    constructor(private readonly pluginBootstrap: PluginBootstrapService) {}

    async onApplicationBootstrap(): Promise<void> {
        await this.pluginBootstrap.bootstrap();
    }
}
