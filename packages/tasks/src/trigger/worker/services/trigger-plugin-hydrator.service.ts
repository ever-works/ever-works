import { Injectable, Logger } from '@nestjs/common';
import { PluginBootstrapService } from '@ever-works/agent/plugins';

/** Initializes the plugin system for Trigger.dev tasks. */
@Injectable()
export class TriggerPluginHydratorService {
    private readonly logger = new Logger(TriggerPluginHydratorService.name);

    constructor(private readonly pluginBootstrap: PluginBootstrapService) {}

    async initialize(): Promise<void> {
        this.logger.log('Bootstrapping plugins from filesystem...');
        const bootstrapResult = await this.pluginBootstrap.bootstrap({ force: true });
        this.logger.log(
            `Plugins loaded: ${bootstrapResult.loaded} loaded, ${bootstrapResult.failed} failed`,
        );
    }
}
