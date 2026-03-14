import { Module } from '@nestjs/common';
import { SimEventListenerService } from './sim-event-listener.service';

/**
 * SIM AI integration module.
 *
 * Registers the event listener that bridges Ever Works directory events
 * to SIM AI workflows. The listener checks per-directory plugin settings
 * to decide whether to trigger a workflow.
 *
 * Dependencies (DirectoryPluginRepository, PluginSettingsService) are
 * provided globally by AgentPluginsModule, so no explicit imports are needed.
 */
@Module({
	providers: [SimEventListenerService],
	exports: [SimEventListenerService]
})
export class SimModule {}
