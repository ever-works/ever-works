import { Injectable, Logger } from '@nestjs/common';
import { configure } from '@trigger.dev/sdk';
import { config } from '@packages/agent/config';
import { DirectoryGenerationPayload, DirectoryGenerationDispatcher } from '@packages/agent/tasks';
import { directoryGenerationTask } from '../tasks/trigger/directory-generation.task';

@Injectable()
export class TriggerService implements DirectoryGenerationDispatcher {
    private readonly logger = new Logger(TriggerService.name);
    private configured = false;

    private supportedMachines = [
        'medium-1x',
        'micro',
        'small-1x',
        'small-2x',
        'medium-2x',
        'large-1x',
        'large-2x',
    ];

    private ensureConfigured(): boolean {
        if (!config.trigger.shouldUseTrigger()) {
            return false;
        }

        if (this.configured) {
            return true;
        }

        const accessToken = config.trigger.getSecretKey();
        const baseURL = config.trigger.getApiUrl();

        if (!accessToken) {
            this.logger.warn('TRIGGER_SECRET_KEY is not configured');
            return false;
        }

        configure({ accessToken, baseURL });
        this.configured = true;
        return true;
    }

    private machine() {
        if (this.supportedMachines.includes(config.trigger.getMachine())) {
            return config.trigger.getMachine();
        }

        return undefined;
    }

    async dispatchDirectoryGeneration(payload: DirectoryGenerationPayload): Promise<boolean> {
        if (!this.ensureConfigured()) {
            return false;
        }

        try {
            await directoryGenerationTask.trigger(payload, {
                tags: ['directory-generation', payload.mode, payload.directoryId],
                machine: this.machine() as any,
            });

            return true;
        } catch (error) {
            this.logger.error('Failed to dispatch directory-generation task', error as Error);
            return false;
        }
    }
}
