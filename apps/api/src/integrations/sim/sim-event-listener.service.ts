import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DirectoryGenerationCompletedEvent } from '@ever-works/agent/events';
import { DirectoryPluginRepository, PluginSettingsService } from '@ever-works/agent/plugins';

/**
 * Listens for Ever Works directory events and triggers configured
 * SIM AI workflows in response (fire-and-forget).
 *
 * This is the API-side counterpart to the SIM AI plugin's event trigger
 * settings. When a user configures `eventTriggers.onGenerationCompleted`
 * in their SIM plugin settings, this service picks up the
 * `directory.generation.completed` event and calls the specified
 * SIM workflow with the directory context.
 */
@Injectable()
export class SimEventListenerService {
    private readonly logger = new Logger(SimEventListenerService.name);

    constructor(
        private readonly directoryPluginRepository: DirectoryPluginRepository,
        private readonly pluginSettingsService: PluginSettingsService,
    ) {}

    /**
     * Triggered after any pipeline finishes generating items for a directory.
     * Checks whether the SIM plugin is enabled for this directory and has an
     * `onGenerationCompleted` event trigger configured, then fires the
     * specified SIM workflow asynchronously.
     */
    @OnEvent(DirectoryGenerationCompletedEvent.EVENT_NAME)
    async handleGenerationCompleted(event: DirectoryGenerationCompletedEvent): Promise<void> {
        const directory = event.directory;

        try {
            const dirPlugin = await this.directoryPluginRepository.findByDirectoryAndPlugin(
                directory.id,
                'sim-ai',
            );

            if (!dirPlugin?.enabled) {
                return;
            }

            // Resolve settings with secrets so we have the API key
            const resolved = await this.pluginSettingsService.getResolvedSettings('sim-ai', {
                directoryId: directory.id,
                includeSecrets: true,
            });

            const settings = this.flattenResolvedSettings(resolved);
            const triggerConfig = settings.eventTriggers as
                | Record<string, { workflowId?: string; enabled?: boolean }>
                | undefined;

            const onCompleted = triggerConfig?.onGenerationCompleted;
            if (!onCompleted?.enabled || !onCompleted?.workflowId) {
                return;
            }

            const apiKey = settings.apiKey as string;
            if (!apiKey) {
                this.logger.warn(
                    `SIM event trigger skipped for directory ${directory.id}: no API key configured`,
                );
                return;
            }

            const baseUrl = (settings.baseUrl as string) || 'https://www.sim.ai';

            this.logger.log(
                `Triggering SIM workflow "${onCompleted.workflowId}" ` +
                    `for directory "${directory.id}" (event: generation-completed)`,
            );

            // Dynamic import to avoid hard dependency on the SDK at module load time.
            // The simstudio-ts-sdk package is a dependency of the sim-ai plugin, not
            // of the API app itself. This lazy import keeps the integration lightweight.
            const { SimStudioClient } = await import('simstudio-ts-sdk');
            const client = new SimStudioClient({ apiKey, baseUrl });

            // Fire-and-forget: trigger the workflow asynchronously
            await client.executeWorkflow(
                onCompleted.workflowId,
                {
                    event: 'directory:generation-completed',
                    directoryId: directory.id,
                    directoryName: directory.name,
                    directorySlug: directory.slug,
                    timestamp: new Date().toISOString(),
                },
                { async: true },
            );

            this.logger.log(
                `SIM workflow "${onCompleted.workflowId}" triggered successfully ` +
                    `for directory "${directory.id}"`,
            );
        } catch (error) {
            // Event triggers should never crash the main flow — log and swallow
            this.logger.error(
                `Failed to trigger SIM workflow for directory "${directory.id}": ${error.message}`,
                error.stack,
            );
        }
    }

    /**
     * Flatten a ResolvedSettings map into a plain key→value object.
     * ResolvedSettings stores each key as `{ value, source, scope }`;
     * we only need the values here.
     */
    private flattenResolvedSettings(resolved: Record<string, unknown>): Record<string, unknown> {
        const flat: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(resolved)) {
            if (entry && typeof entry === 'object' && 'value' in entry) {
                flat[key] = (entry as { value: unknown }).value;
            } else {
                flat[key] = entry;
            }
        }
        return flat;
    }
}
