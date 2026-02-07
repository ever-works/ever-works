import { Injectable, Logger } from '@nestjs/common';
import { PluginBootstrapService } from '@packages/agent/plugins';
import { TriggerInternalApiClient } from '../trigger-internal-api.client';
import { RemotePluginRepository } from './remote-plugin.repository';
import { RemoteUserPluginRepository } from './remote-user-plugin.repository';
import { RemoteDirectoryPluginRepository } from './remote-directory-plugin.repository';

/**
 * Orchestrates plugin system initialization for Trigger.dev tasks.
 *
 * Two-step process called once per task:
 * 1. Load plugins from filesystem via PluginBootstrapService.bootstrap()
 * 2. Fetch settings from API and hydrate remote repositories
 */
@Injectable()
export class TriggerPluginHydratorService {
    private readonly logger = new Logger(TriggerPluginHydratorService.name);

    constructor(
        private readonly pluginBootstrap: PluginBootstrapService,
        private readonly apiClient: TriggerInternalApiClient,
        private readonly pluginRepo: RemotePluginRepository,
        private readonly userPluginRepo: RemoteUserPluginRepository,
        private readonly directoryPluginRepo: RemoteDirectoryPluginRepository,
    ) {}

    /**
     * Initialize the plugin system for a task run.
     *
     * @param directoryId - The directory being generated
     * @param userId - The user who owns the directory
     */
    async initialize(directoryId: string, userId: string): Promise<void> {
        // Step 1: Bootstrap plugins from filesystem
        // force: true because the static `initialized` flag persists across
        // NestJS context recreations in the same Trigger.dev process
        this.logger.log('Bootstrapping plugins from filesystem...');
        const bootstrapResult = await this.pluginBootstrap.bootstrap({ force: true });
        this.logger.log(
            `Plugins loaded: ${bootstrapResult.loaded} loaded, ${bootstrapResult.failed} failed, ${bootstrapResult.systemEnabled} system-enabled`,
        );

        // Step 2: Fetch settings from API
        this.logger.log('Fetching plugin context from API...');
        const snapshot = await this.apiClient.fetchPluginContext(directoryId, userId);
        const pluginCount = Object.keys(snapshot.plugins).length;

        // Step 3: Hydrate remote repositories with the snapshot data
        this.pluginRepo.hydrate(snapshot.plugins);
        this.userPluginRepo.hydrate(userId, snapshot.plugins);
        this.directoryPluginRepo.hydrate(directoryId, snapshot.plugins);

        this.logger.log(`Plugin context hydrated: ${pluginCount} plugins`);
    }
}
