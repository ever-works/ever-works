import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DatabaseConfigurations, DatabaseInitService } from '@ever-works/agent/database';
import { DirectoryModule } from '@ever-works/agent/services';
import { DatabaseModule } from '@ever-works/agent/database';
import { DataGeneratorModule } from '@ever-works/agent/generators';
import { ItemsGeneratorModule } from '@ever-works/agent/items-generator';
import { MarkdownGeneratorModule } from '@ever-works/agent/generators';
import { WebsiteGeneratorModule } from '@ever-works/agent/generators';
import { FacadesModule } from '@ever-works/agent/facades';
import {
    PluginsModule as AgentPluginsModule,
    PluginBootstrapService,
} from '@ever-works/agent/plugins';
import { ConfigModule } from './config/config.module';

// Commands
import { ConfigCommands } from './commands/config';
import { DirectoryCommands } from './commands/directory';
import { ServeCommands } from './commands/serve';
import { CacheFactory } from '@ever-works/agent/cache';

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
